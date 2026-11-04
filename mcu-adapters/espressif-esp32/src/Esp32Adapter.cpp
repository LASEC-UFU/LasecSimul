/* Adaptador nativo de MCU para ESP32 (QEMU), via plugin DLL/SO (mcu_abi.h).
 *
 * Esta versao sobe um degrau em relacao ao GPIO puro anterior: espelha tambem o IOMUX do ESP32 e
 * o roteamento principal da GPIO matrix (UART0/1/2, I2C0/1, HSPI/VSPI). O objetivo aqui e'
 * alinhar a topologia MMIO e o roteamento de sinais com o SimulIDE real sem reintroduzir nada
 * built-in no Core: tudo continua encapsulado no plugin ABI.
 *
 * Referencias auditadas localmente:
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32.cpp
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32gpio.cpp
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32iomux.cpp
 */
#include "lasecsimul/mcu_abi.h"
#include <algorithm>
#include <array>
#include <bitset>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <intrin.h>
#else
#include <dlfcn.h>
#endif

namespace {

bool analogTraceEnabled() {
    /* Bug real de desempenho encontrado 2026-07-19 perfilando o Core ao vivo: esta função é chamada
     * em TODA leitura/escrita de GPIO/ADC (centenas de milhares de vezes por segundo numa simulação
     * MCU-driven), e `std::getenv` no CRT do Windows varre o bloco de ambiente inteiro a cada
     * chamada -- dominava o topo do profile (`strchr` dentro de `gpioIsOutputEnabled`/
     * `gpioOutputLevel` em ~95% das amostras). A flag é só um toggle de trace pra debug, não precisa
     * refletir mudanças em tempo real -- lida uma vez e cacheada. */
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_TRACE_ANALOG");
        return value != nullptr && value[0] != '\0' && std::strcmp(value, "0") != 0;
    }();
    return enabled;
}

/** Achado 2026-07-22 (LED de 500ms via millis() levando ~4s reais mesmo com a simulação "a 100%"):
 * `-icount shift=N` credita `2^N` ns de tempo VIRTUAL a cada instrução Xtensa retirada -- sem
 * relação obrigatória com quanto tempo REAL essa instrução levou. `4` (16ns/instrução, ~62.5 MIPS
 * assumidos) é um palpite fixo nunca calibrado contra o host real. `QemuIcountCalibrator`
 * (core/src/mcu/qemu/) mede a taxa real de ns-por-instrução deste host UMA VEZ (com cache) e seta
 * esta env var ANTES do primeiro launch real (ver McuController::start()). Ausente/inválida ->
 * mantém o `4` histórico (nunca lança, nunca trava um launch por causa de calibração ausente).
 *
 * Achado real 2026-07-22 (usuário reporta calibração medindo certo mas o launch real usando `4`
 * mesmo assim): ISSO usava o mesmo padrão de cache estático de `analogTraceEnabled()` acima --
 * mas, ao contrário daquele (chamado centenas de milhares de vezes/segundo, cache genuinamente
 * necessário), `buildLaunchArgs` roda só uma vez por lançamento -- e o PRÓPRIO
 * `QemuIcountCalibrator` chama `adapter.buildLaunchArgs("")` pra montar os argumentos da sonda de
 * calibração, ANTES de terminar de medir e setar a env var. Com cache estático, essa PRIMEIRA
 * chamada (da sonda, sempre antes da calibração terminar) travava o valor em `4` pro resto do
 * processo -- o launch real nunca via o shift calibrado, mesmo a calibração tendo medido e
 * gravado certo. Sem justificativa de desempenho real aqui (diferente do trace acima), a leitura
 * volta a ser simples, sem cache. */
std::string processEnvironmentValue(const char* name) {
#if defined(_WIN32)
    // adapter.dll uses the static MSVC runtime (/MT) so std::getenv() sees the
    // environment snapshot from DLL load time, not _putenv_s() changes made by
    // the Extension host afterwards.  Query the process environment directly.
    const DWORD required = GetEnvironmentVariableA(name, nullptr, 0);
    if (required == 0) return {};
    std::vector<char> buffer(required);
    const DWORD copied = GetEnvironmentVariableA(name, buffer.data(), required);
    return copied > 0 && copied < required
               ? std::string(buffer.data(), copied)
               : std::string{};
#else
    const char* value = std::getenv(name);
    return value ? std::string(value) : std::string{};
#endif
}

int configuredIcountShift() {
    const std::string value = processEnvironmentValue("LASECSIMUL_ESP32_ICOUNT_SHIFT");
    if (value.empty()) return 4;
    char* end = nullptr;
    const long parsed = std::strtol(value.c_str(), &end, 10);
    if (end == value.c_str() || *end != '\0' || parsed < 0 || parsed > 10) return 4;
    return static_cast<int>(parsed);
}

constexpr uint64_t kUart0Start = 0x3FF40000;
constexpr uint64_t kUart0End = 0x3FF40FFF;
constexpr uint64_t kGpioStart = 0x3FF44000;
constexpr uint64_t kGpioEnd = 0x3FF44FFF;
constexpr uint64_t kIoMuxStart = 0x3FF49000;
constexpr uint64_t kIoMuxEnd = 0x3FF49FFF;
constexpr uint64_t kAdcStart = 0x3FF48800;
constexpr uint64_t kAdcEnd = 0x3FF48BFF;
constexpr uint64_t kUart1Start = 0x3FF50000;
constexpr uint64_t kUart1End = 0x3FF50FFF;
constexpr uint64_t kLedcStart = 0x3FF59000;
constexpr uint64_t kLedcEnd = 0x3FF59193;
constexpr uint64_t kRmtStart = 0x3FF56000;
constexpr uint64_t kRmtEnd = 0x3FF56FFF;
constexpr uint64_t kPcntStart = 0x3FF57000;
constexpr uint64_t kPcntEnd = 0x3FF572FF; // registradores reais ate' 0xFF e os canais privados (0x200..)
constexpr uint64_t kI2c0Start = 0x3FF53000;
constexpr uint64_t kI2c0End = 0x3FF53FFF;
constexpr uint64_t kSpi0Start = 0x3FF64000; // HSPI in the SimulIDE mapping
constexpr uint64_t kSpi0End = 0x3FF64FFF;
constexpr uint64_t kSpi1Start = 0x3FF65000; // VSPI in the SimulIDE mapping
constexpr uint64_t kSpi1End = 0x3FF65FFF;
constexpr uint64_t kI2c1Start = 0x3FF67000;
constexpr uint64_t kI2c1End = 0x3FF67FFF;
constexpr uint64_t kUart2Start = 0x3FF6E000;
constexpr uint64_t kUart2End = 0x3FF6EFFF;

constexpr uint32_t kUartRxLine = 0;
constexpr uint32_t kUartTxLine = 1;
constexpr uint32_t kI2cSclLine = 0;
constexpr uint32_t kI2cSdaLine = 1;
constexpr uint32_t kSpiClkLine = 0;
constexpr uint32_t kSpiMisoLine = 1;
constexpr uint32_t kSpiMosiLine = 2;
constexpr uint32_t kSpiCs0Line = 3;
constexpr uint64_t kDefaultUartBitPeriodNs = 8'680; // 115200 baud, rounded to ns
// Espaco de indices de get_pin_map (ver buildPinMap): GPIO0..39, UART0_RX, UART0_TX, RST.
constexpr uint32_t kPinMapCount = 43;
constexpr uint32_t kPinMapUart0Tx = 41;
constexpr uint64_t kEsp32ApbClockHz = 80'000'000;

/* esp32_i2c_updt_frequency() (fork QEMU, hw/i2c/esp32_i2c.c) ja' espelha o periodo de bit REAL,
 * calculado do clock configurado de verdade (LOW_PERIOD/HIGH_PERIOD reg + APB freq), via
 * writeReg(A_I2C_LOW_PERIOD, period_ns) -- ver i2cWriteRegisterAt. Este valor e' só o palpite
 * (400kHz fast-mode, comum em Wire.setClock() de bibliotecas de display) usado ANTES dessa
 * primeira configuracao real chegar, mesmo papel de kSpiDefaultBitPeriodPs abaixo pro SPI. */
constexpr uint64_t kI2cDefaultHalfPeriodNs = 1'250;

/* SPI_CLOCK_REG (offset 0x18, ver esp32_spi.c::write_clk_reg) E' espelhado na arena
 * (writeReg(iomem.addr+0x18, period_ps)) -- ao contrario do I2C, o Core aprende o periodo de
 * bit REAL configurado pelo firmware assim que a primeira escrita chega; este valor e' só o
 * palpite usado ANTES dessa primeira escrita (ou se o firmware nunca configurar o clock por algum
 * motivo). */
constexpr uint64_t kSpiDefaultBitPeriodPs = 1'000'000;

enum class SignalKind {
    None,
    RawGpio,
    UartRx,
    UartTx,
    I2cScl,
    I2cSda,
    SpiClk,
    SpiMiso,
    SpiMosi,
    SpiCs0,
    Ledc,
    Rmt,
    PcntInput, // indice = unidade * 4 + entrada (0/1 sinal do canal 0/1, 2/3 controle do canal 0/1)
    McpwmOut,  // indice = unidade * 6 + operador * 2 + gerador (A 0, B 1)
    McpwmIn,   // indice = unidade * 9 + entrada (SYNC0-2, F0-2, CAP0-2)
    TwaiTx,
    TwaiRx,
    TwaiBusOff, // TWAI_BUS_OFF_ON: alto com o no' no barramento, baixo em bus off (bus_off_on do OpenCores)
    RmtIn,      // RMT_SIG_IN0..7 (o receptor do canal)
};

struct SignalDesc {
    SignalKind kind = SignalKind::None;
    uint32_t index = 0;
};

enum class UartRxPhase : uint8_t {
    Idle,
    Start,
    Data,
    Parity,
    Stop,
};

/* Motor mestre de bit-bang I2C (ver i2cAdvance/i2cKick) -- cada fase e' UMA borda eletrica real de
 * SCL/SDA, avancada uma de cada vez por onWakeup, mesmo padrao de UartRxPhase acima.
 *
 * START e repeated-START sao ELETRICAMENTE IDENTICOS no I2C real (SDA cai enquanto SCL esta' alto)
 * -- a unica diferenca e' o estado do barramento ANTES: no primeiro START o barramento esta' ocioso
 * (as duas linhas ja' flutuam altas via pull-up); num repeated-START o mestre acabou de terminar um
 * byte com SCL baixo e precisa primeiro LIBERAR/subir SDA, so' entao subir SCL, pra' recriar a
 * mesma condicao "as duas altas" antes de derrubar SDA de novo. RestartRelease/RestartClockHigh
 * cobrem esse preparo; StartFall/StartSettle sao a borda em si + o retorno a SCL baixo, iguais nos
 * dois casos -- entao um UNICO opcode Restart (ver I2cOpKind) cobre ambos, sem nenhum caso especial
 * pro "primeiro" START: e' exatamente assim que o proprio ESP-IDF programa cmd_reg[0] (sempre
 * I2C_OPCODE_RSTART, mesmo na primeira transacao). */
enum class I2cPhase : uint8_t {
    Idle,
    RestartRelease,   // solta/sobe SDA com SCL baixo -- 1o passo de start/repeated-start
    RestartDataHigh,  // SCL ja baixo; agora sobe SDA sem ambiguidade de ordem no solver
    RestartClockHigh, // SCL sobe com SDA alta -- barramento "ocioso" recriado, pronto pra' cair SDA
    StartFall,        // SDA cai com SCL alto -- START/repeated-START completo -- proximo desce SCL
    StartSettle,      // SCL desce -- pronto pro primeiro bit do proximo Write
    WriteBitSetup,    // (write) SCL baixo, SDA segura o bit -- proximo sobe SCL (escravo amostra)
    WriteBitHold,     // (write) SCL alto -- proximo desce SCL e avanca pro bit seguinte/ACK
    WriteBitChange,   // SCL ja baixo; muda/libera SDA para o bit seguinte/ACK
    ReadBitSetup,     // (read) SCL baixo, SDA liberado (escravo dirige) -- proximo sobe SCL e amostra
    ReadBitHold,      // (read) SCL alto -- proximo desce SCL e avanca pro bit seguinte/ACK do mestre
    WriteAckSetup,    // SCL baixo, SDA liberado -- escravo confirma um byte que o MESTRE enviou
    WriteAckHold,     // SCL alto -- amostra o ACK do escravo em sdaInput -- proximo desce SCL
    WriteAckRelease,  // SCL ja baixo; mestre retoma SDA sem criar falso STOP
    ReadAckSetup,      // SCL baixo, mestre dirige ACK(0)/NACK(liberado) do byte que ELE recebeu
    ReadAckHold,       // SCL alto -- ACK/NACK do mestre visivel no barramento -- proximo desce SCL
    ReadAckDrive,      // SCL ja baixo; mestre passa a dirigir ACK/NACK
    ReadAckRelease,    // SCL ja baixo; mestre libera/retoma SDA depois do ACK
    StopSetup,        // SCL baixo, SDA baixo -- proximo sobe SCL antes do STOP
    StopRise,         // SCL alto, SDA baixo -- proximo sobe SDA (STOP completo)
};

/* Uma operacao pendente do motor mestre, na ORDEM EXATA em que esp32_i2c.c (fork QEMU) mirrorou
 * cada opcode processado pelo seu proprio motor de FIFO/comando -- ver i2cWriteRegisterAt. Cobre
 * QUALQUER sequencia real de opcodes (write puro, read puro, write+repeated-start+read, multiplos
 * repeated-starts, etc) sem nenhuma suposicao sobre "primeiro byte e' sempre endereco" ou sobre uso
 * especifico de biblioteca/dispositivo -- so' replica, bit a bit, o que o firmware pediu. */
enum class I2cOpKind : uint8_t { Restart, Write, Read, Stop };
struct I2cOp {
    I2cOpKind kind;
    uint8_t byte = 0;   // Write: byte a enviar (MSB primeiro).
    bool nack = false;  // Read: ACK_VAL do comando -- true = mestre deve mandar NACK neste byte
                        // (ultimo byte de uma leitura), false = ACK (mais bytes vem a seguir).
    // Transacao comandada pelo Core (ver kI2cCoreOpOffset): registra o resultado desta operacao e,
    // numa escrita, aborta o resto da transacao com STOP se o escravo nao der ACK -- como o
    // controlador real faz com ACK_CHECK_EN.
    bool record = false;
    bool abortOnNack = false;
};

/* Motor mestre de bit-bang SPI (ver spiAdvance/spiKick) -- MODE0 (CPOL=0/CPHA=0, o mais comum em
 * bibliotecas de display tipo Adafruit_SPITFT): SCLK ocioso em baixo, MOSI e' preparado com SCLK
 * baixo e amostrado pelo escravo na borda de subida. */
enum class SpiPhase : uint8_t {
    Idle,
    Edges,     // as 2n bordas de SCK do pedaco em curso, na ordem do modo (CPOL/CPHA)
    // Byte sem bordas (mcu_abi.h 3.3): no instante da 8a borda de subida o byte vai para a fila de
    // entrega; no fim do 8o periodo o byte termina, como no caminho bit a bit.
    SilentLastEdge,
    SilentEnd,
};

/** Byte que o SPI transmitiu sem bordas, com o par de pinos por onde saiu (ver drain_spi_byte). */
struct SpiTapByte {
    uint8_t byte = 0;
    uint32_t clockPin = 0;
    uint32_t dataPin = 0;
};

struct SpiBytePairPins {
    uint32_t clock = 0;
    uint32_t data = 0;
    uint32_t miso = UINT32_MAX;
};

/** Tamanho máximo dos buffers de MONITOR (`UsartState::txMonitor`/`rxMonitor`) -- bem maior que o
 * FIFO real de hardware (128, `txFifo`/`rxFifo` abaixo) de propósito: o FIFO real é drenado pelo
 * firmware em microssegundos, o monitor só é drenado pela Extension a cada poll (hoje 500ms, ver
 * `mcuCommands.ts::openSerialMonitor`) -- precisa aguentar rajadas de log inteiras entre dois polls
 * sem estourar. */
constexpr size_t kUsartMonitorCap = 8192;

/* O quadro da UART como o ESP32 o monta (UART_CONF0 e UART_RS485_CONF): start, BIT_NUM + 5 bits de dado,
 * paridade par ou impar (PARITY_EN/PARITY), e o stop -- 1, 1,5 ou 2 bits (STOP_BIT_NUM 1/2/3), mais um bit a
 * cada DL0_EN/DL1_EN (o ESP-IDF faz os 2 stop bits com STOP_BIT_NUM 1 e DL1_EN, pela errata do chip). O stop
 * e' um intervalo so': bit * (bits de DL) + bit * meios-bits / 2, a mesma conta do QEMU (hw/char/esp32_uart.c).
 * TXD_INV/RXD_INV invertem a linha. Na recepcao, um erro de paridade, de quadro (o primeiro stop em baixo) e
 * o break (tudo em zero com o stop em baixo) vao com o byte, que fica no FIFO como no chip. */
constexpr uint16_t kUartRxParityErr = 1u << 8, kUartRxFrameErr = 1u << 9, kUartRxBreak = 1u << 10;

/* O modo ADC do I2S0 (hw/misc/esp32_i2s.c do QEMU): a tensao dos pads da tabela de padroes do controlador
 * digital do SAR ADC, cada amostra no seu instante t0 + ceil(k * num / den) ns -- os mesmos instantes das
 * entradas do I2S no QEMU, que aplica a funcao de transferencia. O Core as devolve pelo C2A (ver
 * adcReadRegister, 0x3D0). */
struct I2sAdcSampler {
    bool on = false;
    uint64_t t0 = 0, num = 1, den = 1;
    uint32_t len = 1, unit = 0;
    std::array<uint8_t, 16> pads{};
    uint64_t next = 0;
    uint64_t dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    std::deque<uint16_t> out;           // decimos de mV, ainda nao entregues
    uint64_t stagedT0 = 0, stagedNum = 1, stagedPads = 0;
};

struct UsartState {
    bool rxLevel = true;  // nivel logico (depois de RXD_INV)
    bool txLevel = true;  // nivel no pino (depois de TXD_INV): em repouso, alto
    std::deque<uint16_t> rxFifo; // byte | erros (kUartRx*)
    std::deque<uint8_t> txFifo;
    bool txActive = false;
    uint16_t txFrame = 0x03FF;
    uint8_t txBitIndex = 0;
    uint8_t txTotalBits = 9; // start + dado + paridade: os bits antes do stop
    uint64_t txStopNs = kDefaultUartBitPeriodNs; // o stop deste quadro, no formato do inicio dele (como o QEMU)
    UartRxPhase rxPhase = UartRxPhase::Idle;
    uint8_t rxBitIndex = 0;
    uint8_t rxShift = 0;
    uint8_t rxOnes = 0;
    uint16_t rxErrors = 0;
    uint8_t dataBits = 8;
    bool parityEn = false;
    bool parityOdd = false;
    uint8_t stopHalfBits = 2;
    uint8_t dlBits = 0;
    bool txInv = false;
    bool rxInv = false;
    // O break (CONF0 TXD_BRK): com a FIFO vazia, TX_BRK_NUM (IDLE_CONF, reset 10) bits em 0 -- o QEMU levanta o
    // TX_BRK_DONE no mesmo instante (hw/char/esp32_uart.c, uart_start_break).
    bool txBreakArmed = false;
    bool txBreaking = false;
    uint8_t txBreakBits = 10;
    uint64_t bitPeriodNs = kDefaultUartBitPeriodNs;
    // O divisor (20.4 em ponto fixo, o de reset do QEMU) e TICK_REF_ALWAYS_ON (CONF0 bit 27): numa troca do
    // APB o bit volta a ser 1e9 / ((APB << 4) / divisor), a mesma conta inteira do QEMU (uart_baud).
    uint32_t clkdivRaw = 11104;
    bool useApb = true;
    // Ver usartTxTransitionsUnobserved(): recalculado a cada entrada do modulo (escrita no FIFO ou
    // wakeup) e aplicado so' quando um frame comeca, nunca no meio dele.
    bool txSilentFramesAllowed = false;
    bool txFrameSilent = false;
    uint64_t txDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    // Monitor fora da banda (ver `drainMonitorByte`/`kUsartMonitorCap` acima) -- byte-exato, tocado
    // só quando um frame COMPLETA (TX) ou é ACEITO com stop bit válido (RX), nunca bit a bit.
    // Independente de `txFifo`/`rxFifo`: sobrevive ao dreno do hardware, existe só pra "Abrir
    // monitor serial" ler passivamente sem afetar o firmware.
    std::deque<uint8_t> txMonitor;
    std::deque<uint8_t> rxMonitor;
    // Consumidor independente para um receptor UART ligado diretamente ao pino dedicado TX.
    // Nunca compartilhar com txMonitor: LasecPlot e "Abrir monitor serial" podem ficar abertos
    // simultaneamente sem um drenar os bytes do outro.
    std::deque<uint8_t> txWireTap;
    uint32_t txMonitorDropped = 0;
    uint32_t rxMonitorDropped = 0;
    uint32_t txWireTapDropped = 0;
};

void pushMonitorByte(std::deque<uint8_t>& monitor, uint32_t& dropped, uint8_t byte) {
    if (monitor.size() >= kUsartMonitorCap) {
        monitor.pop_front();
        ++dropped;
    }
    monitor.push_back(byte);
}

/* O I2C em modo escravo (CTR.MS_MODE 0; ESP32 TRM, I2C slave): o motor ve SCL e SDA nos pads, reconhece
 * START/STOP (SDA mudando com SCL em alto), recebe o endereco e os bytes nas subidas de SCL e dirige SDA (ACK,
 * bits de dado) depois de cada descida, passado o SDA_HOLD; o ESP32 original nao estica o clock. Cada coisa
 * que o firmware ve vai ao QEMU (hw/i2c/esp32_i2c.c, esp32_i2c_vnext_slave): [7:0] byte, [11:8] tipo
 * (I2cSlaveEvent), bit 12 R/W do endereco, [15:13] o ultimo estado da maquina principal no STOP. */
enum class I2cSlavePhase : uint8_t { Idle, Address, Receive, Transmit, Ignore };
enum : uint32_t { kI2cSlaveRx = 1, kI2cSlaveAddressed = 2, kI2cSlaveStop = 3, kI2cSlaveTxTaken = 4 };

struct I2cState {
    bool sclInput = true;
    bool sdaInput = true;
    bool sclOutputLevel = true;
    bool sdaOutputLevel = true;
    bool sclOutputEnabled = false;
    bool sdaOutputEnabled = false;

    /* Motor mestre de bit-bang genérico (ver i2cWriteRegisterAt/i2cKick/i2cAdvance) -- alimentado
     * pelos writeReg() que esp32_i2c.c (fork QEMU, hw/i2c/esp32_i2c.c) ja' espelha na arena pra
     * CADA opcode (RSTART/WRITE/READ/STOP) que seu proprio motor de FIFO/comando/interrupcao
     * (rodando de verdade dentro do QEMU, com FIFO/registradores/IRQ corretos do ponto de vista do
     * firmware) processa -- nao ha necessidade nenhuma de duplicar esse motor aqui. Este lado so'
     * converte cada opcode espelhado numa sequencia eletrica REAL de START/repeated-START/8bits+
     * ACK/STOP em SCL/SDA, pro dispositivo I2C de verdade no barramento perceber -- generico pra'
     * qualquer sequencia real de comandos que o firmware programar, sem suposicao nenhuma sobre
     * biblioteca ou dispositivo especifico (achado original 2026-07-25: Wire.write() "funcionava"
     * do ponto de vista do proprio QEMU, mas nenhum bit real saia pro barramento -- as escritas
     * de registrador do QEMU eram descartadas em silencio; write/read continuavam stubs vazios).
     * `lastAck`/`lastReadByte` sao o canal de retorno pro QEMU: `i2cReadRegister()` devolve o ACK
     * real (bit0 de A_I2C_STATUS) e o byte recebido (A_I2C_CMD) pra' esp32_i2c_event() completar
     * o WRITE/READ com dado REAL, nao mais um resultado sempre-sucesso fixo. */
    std::deque<I2cOp> pendingOps;
    I2cPhase phase = I2cPhase::Idle;
    uint8_t bitIndex = 0;
    uint8_t shiftByte = 0;
    bool pendingNack = false;    // ACK_VAL da leitura em andamento (ver I2cOp::nack)
    bool lastAck = false;        // ultimo ACK observado (write) ou enviado (read) -- ver A_I2C_STATUS
    uint8_t lastReadByte = 0;    // ultimo byte recebido eletricamente -- ver A_I2C_CMD (readRegister)
    /* Periodo de 1 bit (metade do ciclo SCL) em ns. Aprendido do PROPRIO fork QEMU: cada escrita
     * real de LOW_PERIOD/HIGH_PERIOD (esp32_i2c_updt_frequency) ja' espelha o periodo de bit
     * COMPLETO calculado do clock configurado de verdade via writeReg(A_I2C_LOW_PERIOD, period_ns)
     * -- ver i2cWriteRegisterAt. So' usa um palpite de 400kHz (comum em Wire.setClock() de
     * bibliotecas de display) antes da primeira configuracao real chegar; qualquer firmware que
     * configure o clock (todo mundo, mais cedo ou mais tarde) substitui isto pelo valor real. */
    uint64_t halfPeriodNs = kI2cDefaultHalfPeriodNs;
    uint64_t sclCycles = 0;       // LOW_PERIOD + 1 + HIGH_PERIOD + 7: o periodo de SCL em ciclos de APB_CLK
    uint64_t apbHz = 40'000'000;
    uint64_t dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    // Operacao em curso (a que i2cKick tirou da fila) e o log de resultados das operacoes com
    // `record`, lido pelo Core via kI2cCoreResultOffset: [7:0] byte lido, bit 8 ACK, [10:9] tipo.
    I2cOp currentOp{I2cOpKind::Stop};
    std::deque<uint32_t> coreResults;

    // Escravo (ver I2cSlavePhase)
    bool slaveMode = true; // CTR.MS_MODE 0 no reset: o I2C sai do reset como escravo
    uint16_t slaveAddr = 0;
    uint64_t sdaHoldNs = 0;
    I2cSlavePhase sPhase = I2cSlavePhase::Idle;
    uint8_t sClocks = 0;      // subidas de SCL neste byte (9 com o ACK)
    uint8_t sShift = 0;
    uint8_t sTxByte = 0xFF;
    bool sRead = false;       // o mestre le (R/W do endereco)
    bool sAddressed = false;  // o endereco desta transacao era o nosso (o STOP vai ao firmware)
    bool sMasterAck = true;
    uint8_t sLastState = 0;   // I2C_STATUS.SCL_MAIN_STATE_LAST: 2 ACK do endereco, 5 ACK dado, 6 espera ACK
    bool sSdaLow = false;     // o nivel que SDA toma em sSdaDueNs
    uint64_t sSdaDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    std::deque<uint8_t> sTx;  // a TX FIFO do escravo, como o firmware a encheu
    std::deque<uint32_t> sEvents;
};

struct SpiState {
    bool clkInput = false;
    bool misoInput = false;
    bool mosiInput = false;
    bool cs0Input = true;
    bool clkOutputLevel = false;
    bool misoOutputLevel = false;
    bool mosiOutputLevel = false;
    bool cs0OutputLevel = true;
    bool clkOutputEnabled = false;
    bool misoOutputEnabled = false;
    bool mosiOutputEnabled = false;
    // CS0 comeca HABILITADO (true), idle em nivel ALTO (cs0OutputLevel=true acima) -- mesmo reset
    // real do periferico (esp32_spi_reset() no fork QEMU: pin_reg=0x6, so' CS1_DIS/CS2_DIS
    // ligados, CS0 fica de fora = habilitado; ativo-baixo e' o default/convencao universal de CS,
    // entao ocioso=alto). Ver spiUpdateCs0/SpiState::pinReg/csAsserted abaixo.
    bool cs0OutputEnabled = true;

    /* Motor mestre de bit-bang (ver spiWriteRegisterAt/spiKick/spiAdvance) -- mesma logica do I2C
     * acima, alimentado pelos writeReg(iomem.addr+0x80=A_SPI_W0, byte) que esp32_spi.c ja espelha
     * um byte de cada vez (pausado pelo timer INTERNO do proprio QEMU, ver esp32_spi_event) pra
     * toda transacao HSPI/VSPI (numero>=2 -- SPI0/SPI1, dedicados a flash/PSRAM onboard, processam
     * 100% dentro do QEMU via ssi_transfer interno e NUNCA chegam aqui). */
    // Cada entrada e' o valor espelhado: [7:0] o byte do MOSI, bit 8 (kSpiRxCaptureBit) = amostrar o
    // MISO deste byte, [31:16] a posicao dele no buffer de recepcao do QEMU.
    // Desde o patch 0022 cada valor e' um pedaco de 1 a 8 bits de uma fase da transacao: [7:0] os bits
    // do MOSI (o primeiro no bit 7), bit 8 amostrar o MISO, [11:9] 8 - bits, bit 13 sem clock (dummy com
    // USR_DUMMY_IDLE), bit 14 CPHA, [31:16] a posicao do byte recebido.
    std::deque<uint32_t> pendingBytes;
    SpiPhase phase = SpiPhase::Idle;
    uint8_t edge = 0;      // bordas ja' feitas do pedaco em curso (1..2n)
    uint8_t chunkBits = 8;
    bool cpha = false;
    bool noClock = false;
    uint8_t shiftByte = 0;
    // Recepcao: o mestre amostra o MISO na borda de captura do modo e, no fim do pedaco, o deixa em
    // rxBytes (mesmo formato, bits alinhados a esquerda, bit 8 = valido) para o Core levar ao W0..W15 ou
    // ao DMA do QEMU (kSpiRxOffset).
    bool captureRx = false;
    uint16_t rxIndex = 0;
    uint8_t rxShift = 0;
    std::deque<uint32_t> rxBytes;
    uint64_t bitPeriodPs = kSpiDefaultBitPeriodPs;
    uint64_t byteStartNs = 0; // inicio do byte em curso: toda borda dele e' medida daqui (spiEdgeDueNs)
    uint64_t dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;

    /* CS0 de hardware (ver spiUpdateCs0/spiWriteRegisterAt) -- automatico, espelhado por
     * esp32_spi.c: `pinReg` reflete SPI_PIN_REG real (CS0_DIS bit0, CS0_POL bit13) sempre que o
     * firmware escreve; `csAsserted` reflete o inicio/fim REAL de cada transacao USR (mirrored
     * via A_SPI_CMD no inicio de esp32_spi_do_command e no fim de esp32_spi_event) -- nao uma
     * suposicao de "enquanto ha bytes na fila", pra' bracket exato ao redor de QUALQUER comando,
     * sem depender de nenhuma biblioteca especifica. */
    uint32_t pinReg = 0x6; // mesmo default real de esp32_spi_reset(): CS1_DIS|CS2_DIS, CS0 habilitado
    bool csAsserted = false;

    // Byte em transmissao sem bordas: o par por onde sai, e os bytes que o Core ainda vai entregar.
    uint32_t silentClockPin = 0;
    uint32_t silentDataPin = 0;
    std::deque<SpiTapByte> tap;
};

/* LED PWM (ESP32 TRM, LED_PWM chapter), modelado como o hardware: cada timer tem um contador que
 * conta 0..2^res-1 no clock escolhido (REF_TICK, APB_CLK ou -- nos timers de baixa velocidade --
 * SLOW_CLK = APB_CLK/RC_FAST conforme LEDC_CONF.APB_CLK_SEL) desde o ultimo reset; cada canal fica
 * alto de HPOINT ate HPOINT+DUTY dentro de cada periodo do seu timer. DUTY tem 4 bits fracionarios,
 * distribuidos como um tick extra em `frac` de cada 16 periodos. Duty/HPOINT novos so valem a
 * partir do proximo estouro do contador apos DUTY_START, e SIG_OUT_EN=0 forca o nivel IDLE_LV.
 * Fade (CONF1): a partir desse estouro o duty anda DUTY_SCALE (parte inteira) a cada DUTY_CYCLE
 * periodos, DUTY_NUM vezes, subindo com DUTY_INC -- uma atualizacao comum e' um fade de 1 passo de
 * escala 0. O QEMU faz a mesma conta para DUTY_R e para a interrupcao DUTY_CHNG_END. */
struct LedcTimer {
    uint32_t config = 0;          // ultimo TIMERn_CONF efetivo (para LS: depois do PARA_UP)
    long double tickNs = 0;       // duracao de um tick do contador
    uint32_t resolution = 0;      // bits do contador (0 = parado/nao configurado)
    uint64_t epochNs = 0;         // instante em que o contador saiu do reset (contagem 0)
    bool paused = false;
    uint64_t pausedAtNs = 0;
};
struct LedcChannel {
    uint32_t conf0 = 0;           // TIMER_SEL[1:0], SIG_OUT_EN bit2, IDLE_LV bit3
    uint32_t hpointReg = 0, dutyReg = 0;     // valores escritos (alvo)
    uint32_t hpoint = 0, duty = 0;           // valores em vigor (duty com 4 bits fracionarios)
    bool updatePending = false;
    uint64_t updateAfterPeriod = 0;          // indice do periodo em que DUTY_START foi pedido
    // Atualizacao em curso desde o estouro seguinte ao DUTY_START (ver ledcEvaluateChannel).
    bool fadeActive = false;
    uint32_t fadeStartDuty = 0;              // DUTY no instante do DUTY_START
    uint32_t fadeConf1 = 0;                  // CONF1 do DUTY_START (INC, NUM, CYCLE, SCALE)
};
struct LedcState {
    uint64_t apbHz = 40'000'000;             // APB_CLK agora (ver apbApplyFields)
    uint32_t confReg = 0;                    // LEDC_CONF_REG (APB_CLK_SEL bit0)
    std::array<LedcTimer, 8> timers{};       // 0-3 HSTIMER, 4-7 LSTIMER
    std::array<LedcChannel, 16> channels{};  // 0-7 HSCH, 8-15 LSCH
    std::array<bool, 16> outputLevel{};
    std::array<uint64_t, 16> nextEdgeNs{};   // 0 = sem borda agendada
};

/* RMT (transmissor): o QEMU (esp32_rmt.c) le cada item da RAM do canal quando ele comeca e o espelha
 * aqui com os dois niveis e a duracao da primeira metade em ps; este motor poe as duas bordas no pino
 * (RMT_SIG_OUTn pela GPIO matrix) e, com portadora, a modula no nivel CARRIER_OUT_LV. */
struct RmtChannel {
    bool level = false;          // nivel no pino agora
    bool segmentLevel = false;   // nivel que o item pede no segmento atual
    uint64_t segmentStartNs = 0;
    uint64_t secondDueNs = LSDN_QEMU_MODULE_NO_WAKEUP; // segunda metade do item atual
    bool secondLevel = false;
    bool carrierEnabled = false;
    bool carrierLevel = true;    // CARRIER_OUT_LV: o nivel do item que recebe a portadora
    uint64_t carrierHighPs = 0;
    uint64_t carrierLowPs = 0;
    uint64_t carrierNextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t carrierEdges = 0;   // bordas da portadora desde o inicio do segmento
};
/* O receptor do RMT (ESP32 TRM, RMT RX): a partir da primeira borda, mede cada nivel em ticks do canal e o
 * grava em meio item {duracao[14:0], nivel[15]}; pulsos mais curtos que RX_FILTER_THRES ciclos de APB nao
 * contam; sem borda por IDLE_THRES ticks a recepcao acaba com um meio item de duracao 0 (o fim) e RX_END. Os
 * itens e o fim vao ao QEMU (hw/ssi/esp32_rmt.c, esp32_rmt_vnext_rx), que os grava na RAM do canal; o fim e'
 * um despertar rigido (o guest ve RX_END no instante dele). */
struct RmtRx {
    bool enabled = false;
    bool filterEn = false;
    uint32_t filterThres = 0;     // ciclos de APB_CLK
    uint32_t idleTicks = 0;
    uint64_t tickPs = 1'000'000;
    bool raw = false;             // nivel no pad
    bool level = false;           // nivel que passou pelo filtro
    bool recording = false;
    uint64_t levelStartNs = 0;
    uint64_t pendingEdgeNs = 0;   // a borda que o filtro ainda confirma
    uint64_t confirmDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t idleDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    bool halfPending = false;
    uint16_t half = 0;
};

struct RmtState {
    uint64_t apbHz = 40'000'000;  // o filtro do receptor conta ciclos de APB_CLK
    std::array<RmtRx, 8> rx{};
    std::deque<uint64_t> rxEvents; // [31:0] item, [34:32] canal, bit 36 fim, para o Core levar ao QEMU
    std::array<RmtChannel, 8> channels{};
};

/* PCNT (ESP32 TRM, Pulse Count Controller): o contador mora aqui, que ve cada borda de pad no seu
 * instante. Cada unidade tem dois canais, cada um com um sinal (as bordas contam) e um controle (o nivel
 * muda o sentido ou segura). O filtro so' aceita um nivel que ficou estavel FILTER_THRES ciclos de APB.
 * O QEMU (hw/misc/esp32_pcnt.c) le o contador pelo snapshot e recebe os eventos pelo C2A. */
struct PcntInput {
    bool raw = false;       // nivel no pad agora
    bool level = false;     // nivel depois do filtro
    uint64_t commitDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
};
struct PcntUnit {
    uint32_t conf0 = 0x00003c10; // reset: filtro de 16 ciclos, eventos zero/H_LIM/L_LIM ligados
    uint32_t conf1 = 0;          // CNT_THRES0 [15:0], CNT_THRES1 [31:16]
    uint32_t conf2 = 0;          // CNT_H_LIM [15:0], CNT_L_LIM [31:16]
    int32_t count = 0;
    uint32_t status = 0;         // eventos travados (bits 2..6, como PCNT_Un_STATUS)
    std::array<PcntInput, 4> inputs{}; // sinal do canal 0, sinal do canal 1, controle 0, controle 1
};
struct PcntState {
    uint64_t apbHz = 40'000'000; // o filtro conta ciclos de APB_CLK
    std::array<PcntUnit, 8> units{};
    uint32_t ctrl = 0x5555;      // PCNT_CTRL: reset (bit 2n) e pausa (bit 2n+1) de cada unidade
    uint32_t intEna = 0;
    std::deque<uint32_t> events; // (unidade << 16) | STATUS, para o Core levar ao QEMU
};

/* MCPWM (ESP32 TRM, Motor Control PWM), duas unidades: tres timers, tres operadores (comparadores A/B,
 * geradores PWMxA/PWMxB, dead time, tratamento de falha) e a captura. O QEMU (hw/misc/esp32_mcpwm.c)
 * espelha todo registrador escrito; as formas de onda saem daqui, borda a borda, e os eventos com
 * interrupcao habilitada voltam ao QEMU pelo C2A. O chopper (CARRIER_CFG) nao e' modelado. */
struct McpwmTimer {
    uint32_t cfg0 = 0x0000FF00;  // PRESCALE [7:0], PERIOD (sombra) [23:8], PERIOD_UPMETHOD [25:24]
    uint32_t cfg1 = 0;           // START [2:0], MOD [4:3]
    uint32_t sync = 0;           // SYNCI_EN 0, SYNC_SW 1, SYNCO_SEL [3:2], PHASE [19:4], PHASE_DIRECTION 20
    uint32_t period = 255;       // periodo ativo
    bool running = false;
    uint32_t stopAt = 0;         // 0 segue, 1 para no proximo TEZ, 2 no proximo TEP
    uint64_t tickPs = 6250;
    uint64_t epochNs = 0;        // instante do tick 0 desta contagem
    uint64_t epochPhase = 0;     // fase (mcpwmPhaseOf) nesse instante
    uint64_t ticks = 0;          // ticks ja' processados desde a epoch
    uint64_t nextTicks = 0;
    uint64_t nextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
};
struct McpwmOperator {
    uint32_t stmpCfg = 0;        // GEN_A/B_UPMETHOD
    std::array<uint32_t, 2> cmpShadow{}, cmpActive{};
    uint32_t genCfg0 = 0;        // CFG_UPMETHOD [3:0], T0_SEL [6:4], T1_SEL [9:7]
    uint32_t genForce = 0x20;
    uint32_t lastForce = 0x20;   // para detectar o toggle de NCIFORCE
    std::array<uint32_t, 2> actionShadow{}, actionActive{};
    uint32_t dtCfg = 0x18000;    // reset: as duas saidas em bypass
    uint32_t dtFed = 0, dtRed = 0;             // atrasos ativos (DT_FED/DT_RED em ciclos do clock do dead time)
    uint32_t dtFedShadow = 0, dtRedShadow = 0;
    uint32_t fhCfg0 = 0, fhCfg1 = 0, lastFhCfg1 = 0;
    std::array<bool, 2> gen{};   // saidas dos geradores
    bool redLevel = false, fedLevel = false;
    uint64_t redDueNs = LSDN_QEMU_MODULE_NO_WAKEUP, fedDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    bool ostOn = false, cbcOn = false;
    std::array<bool, 2> out{};   // nos pinos (PWMxA, PWMxB)
};
struct McpwmUnit {
    uint64_t apbHz = 40'000'000; // o timer de captura conta APB_CLK
    uint32_t clkCfg = 0, synciCfg = 0, opTimerSel = 0, faultDetect = 0;
    uint32_t capTimerCfg = 0, capTimerPhase = 0;
    std::array<uint32_t, 3> capChnCfg{};
    uint32_t updateCfg = 0x55, intEna = 0;
    std::array<McpwmTimer, 3> timers{};
    std::array<McpwmOperator, 3> ops{};
    std::array<bool, 9> inputs{};        // SYNC0-2, F0-2, CAP0-2 como roteados pela GPIO matrix
    uint64_t capEpochNs = 0;             // a captura conta APB_CLK desde aqui
    uint32_t capEpochValue = 0;
    std::array<uint32_t, 3> capEdges{};  // bordas desde a ultima captura (prescale)
    uint32_t capStatus = 0;
    std::array<uint32_t, 3> timerStatus{}; // trava de TIMERn_STATUS (kMcpwmLatchOffset)
    std::deque<std::pair<uint32_t, uint32_t>> events; // (offset do registrador, valor) para o QEMU
};

/* TWAI (CAN 2.0B, registradores do SJA1000 PeliCAN): o controlador do protocolo inteiro roda aqui, bit a
 * bit nos pinos TWAI_TX/TWAI_RX (ver a secao TWAI mais abaixo). O QEMU (hw/misc/esp32_twai.c) guarda os
 * registradores, a FIFO de RX e o IR; le SR/TEC/REC pelo snapshot e recebe os eventos pelo C2A. */
enum class TwaiPhase : uint8_t {
    Reset,         // MOD.RM = 1: fora do barramento
    Integrating,   // esperando o barramento livre (11 recessivos; em bus off, 128 vezes)
    Idle,
    Frame,         // SOF..EOF, transmitindo ou recebendo
    ErrorFlag,
    ErrorWait,     // depois do flag: recessivo, esperando o barramento voltar a recessivo
    ErrorDelim,
    OverloadFlag,
    OverloadWait,
    OverloadDelim,
    Intermission,
    Suspend,       // error passive que transmitiu: 8 bits antes de transmitir de novo
};
struct TwaiEngine {
    uint64_t apbHz = 40'000'000; // TQ = 2 (BRP + 1) / APB_CLK
    // Registradores que o QEMU espelha aqui
    uint8_t mode = 0x01, ier = 0, btr0 = 0, btr1 = 0, ewl = 96;
    std::array<uint8_t, 4> acr{}, amr{};
    std::array<uint8_t, 13> txBuf{};
    uint32_t tec = 0, rec = 0;    // 9 bits como no OpenCores: TEC >= 256 e' bus off
    // SR e estados de erro
    bool tbs = true, tcs = true, es = false, eiBusOff = false, busOff = false, passive = false;
    bool waitingBusFree = true, transmitting = false, receiving = false;
    // Pedido de transmissao
    bool needTx = false, selfRx = false, singleShot = false, abortTx = false;
    std::vector<uint8_t> txBits;  // o quadro no fio, SOF..EOF7: nivel (bit 0), stuffing (bit 1), arbitragem (bit 2)
    uint32_t txPos = 0;
    bool txRole = false;          // transmissor do quadro em curso
    bool lastWasTx = false;       // transmitiu o ultimo quadro (o suspend do error passive)
    bool ackDrive = false;        // receptor dirigindo o slot de ACK
    // Tempo de bit, em ps
    uint64_t tqPs = 25'000, bitPs = 75'000, samplePs = 50'000;
    uint32_t sjwTq = 1;
    bool triple = false;
    uint64_t bitStartPs = 0, sampleAtPs = 0, bitEndPs = 0;
    bool sampled = true, resynced = false, parked = true, txEdgeThisBit = false;
    // Pinos
    bool txLevel = true, nextTx = true, rxLevel = true, lastSampled = true;
    bool ext = true;              // o que o barramento mostrou da ultima vez que este no' estava recessivo
    std::array<uint64_t, 2> rxChangePs{}; // as duas ultimas mudancas do RX (amostragem tripla)
    std::array<bool, 2> rxBefore{true, true};
    uint8_t rxFollow = 0;         // o RX segue o proprio TX? 0 nao se sabe ainda, 1 sim, 2 nao (desligado)
    // Fases
    TwaiPhase phase = TwaiPhase::Reset;
    uint32_t count = 0, same = 0, dominantRun = 0, overloads = 0;
    bool sameLevel = true, flagPassive = false, flagByTx = false, firstAfterFlag = false, ackErrExc = false;
    uint32_t busFreeCount = 0;
    bool busFreeEnabled = false;
    // Decodificador: todo no' decodifica o barramento, o transmissor tambem
    uint32_t n = 0, run = 0, id = 0, dlc = 0, dataLen = 0, crcStart = 0, tail = 0;
    bool runLevel = false, stuffed = true, b12 = false, ide = false, rtr = false, crcErr = false;
    std::array<uint8_t, 8> data{};
    uint16_t crc = 0, crcRx = 0;
    // Saida dos eventos (nula na previsao) e o que o ultimo passo levantou
    std::deque<std::pair<uint32_t, uint32_t>>* events = nullptr;
    uint32_t raised = 0;
};
struct TwaiPlanPoint {
    uint64_t atPs = 0;
    bool hard = false;
};
struct TwaiState {
    TwaiEngine e;
    std::deque<std::pair<uint32_t, uint32_t>> events; // (offset do registrador, valor) para o QEMU
    std::vector<TwaiPlanPoint> plan;  // proximos instantes com algo a fazer, em ordem
    size_t planPos = 0;
    bool replan = true;
};

/* Sensor de toque (ESP32 TRM, Touch Sensor): o QEMU (hw/misc/esp32_sens.c) roda a maquina de medicao e
 * conta os ciclos de carga e descarga pela capacitancia de cada pad; aqui se mede a capacitancia que o
 * circuito pendura no pad. No inicio de cada medicao o pad e' dirigido por ~1 us para longe da tensao em
 * que esta', atraves de 1 MOhm (uma fonte limitada, como a do chip); os capacitores do circuito integram isso
 * no transitorio e C = -dt / (R ln((B - Vt) / (A - Vt))), com A e B as tensoes nas pontas do intervalo. Sem
 * capacitancia externa o pad chega a Vt na hora e C = 0; uma carga resistiva forte segura o pad (C enorme,
 * contagem 0, como no chip).
 *
 * O Core resolve cada passo com as fontes que valem depois dos eventos do seu fim, e o modulo so' ve a
 * tensao num stamp, que amostra a solucao anterior. Entao: o pedido (T0) arma uma fonte desprezivel (1 POhm)
 * so' para haver uma solucao em T0; em T0 + 1 ns a fonte liga e o stamp que isso causa amostra A (a tensao em
 * T0); em T1 = T0 + 1 ns + 1 us um R mudado em 1e-9 forca a solucao em T1, ainda ligada; em T1 + 1 ns a fonte
 * desliga e o stamp amostra B (a tensao em T1). A fonte fica ligada em todo (T0, T1], tenha o Core quantas
 * solucoes tiver no meio. */
struct TouchChannel {
    double target = 0.0;
    double a = 0.0;
    bool hasA = false;
    uint16_t capTenthsPf = 0; // capacitancia externa da ultima medicao, 0,1 pF
};
struct TouchState {
    enum class Stage : uint8_t { Idle, Armed, On, Forced, Off } stage = Stage::Idle;
    std::array<TouchChannel, 10> channels{}; // canais do SENS (8 = GPIO32, 9 = GPIO33: invertidos no chip)
    uint32_t mask = 0;
    uint32_t pending = 0;                    // canais ainda sem a amostra da etapa
    uint32_t seq = 0;                        // numero do pedido em curso (do QEMU)
    uint32_t doneSeq = 0;                    // do ultimo pedido com todos os canais medidos
    uint64_t t0 = 0, stageNs = 0;            // o pedido e o inicio da etapa atual
    uint64_t dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
};

/* Fonte analogica num pad (mcu_abi.h 3.5): a medicao de toque, o DAC. */
struct AnalogDrive {
    bool active = false;
    double volts = 0.0;
    double ohms = 0.0;
};

struct Esp32SharedState {
    // QEMU RTC light-sleep handshake (0x3FF48FF4): APB/REF_TICK and digital peripheral clocks stop;
    // RTC8M can remain powered for low-speed LEDC when bit 1 is set.
    bool digitalClockGated = false;
    bool rtc8mKeptInSleep = false;
    uint64_t sleepStartedNs = 0;
    uint32_t gpioOut = 0;
    uint32_t gpioEnable = 0;
    // GPIO_OUT1_REG / GPIO_ENABLE1_REG: bit n = GPIO(32+n). Only GPIO32/33 can drive (34..39 are
    // input-only pads), but the registers hold all eight bits like the real chip.
    uint32_t gpioOut1 = 0;
    uint32_t gpioEnable1 = 0;
    std::array<bool, 40> gpioInputs{};
    // gpioInputs[pin] already routed to the input signals (routePinInputAt); false after a reset, so
    // the first sample always reaches signals whose idle level is not 0 (UART RX idles high).
    std::array<bool, 40> gpioInputRouted{};
    std::array<double, 40> gpioVoltages{};
    std::array<uint32_t, 40> gpioPinRegs{};
    std::array<uint16_t, 40> ioMuxRegs{};
    std::array<SignalDesc, 40 * 6> ioMuxFuncs{};
    std::array<uint32_t, 256> matrixInRegs{};
    std::array<uint32_t, 40> matrixOutRegs{};
    std::array<UsartState, 3> usarts{};
    std::array<I2cState, 2> i2cs{};
    std::array<SpiState, 2> spis{};
    LedcState ledc{};
    RmtState rmt{};
    PcntState pcnt{};
    std::array<McpwmUnit, 2> mcpwm{};
    TwaiState twai{};
    TouchState touch{};
    std::array<AnalogDrive, 40> analogDrive{};
    // APB_CLK que o QEMU informa a cada troca do clock (0x3FF48FF8; reset no XTAL, 40 MHz): o LEDC, o filtro do
    // PCNT, a captura do MCPWM, o TWAI, a UART e o I2C contam nele. Antes era 80 MHz fixo.
    uint64_t apbHz = 40'000'000;
    // Registradores do RTC_IO como o firmware deixou (os pads: MUX_SEL e pulls; ver kRtcPads).
    std::array<uint32_t, 0x100 / 4> rtcIoRegs{};
    // DAC no modo do I2S (SENS DAC_DIG_FORCE): as amostras que o QEMU leu na DMA, cada uma no seu instante
    // (ns | DAC1 [7:0], DAC2 [15:8], canais [17:16]), e o codigo que cada DAC tem agora (ver dacUpdate).
    bool dacDigital = false;
    std::deque<std::pair<uint64_t, uint32_t>> dacSamples;
    std::array<uint8_t, 2> dacDigitalCode{};
    uint32_t dacCwCtrl1 = 0; // SENS_SAR_DAC_CTRL1: SW_FSTEP[15:0], SW_TONE_EN[16]
    uint32_t dacCwCtrl2 = 0x03000000; // SENS_SAR_DAC_CTRL2: CW_EN, INV, SCALE and DC per channel
    uint64_t dacCwEpochNs = 0;
    uint16_t dacCwPhaseBase = 0;
    uint64_t dacCwNextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    I2sAdcSampler i2sAdc{};
    uint32_t dportPeripRstEn = 0; // DPORT_PERIP_RST_EN (ver kDportModuleVTable)
    // mcu_abi.h 3.1 (set_pin_transitions_observed): por indice de get_pin_map. Fica fora de toda
    // rotina de reset de periferico -- descreve o circuito ao redor do chip, nao o chip. Default
    // "observado" em todos, que mantem o caminho bit-a-bit ate' o Core provar o contrario.
    std::array<bool, kPinMapCount> pinTransitionsObserved = [] {
        std::array<bool, kPinMapCount> observed{};
        observed.fill(true);
        return observed;
    }();
    // mcu_abi.h 3.3 (set_spi_byte_pairs): pares (clock, dado) de get_pin_map em que o SPI pode
    // transmitir bytes sem bordas. Tambem descreve o circuito, fora dos resets de periferico.
    std::vector<SpiBytePairPins> spiBytePairs;
};

SignalDesc makeRawGpio(uint32_t pin) { return SignalDesc{SignalKind::RawGpio, pin}; }
SignalDesc makeUartRx(uint32_t index) { return SignalDesc{SignalKind::UartRx, index}; }
SignalDesc makeUartTx(uint32_t index) { return SignalDesc{SignalKind::UartTx, index}; }
SignalDesc makeI2cScl(uint32_t index) { return SignalDesc{SignalKind::I2cScl, index}; }
SignalDesc makeI2cSda(uint32_t index) { return SignalDesc{SignalKind::I2cSda, index}; }
SignalDesc makeSpiClk(uint32_t index) { return SignalDesc{SignalKind::SpiClk, index}; }
SignalDesc makeSpiMiso(uint32_t index) { return SignalDesc{SignalKind::SpiMiso, index}; }
SignalDesc makeSpiMosi(uint32_t index) { return SignalDesc{SignalKind::SpiMosi, index}; }
SignalDesc makeSpiCs0(uint32_t index) { return SignalDesc{SignalKind::SpiCs0, index}; }
SignalDesc makeLedc(uint32_t index) { return SignalDesc{SignalKind::Ledc, index}; }
SignalDesc makeRmt(uint32_t index) { return SignalDesc{SignalKind::Rmt, index}; }
SignalDesc makeRmtIn(uint32_t index) { return SignalDesc{SignalKind::RmtIn, index}; }
SignalDesc makePcntInput(uint32_t index) { return SignalDesc{SignalKind::PcntInput, index}; }
SignalDesc makeMcpwmOut(uint32_t index) { return SignalDesc{SignalKind::McpwmOut, index}; }
SignalDesc makeMcpwmIn(uint32_t index) { return SignalDesc{SignalKind::McpwmIn, index}; }
SignalDesc makeTwai(SignalKind kind) { return SignalDesc{kind, 0}; }

uint64_t usartStartAddress(uint32_t index) {
    switch (index) {
        case 0: return kUart0Start;
        case 1: return kUart1Start;
        case 2: return kUart2Start;
        default: return kUart0Start;
    }
}

uint64_t i2cStartAddress(uint32_t index) { return index == 0 ? kI2c0Start : kI2c1Start; }
uint64_t spiStartAddress(uint32_t index) { return index == 0 ? kSpi0Start : kSpi1Start; }

uint64_t addDelayNs(uint64_t nowNs, uint64_t delayNs) {
    if (delayNs > LSDN_QEMU_MODULE_NO_WAKEUP - nowNs) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return nowNs + delayNs;
}

uint64_t delayUntilNs(uint64_t dueNs, uint64_t nowNs) {
    if (dueNs == LSDN_QEMU_MODULE_NO_WAKEUP) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return dueNs <= nowNs ? 0 : dueNs - nowNs;
}

uint64_t nextUsartWakeupDelayNs(const UsartState& usart, uint64_t nowNs) {
    const uint64_t dueNs = usart.txDueNs < usart.rxDueNs ? usart.txDueNs : usart.rxDueNs;
    return delayUntilNs(dueNs, nowNs);
}

void usartSetTxLevel(UsartState& usart, bool logical) {
    usart.txLevel = logical != usart.txInv;
}

uint64_t usartStopNs(const UsartState& usart) {
    return usart.bitPeriodNs * usart.dlBits + usart.bitPeriodNs * usart.stopHalfBits / 2u;
}

void usartStartTx(UsartState& usart, uint64_t nowNs) {
    if (usart.txActive || usart.txFifo.empty()) return;

    const uint8_t data = static_cast<uint8_t>(usart.txFifo.front() & ((1u << usart.dataBits) - 1u));
    usart.txFifo.pop_front();

    // bit 0 = start, [1..dataBits] = dado, depois a paridade (par: o total de uns par).
    usart.txFrame = static_cast<uint16_t>(uint16_t(data) << 1u);
    if (usart.parityEn) {
        const bool odd = (std::bitset<8>(data).count() & 1u) != 0;
        if (odd != usart.parityOdd) usart.txFrame |= static_cast<uint16_t>(1u << (1u + usart.dataBits));
    }
    usart.txTotalBits = static_cast<uint8_t>(1u + usart.dataBits + (usart.parityEn ? 1u : 0u));
    usart.txStopNs = usartStopNs(usart);
    usart.txBitIndex = 0;
    usart.txActive = true;
    usart.txFrameSilent = usart.txSilentFramesAllowed;
    if (usart.txFrameSilent) {
        // Nenhum pino que carrega este TX tem observador de bordas: a linha fica em repouso e o
        // frame inteiro vira um unico prazo, o mesmo instante do caminho bit-a-bit abaixo.
        usartSetTxLevel(usart, true);
        usart.txBitIndex = static_cast<uint8_t>(usart.txTotalBits + 1u);
        usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs * usart.txTotalBits + usart.txStopNs);
        return;
    }
    usartSetTxLevel(usart, false); // start bit
    usart.txBitIndex = 1;
    usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
}

void usartStartBreak(UsartState& usart, uint64_t nowNs) {
    usart.txActive = true;
    usart.txBreaking = true;
    usart.txFrameSilent = false;
    usartSetTxLevel(usart, false);
    usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs * usart.txBreakBits);
}

void usartAdvanceTx(UsartState& usart, uint64_t nowNs) {
    usart.txDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    if (!usart.txActive) {
        usartStartTx(usart, nowNs);
        return;
    }
    if (usart.txBreaking) {
        usart.txBreaking = false;
        usart.txActive = false;
        usartSetTxLevel(usart, true);
        usartStartTx(usart, nowNs);
        return;
    }

    if (usart.txBitIndex < usart.txTotalBits) { // dado e paridade
        usartSetTxLevel(usart, ((usart.txFrame >> usart.txBitIndex) & 1u) != 0);
        ++usart.txBitIndex;
        usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
        return;
    }
    if (usart.txBitIndex == usart.txTotalBits) { // o stop, um intervalo so'
        usartSetTxLevel(usart, true);
        ++usart.txBitIndex;
        usart.txDueNs = addDelayNs(nowNs, usart.txStopNs);
        return;
    }

    // Frame completo -- extrai o byte de volta de `txFrame` (bit 0 = start, bits [1..dataBits] = dado)
    // ANTES de `usartStartTx` reciclar `txFrame` pro próximo byte da fila.
    const uint8_t sentByte = static_cast<uint8_t>((usart.txFrame >> 1) & ((1u << usart.dataBits) - 1u));
    pushMonitorByte(usart.txMonitor, usart.txMonitorDropped, sentByte);
    pushMonitorByte(usart.txWireTap, usart.txWireTapDropped, sentByte);

    usart.txActive = false;
    usart.txFrameSilent = false;
    usartSetTxLevel(usart, true);
    if (usart.txFifo.empty() && usart.txBreakArmed) usartStartBreak(usart, nowNs);
    else usartStartTx(usart, nowNs);
}

void usartStartRx(UsartState& usart, uint64_t nowNs) {
    usart.rxPhase = UartRxPhase::Start;
    usart.rxBitIndex = 0;
    usart.rxShift = 0;
    usart.rxOnes = 0;
    usart.rxErrors = 0;
    usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs / 2u);
}

// `level`: o nivel no pino; a UART ve o logico (RXD_INV).
void usartSetRxLevel(UsartState& usart, bool level, uint64_t nowNs) {
    const bool previousLevel = usart.rxLevel;
    usart.rxLevel = level != usart.rxInv;
    if (previousLevel && !usart.rxLevel && usart.rxPhase == UartRxPhase::Idle) usartStartRx(usart, nowNs);
}

void usartAdvanceRx(UsartState& usart, uint64_t nowNs) {
    usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;

    switch (usart.rxPhase) {
        case UartRxPhase::Start:
            if (usart.rxLevel) {
                usart.rxPhase = UartRxPhase::Idle;
                return;
            }
            usart.rxPhase = UartRxPhase::Data;
            usart.rxBitIndex = 0;
            usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
            return;

        case UartRxPhase::Data:
            if (usart.rxLevel) {
                if (usart.rxBitIndex < 8) usart.rxShift |= static_cast<uint8_t>(1u << usart.rxBitIndex);
                ++usart.rxOnes;
            }
            ++usart.rxBitIndex;
            if (usart.rxBitIndex < usart.dataBits) {
                usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
                return;
            }
            usart.rxPhase = usart.parityEn ? UartRxPhase::Parity : UartRxPhase::Stop;
            usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
            return;

        case UartRxPhase::Parity:
            // Par: o total de uns (dado + paridade) par; impar: impar.
            if (((usart.rxOnes + (usart.rxLevel ? 1u : 0u)) & 1u) != (usart.parityOdd ? 1u : 0u)) usart.rxErrors |= kUartRxParityErr;
            usart.rxPhase = UartRxPhase::Stop;
            usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
            return;

        case UartRxPhase::Stop: {
            // O primeiro stop no meio dele: em baixo, erro de quadro (e break com tudo em zero). O byte vai
            // ao FIFO assim mesmo, como no chip. O monitor independe da capacidade do FIFO de hardware --
            // "Abrir monitor serial" precisa ver todo byte que chegou no pino.
            if (!usart.rxLevel) usart.rxErrors |= usart.rxOnes == 0 ? (kUartRxFrameErr | kUartRxBreak) : kUartRxFrameErr;
            if (usart.rxErrors == 0) pushMonitorByte(usart.rxMonitor, usart.rxMonitorDropped, usart.rxShift);
            if (usart.rxFifo.size() < 128) usart.rxFifo.push_back(static_cast<uint16_t>(usart.rxShift | usart.rxErrors));
            usart.rxPhase = UartRxPhase::Idle;
            usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;
        }

        case UartRxPhase::Idle:
        default:
            usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;
    }
}

void usartAdvanceDueWork(UsartState& usart, uint64_t nowNs) {
    for (uint8_t guard = 0; guard < 4; ++guard) {
        bool advanced = false;
        if (usart.txDueNs != LSDN_QEMU_MODULE_NO_WAKEUP && usart.txDueNs <= nowNs) {
            usartAdvanceTx(usart, nowNs);
            advanced = true;
        }
        if (usart.rxDueNs != LSDN_QEMU_MODULE_NO_WAKEUP && usart.rxDueNs <= nowNs) {
            usartAdvanceRx(usart, nowNs);
            advanced = true;
        }
        if (!advanced) return;
    }
}

void usartWriteConf0(UsartState& usart, uint32_t data, uint64_t nowNs) {
    const uint8_t dataBitsField = static_cast<uint8_t>((data & 0b001100u) >> 2u);
    usart.dataBits = static_cast<uint8_t>(5u + dataBitsField);
    usart.parityEn = (data & 0b10u) != 0;
    usart.parityOdd = (data & 0b01u) != 0;

    // STOP_BIT_NUM: 1 = 1 bit, 2 = 1,5, 3 = 2 (0 nao e' valido; o chip conta 1).
    const uint8_t stopBitsField = static_cast<uint8_t>((data & 0b110000u) >> 4u);
    usart.stopHalfBits = stopBitsField == 3 ? 4 : stopBitsField == 2 ? 3 : 2;

    const bool txInv = (data & (1u << 22u)) != 0;
    if (txInv != usart.txInv) {
        usart.txInv = txInv;
        usart.txLevel = !usart.txLevel; // o mesmo nivel logico, agora invertido no pino
    }
    const bool rxInv = (data & (1u << 19u)) != 0;
    if (rxInv != usart.rxInv) {
        // O pino fica onde esta': o receptor ve o nivel logico virar, e uma descida em repouso e' um start
        // bit, como no chip.
        usart.rxInv = rxInv;
        usartSetRxLevel(usart, !usart.rxLevel != usart.rxInv, nowNs);
    }

    if ((data & (1u << 18u)) != 0) usart.txFifo.clear();
    // TXD_BRK ligado sem nada a enviar: o break comeca ja' (como no QEMU).
    const bool txBreak = (data & (1u << 8u)) != 0;
    if (txBreak && !usart.txBreakArmed && !usart.txActive && usart.txFifo.empty()) usartStartBreak(usart, nowNs);
    usart.txBreakArmed = txBreak;
    if ((data & (1u << 17u)) != 0) {
        usart.rxFifo.clear();
        usart.rxPhase = UartRxPhase::Idle;
        usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    }
}

// Bit 31 nunca é setado por hardware real (UART_CLKDIV_REG só usa bits[23:0]) nem por bit-time em
// ns plausível (cobre até ~2.1s de período de bit, bem acima do pior caso real). Usado como marcador
// explícito em vez de heurística por magnitude -- magnitude sozinha é ambígua: existem bauds não-
// padrão "redondos" (ex: 8000, 10000, 20000) cujo CLKDIV real colide com um valor de bit-time em ns
// também plausível, então qualquer corte por tamanho erra algum desses.
constexpr uint32_t kRawClkDivMarker = 0x80000000u;

void usartWriteClkDiv(UsartState& usart, uint32_t data) {
    if (data == 0) return;

    if ((data & kRawClkDivMarker) == 0) {
        // qemu_simulide (produção) sempre converte o UART_CLKDIV do ESP32 pra bit-time em ns antes
        // de mandar pra SimulIDE -- este é o único caminho que produção usa.
        usart.bitPeriodNs = data;
        return;
    }

    // Pedido explícito (só usado por teste direto, nunca por produção) pra decodificar como
    // registrador real ESP32 UART_CLKDIV_REG: inteiro em bits[19:0], fração (1/16) em bits[23:20].
    const uint32_t raw = data & ~kRawClkDivMarker;
    const uint64_t clkDivFixed = (uint64_t(raw & 0x000FFFFFu) << 4u) | ((raw >> 20u) & 0xFu);
    if (clkDivFixed == 0) return;
    usart.bitPeriodNs = (clkDivFixed * 1'000'000'000ull + ((kEsp32ApbClockHz << 4u) - 1u)) /
                        (kEsp32ApbClockHz << 4u);
}

SignalDesc& ioMuxFunc(Esp32SharedState& state, uint32_t pin, uint32_t funcIndex) {
    return state.ioMuxFuncs[pin * 6u + funcIndex];
}
const SignalDesc& ioMuxFunc(const Esp32SharedState& state, uint32_t pin, uint32_t funcIndex) {
    return state.ioMuxFuncs[pin * 6u + funcIndex];
}

void setIoMuxFuncs(Esp32SharedState& state, uint32_t pin, std::array<SignalDesc, 6> funcs) {
    for (uint32_t i = 0; i < funcs.size(); ++i) ioMuxFunc(state, pin, i) = funcs[i];
}

void configureIoMux(Esp32SharedState& state) {
    for (uint32_t pin = 0; pin < 40; ++pin) {
        setIoMuxFuncs(
            state, pin,
            std::array<SignalDesc, 6>{makeRawGpio(pin), SignalDesc{}, makeRawGpio(pin), SignalDesc{},
                                      SignalDesc{}, SignalDesc{}});
    }

    setIoMuxFuncs(state, 1, std::array<SignalDesc, 6>{makeUartTx(0), SignalDesc{}, makeRawGpio(1),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 3, std::array<SignalDesc, 6>{makeUartRx(0), SignalDesc{}, makeRawGpio(3),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 5, std::array<SignalDesc, 6>{makeRawGpio(5), makeSpiCs0(1), makeRawGpio(5),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 9, std::array<SignalDesc, 6>{SignalDesc{}, SignalDesc{}, makeRawGpio(9),
                                                      SignalDesc{}, makeUartRx(1), SignalDesc{}});
    setIoMuxFuncs(state, 10, std::array<SignalDesc, 6>{SignalDesc{}, SignalDesc{}, makeRawGpio(10),
                                                       SignalDesc{}, makeUartTx(1), SignalDesc{}});
    setIoMuxFuncs(state, 12, std::array<SignalDesc, 6>{makeSpiMiso(0), SignalDesc{}, makeRawGpio(12),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 13, std::array<SignalDesc, 6>{makeSpiMosi(0), SignalDesc{}, makeRawGpio(13),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 14, std::array<SignalDesc, 6>{SignalDesc{}, makeSpiClk(0), makeRawGpio(14),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 15, std::array<SignalDesc, 6>{makeSpiCs0(0), SignalDesc{}, makeRawGpio(15),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 16, std::array<SignalDesc, 6>{makeRawGpio(16), SignalDesc{}, makeRawGpio(16),
                                                       SignalDesc{}, makeUartRx(2), SignalDesc{}});
    setIoMuxFuncs(state, 17, std::array<SignalDesc, 6>{makeRawGpio(17), SignalDesc{}, makeRawGpio(17),
                                                       SignalDesc{}, makeUartTx(2), SignalDesc{}});
    setIoMuxFuncs(state, 18, std::array<SignalDesc, 6>{makeRawGpio(18), makeSpiClk(1), makeRawGpio(18),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 19, std::array<SignalDesc, 6>{makeRawGpio(19), makeSpiMiso(1), makeRawGpio(19),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 23, std::array<SignalDesc, 6>{makeRawGpio(23), makeSpiMosi(1), makeRawGpio(23),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
}

SignalDesc matrixInputSignal(uint32_t func) {
    // PCNT: unidades 0-4 nos sinais 39-58, 5-7 nos 71-82, quatro por unidade (sinal 0, sinal 1,
    // controle 0, controle 1) -- a mesma ordem de PcntUnit::inputs.
    if (func >= 39 && func <= 58) return makePcntInput(func - 39);
    if (func >= 71 && func <= 82) return makePcntInput(20 + (func - 71));
    // MCPWM: PWM0 SYNC0-2/F0-2 em 31-36 e CAP0-2 em 109-111; PWM1 SYNC0-2/F0-2 em 103-108 e CAP0-2 em 112-114.
    if (func >= 31 && func <= 36) return makeMcpwmIn(func - 31);
    if (func >= 109 && func <= 111) return makeMcpwmIn(6 + (func - 109));
    if (func >= 103 && func <= 108) return makeMcpwmIn(9 + (func - 103));
    if (func >= 112 && func <= 114) return makeMcpwmIn(9 + 6 + (func - 112));
    if (func >= 83 && func <= 90) return makeRmtIn(func - 83); // RMT_SIG_IN0..7
    switch (func) {
        case 8: return makeSpiClk(0);
        case 9: return makeSpiMiso(0);
        case 10: return makeSpiMosi(0);
        case 11: return makeSpiCs0(0);
        case 14: return makeUartRx(0);
        case 17: return makeUartRx(1);
        case 29: return makeI2cScl(0);
        case 30: return makeI2cSda(0);
        case 63: return makeSpiClk(1);
        case 64: return makeSpiMiso(1);
        case 65: return makeSpiMosi(1);
        case 68: return makeSpiCs0(1);
        case 94: return makeTwai(SignalKind::TwaiRx);
        case 95: return makeI2cScl(1);
        case 96: return makeI2cSda(1);
        case 198: return makeUartRx(2);
        default: return {};
    }
}

SignalDesc matrixOutputSignal(uint32_t func) {
    if (func >= 71 && func <= 86) return makeLedc(func - 71);
    if (func >= 87 && func <= 94) return makeRmt(func - 87); // RMT_SIG_OUT0..7
    if (func >= 32 && func <= 37) return makeMcpwmOut(func - 32);          // PWM0_OUT0A..2B
    if (func >= 108 && func <= 113) return makeMcpwmOut(6 + (func - 108)); // PWM1_OUT0A..2B
    switch (func) {
        case 8: return makeSpiClk(0);
        case 9: return makeSpiMiso(0);
        case 10: return makeSpiMosi(0);
        case 11: return makeSpiCs0(0);
        case 14: return makeUartTx(0);
        case 17: return makeUartTx(1);
        case 29: return makeI2cScl(0);
        case 30: return makeI2cSda(0);
        case 63: return makeSpiClk(1);
        case 64: return makeSpiMiso(1);
        case 65: return makeSpiMosi(1);
        case 68: return makeSpiCs0(1);
        case 95: return makeI2cScl(1);
        case 96: return makeI2cSda(1);
        case 123: return makeTwai(SignalKind::TwaiTx);
        case 124: return makeTwai(SignalKind::TwaiBusOff);
        case 198: return makeUartTx(2);
        default: return {};
    }
}

// GPIO_ENABLE_REG (GPIO0..31) / GPIO_ENABLE1_REG (GPIO32..39) bit of `pin`.
bool gpioEnableBit(const Esp32SharedState& state, uint32_t pin) {
    if (pin < 32) return (state.gpioEnable & (1u << pin)) != 0;
    return pin < 40 && (state.gpioEnable1 & (1u << (pin - 32u))) != 0;
}

bool signalOutputEnabled(const Esp32SharedState& state, SignalDesc signal) {
    switch (signal.kind) {
        case SignalKind::RawGpio:
            return gpioEnableBit(state, signal.index);
        case SignalKind::UartTx: return signal.index < state.usarts.size();
        case SignalKind::I2cScl: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sclOutputEnabled;
        case SignalKind::I2cSda: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sdaOutputEnabled;
        case SignalKind::SpiClk: return signal.index < state.spis.size() && state.spis[signal.index].clkOutputEnabled;
        case SignalKind::SpiMiso: return signal.index < state.spis.size() && state.spis[signal.index].misoOutputEnabled;
        case SignalKind::SpiMosi: return signal.index < state.spis.size() && state.spis[signal.index].mosiOutputEnabled;
        case SignalKind::SpiCs0: return signal.index < state.spis.size() && state.spis[signal.index].cs0OutputEnabled;
        case SignalKind::Ledc: return signal.index < state.ledc.outputLevel.size();
        case SignalKind::Rmt: return signal.index < state.rmt.channels.size();
        case SignalKind::McpwmOut: return signal.index < 12u;
        case SignalKind::TwaiTx:
        case SignalKind::TwaiBusOff: return true;
        default: return false;
    }
}

bool signalOutputLevel(const Esp32SharedState& state, SignalDesc signal) {
    switch (signal.kind) {
        case SignalKind::RawGpio:
            if (signal.index < 32) return (state.gpioOut & (1u << signal.index)) != 0;
            return signal.index < 40 && (state.gpioOut1 & (1u << (signal.index - 32u))) != 0;
        case SignalKind::UartTx: return signal.index < state.usarts.size() && state.usarts[signal.index].txLevel;
        case SignalKind::I2cScl: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sclOutputLevel;
        case SignalKind::I2cSda: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sdaOutputLevel;
        case SignalKind::SpiClk: return signal.index < state.spis.size() && state.spis[signal.index].clkOutputLevel;
        case SignalKind::SpiMiso: return signal.index < state.spis.size() && state.spis[signal.index].misoOutputLevel;
        case SignalKind::SpiMosi: return signal.index < state.spis.size() && state.spis[signal.index].mosiOutputLevel;
        case SignalKind::SpiCs0: return signal.index < state.spis.size() && state.spis[signal.index].cs0OutputLevel;
        case SignalKind::Ledc: return signal.index < state.ledc.outputLevel.size() && state.ledc.outputLevel[signal.index];
        case SignalKind::Rmt: return signal.index < state.rmt.channels.size() && state.rmt.channels[signal.index].level;
        case SignalKind::McpwmOut:
            return signal.index < 12u && state.mcpwm[signal.index / 6u].ops[(signal.index % 6u) / 2u].out[signal.index % 2u];
        case SignalKind::TwaiTx: return state.twai.e.txLevel;
        case SignalKind::TwaiBusOff: return !state.twai.e.busOff;
        default: return false;
    }
}

void pcntInputAt(PcntState& pcnt, uint32_t index, bool level, uint64_t nowNs);
void mcpwmInputAt(McpwmUnit& unit, uint32_t input, bool level, uint64_t nowNs);
void twaiInputAt(TwaiState& twai, bool level, uint64_t nowNs);

void i2cInputAt(I2cState& i2c, uint32_t index, bool scl, bool level, uint64_t nowNs);
void rmtRxInputAt(RmtState& rmt, uint32_t n, bool level, uint64_t nowNs);

void signalSetInputLevelAt(Esp32SharedState& state, SignalDesc signal, bool level, uint64_t nowNs) {
    // The digital peripheral domain does not sample pads while its clock is gated. Keep the resolved
    // electrical level in gpioInputs; the first post-wake route sample resynchronizes each input.
    if (state.digitalClockGated) return;
    switch (signal.kind) {
        case SignalKind::TwaiRx:
            twaiInputAt(state.twai, level, nowNs);
            break;
        case SignalKind::McpwmIn:
            if (signal.index < 18u) mcpwmInputAt(state.mcpwm[signal.index / 9u], signal.index % 9u, level, nowNs);
            break;
        case SignalKind::PcntInput:
            if (signal.index < 4u * state.pcnt.units.size()) pcntInputAt(state.pcnt, signal.index, level, nowNs);
            break;
        case SignalKind::UartRx:
            if (signal.index < state.usarts.size()) usartSetRxLevel(state.usarts[signal.index], level, nowNs);
            break;
        case SignalKind::I2cScl:
            if (signal.index < state.i2cs.size()) i2cInputAt(state.i2cs[signal.index], signal.index, true, level, nowNs);
            break;
        case SignalKind::I2cSda:
            if (signal.index < state.i2cs.size()) i2cInputAt(state.i2cs[signal.index], signal.index, false, level, nowNs);
            break;
        case SignalKind::SpiClk:
            if (signal.index < state.spis.size()) state.spis[signal.index].clkInput = level;
            break;
        case SignalKind::SpiMiso:
            if (signal.index < state.spis.size()) state.spis[signal.index].misoInput = level;
            break;
        case SignalKind::SpiMosi:
            if (signal.index < state.spis.size()) state.spis[signal.index].mosiInput = level;
            break;
        case SignalKind::SpiCs0:
            if (signal.index < state.spis.size()) state.spis[signal.index].cs0Input = level;
            break;
        case SignalKind::RmtIn:
            if (signal.index < state.rmt.rx.size()) rmtRxInputAt(state.rmt, signal.index, level, nowNs);
            break;
        default: break;
    }
}

uint8_t selectedIoMuxIndex(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= state.ioMuxRegs.size()) return 0;
    return static_cast<uint8_t>((state.ioMuxRegs[pin] >> 12) & 0x7);
}

SignalDesc selectedPinOutputSignal(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= 40) return {};
    const uint8_t muxIndex = selectedIoMuxIndex(state, pin);
    if (muxIndex >= 6) return {};

    const SignalDesc direct = ioMuxFunc(state, pin, muxIndex);
    if (muxIndex == 2) {
        const SignalDesc matrix = matrixOutputSignal(state.matrixOutRegs[pin] & 0xFFu);
        if (matrix.kind != SignalKind::None) return matrix;
    }
    if (direct.kind != SignalKind::None) return direct;
    return muxIndex == 2 ? makeRawGpio(pin) : SignalDesc{};
}

SignalDesc selectedDirectInputSignal(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= 40) return {};
    const uint8_t muxIndex = selectedIoMuxIndex(state, pin);
    if (muxIndex == 2 || muxIndex >= 6) return {};
    return ioMuxFunc(state, pin, muxIndex);
}

// mcu_abi.h 3.1: um frame da USART `index` pode omitir as bordas por bit somente quando TODO pino
// que carrega esse TX agora -- o dedicado (UART0_TX) e cada GPIO cujo IOMUX/GPIO matrix seleciona
// o sinal -- foi declarado sem observador pelo Core. O roteamento pode mudar em runtime, por isso
// a verificacao roda de novo a cada entrada do modulo, antes do proximo frame comecar.
bool usartTxTransitionsUnobserved(const Esp32SharedState& chip, uint32_t index) {
    if (index == 0 && chip.pinTransitionsObserved[kPinMapUart0Tx]) return false;
    for (uint32_t pin = 0; pin < 34; ++pin) {
        const SignalDesc signal = selectedPinOutputSignal(chip, pin);
        if (signal.kind == SignalKind::UartTx && signal.index == index && chip.pinTransitionsObserved[pin]) {
            return false;
        }
    }
    return true;
}

void routeDirectInputAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    const SignalDesc signal = selectedDirectInputSignal(state, pin);
    if (signal.kind == SignalKind::None || signal.kind == SignalKind::RawGpio) return;
    signalSetInputLevelAt(state, signal, state.gpioInputs[pin], nowNs);
}

void routeMatrixInputsAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    for (uint32_t func = 0; func < state.matrixInRegs.size(); ++func) {
        if ((state.matrixInRegs[func] & 0x3Fu) != pin) continue;
        const SignalDesc signal = matrixInputSignal(func);
        if (signal.kind == SignalKind::None) continue;
        signalSetInputLevelAt(state, signal, state.gpioInputs[pin], nowNs);
    }
}

void routePinInputAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    if (pin >= 40) return;
    routeDirectInputAt(state, pin, nowNs);
    routeMatrixInputsAt(state, pin, nowNs);
}

uint32_t readPort(const Esp32SharedState& state, bool upperPort) {
    uint32_t value = 0;
    if (!upperPort) {
        for (uint32_t pin = 0; pin < 32; ++pin) {
            if (state.gpioInputs[pin]) value |= (1u << pin);
        }
        return value;
    }
    // GPIO_IN1_REG bit n = GPIO(32+n) (TRM). Starting at 33 shifted every upper pin by one bit, so
    // digitalRead(34..39) returned the neighbouring pad and GPIO32 was never readable.
    for (uint32_t pin = 32; pin < 40; ++pin) {
        if (state.gpioInputs[pin]) value |= (1u << (pin - 32u));
    }
    return value;
}

int getIoMuxPin(uint64_t offset) {
    switch (offset) {
        case 0x04: return 36;
        case 0x08: return 37;
        case 0x0C: return 38;
        case 0x10: return 39;
        case 0x14: return 34;
        case 0x18: return 35;
        case 0x1C: return 32;
        case 0x20: return 33;
        case 0x24: return 25;
        case 0x28: return 26;
        case 0x2C: return 27;
        case 0x30: return 14;
        case 0x34: return 12;
        case 0x38: return 13;
        case 0x3C: return 15;
        case 0x40: return 2;
        case 0x44: return 0;
        case 0x48: return 4;
        case 0x4C: return 16;
        case 0x50: return 17;
        case 0x54: return 9;
        case 0x58: return 10;
        case 0x5C: return 11;
        case 0x60: return 6;
        case 0x64: return 7;
        case 0x68: return 8;
        case 0x6C: return 5;
        case 0x70: return 18;
        case 0x74: return 19;
        case 0x78: return 20;
        case 0x7C: return 21;
        case 0x80: return 22;
        case 0x84: return 3;
        case 0x88: return 1;
        case 0x8C: return 23;
        case 0x90: return 24;
        default: return -1;
    }
}

struct GpioModuleState {
    Esp32SharedState* chip = nullptr;
};

struct IoMuxModuleState {
    Esp32SharedState* chip = nullptr;
};

struct UsartModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct I2cModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct SpiModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct AdcModuleState {
    Esp32SharedState* chip = nullptr;
    uint8_t channel1 = 0;
    uint8_t channel2 = 0;
};

struct LedcModuleState {
    Esp32SharedState* chip = nullptr;
};

struct RmtModuleState {
    Esp32SharedState* chip = nullptr;
};

struct PcntModuleState {
    Esp32SharedState* chip = nullptr;
};

void gpioReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    s->chip->gpioOut = 0;
    s->chip->gpioEnable = 0;
    s->chip->gpioOut1 = 0;
    s->chip->gpioEnable1 = 0;
    s->chip->gpioInputs.fill(false);
    s->chip->gpioInputRouted.fill(false);
    s->chip->gpioVoltages.fill(0.0);
    s->chip->gpioPinRegs.fill(0);
    s->chip->matrixInRegs.fill(0);
    s->chip->matrixOutRegs.fill(0);
}

void gpioWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    const uint64_t offset = address - kGpioStart;
    const uint32_t value32 = static_cast<uint32_t>(value);

    if (offset == 0x04) {
        chip.gpioOut = value32;
        return;
    }
    // GPIO_OUT_W1TS_REG/GPIO_OUT_W1TC_REG (0x08/0x0C, TRM real do ESP32) -- registrador de AÇÃO
    // (write-1-pra-set/clear), não de nível: `digitalWrite()`/`gpio_set_level()` do ESP-IDF
    // (`hal/esp32/include/hal/gpio_ll.h::gpio_ll_set_level`) usam EXCLUSIVAMENTE estes dois
    // registradores, nunca escrevem `GPIO_OUT_REG` (0x04) diretamente -- só firmware/bootloader
    // de baixo nível tocaria 0x04 cru. Sem tratar isto aqui, todo `digitalWrite()` normal seria um
    // no-op silencioso (bit nunca chega a `chip.gpioOut`), completando a modelagem que faltava
    // (achado 2026-07-17, revisão "pente fino").
    if (offset == 0x08) {
        chip.gpioOut |= value32;
        return;
    }
    if (offset == 0x0C) {
        chip.gpioOut &= ~value32;
        return;
    }
    // GPIO_OUT1_REG / _W1TS / _W1TC (GPIO32..39) -- o fork QEMU espelha o valor final em 0x10.
    if (offset == 0x10) {
        chip.gpioOut1 = value32 & 0xFFu;
        return;
    }
    if (offset == 0x14) {
        chip.gpioOut1 |= value32 & 0xFFu;
        return;
    }
    if (offset == 0x18) {
        chip.gpioOut1 &= ~value32;
        return;
    }
    if (offset == 0x20) {
        chip.gpioEnable = value32;
        return;
    }
    // GPIO_ENABLE_W1TS_REG/GPIO_ENABLE_W1TC_REG (0x24/0x28) -- mesmo padrão de ação acima, usado
    // por `gpio_set_direction()`/`pinMode()` real.
    if (offset == 0x24) {
        chip.gpioEnable |= value32;
        return;
    }
    if (offset == 0x28) {
        chip.gpioEnable &= ~value32;
        return;
    }
    // GPIO_ENABLE1_REG / _W1TS / _W1TC (GPIO32..39) -- espelhado em 0x2C.
    if (offset == 0x2C) {
        chip.gpioEnable1 = value32 & 0xFFu;
        return;
    }
    if (offset == 0x30) {
        chip.gpioEnable1 |= value32 & 0xFFu;
        return;
    }
    if (offset == 0x34) {
        chip.gpioEnable1 &= ~value32;
        return;
    }
    if (offset >= 0x88 && offset < 0x130) {
        const uint32_t pin = static_cast<uint32_t>((offset - 0x88) / 4u);
        if (pin < chip.gpioPinRegs.size()) chip.gpioPinRegs[pin] = value32;
        return;
    }
    if (offset >= 0x130 && offset < 0x530) {
        const uint32_t func = static_cast<uint32_t>((offset - 0x130) / 4u);
        if (func < chip.matrixInRegs.size()) {
            chip.matrixInRegs[func] = value32;
            const uint32_t pin = value32 & 0x3Fu;
            if (pin < 40) {
                routePinInputAt(chip, pin, nowNs);
            } else if (pin == 0x30 || pin == 0x38) {
                // IN_SEL 0x30/0x38: o sinal fica em 0/1 constante (ESP-IDF liga assim um controle do
                // PCNT sem pino, por exemplo).
                const SignalDesc signal = matrixInputSignal(func);
                if (signal.kind != SignalKind::None) signalSetInputLevelAt(chip, signal, pin == 0x38, nowNs);
            }
        }
        return;
    }
    if (offset >= 0x530 && offset < 0x5D0) {
        const uint32_t pin = static_cast<uint32_t>((offset - 0x530) / 4u);
        if (pin < chip.matrixOutRegs.size()) {
            chip.matrixOutRegs[pin] = value32;
            if (analogTraceEnabled() && pin == 27) {
                std::fprintf(stderr, "[LasecSimul][adapter][GPIO27] matrix=0x%08x signal=%u\n",
                             value32, value32 & 0xFFu);
            }
        }
    }
}

void gpioWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    gpioWriteRegisterAt(module, address, value, 0);
}

uint64_t gpioReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    if (offset == 0x3C) return readPort(*s->chip, false);
    if (offset == 0x40) return readPort(*s->chip, true);
    // Canal privado do Core (0xF00 pinos 0-31, 0xF04 pinos 32-39): pinos com interrupção armada,
    // INT_TYPE (bits 9:7) não nulo e algum INT_ENA (bits 17:13) -- o mesmo critério do modelo de GPIO
    // do QEMU. O lockstep exato só deixa de sincronizar bordas suaves enquanto nenhum estiver armado.
    if (offset == 0xF00 || offset == 0xF04) {
        const uint32_t first = offset == 0xF00 ? 0u : 32u;
        const uint32_t last = offset == 0xF00 ? 32u : 40u;
        uint64_t armed = 0;
        for (uint32_t pin = first; pin < last; ++pin) {
            const uint32_t conf = s->chip->gpioPinRegs[pin];
            if (((conf >> 7) & 7u) != 0 && (conf & 0x3E000u) != 0) armed |= 1ull << (pin - first);
        }
        return armed;
    }
    return 0;
}

// GPIO_PINn_REG (offset 0x88 + pin*4, ver gpioWriteRegisterAt) bit2 = PAD_DRIVER real do ESP32
// (0 = saida normal push-pull, 1 = open-drain -- mesmo bit que gpio_set_direction(pin,
// GPIO_MODE_OUTPUT_OD) do ESP-IDF programa). IO_MUX_GPIOn_REG (ver getIoMuxPin) bits 7/8 = FUN_PD/
// FUN_PU reais (confirmado contra Esp32Pin::writeIoMuxReg do SimulIDE real: "PD bit 7 / PU bit 8").
constexpr uint32_t kGpioPinPadDriverBit = 1u << 2;
constexpr uint16_t kIoMuxFunPdBit = 1u << 7;
constexpr uint16_t kIoMuxFunPuBit = 1u << 8;

bool gpioIsPadDriverOpenDrain(const Esp32SharedState& chip, uint32_t bit) {
    return bit < chip.gpioPinRegs.size() && (chip.gpioPinRegs[bit] & kGpioPinPadDriverBit) != 0;
}

// Nivel "cru" que o pino tentaria assumir se estivesse sendo dirigido, ANTES de qualquer decisao de
// open-drain (respeitando o invert da GPIO Matrix, bit9 de matrixOutRegs), para o sinal `signal`
// roteado ao pino. So' gpioPadOutput() chama: o mesmo nivel serve a saida e a checagem de open-drain.
bool gpioRawOutputLevel(const Esp32SharedState& chip, uint32_t bit, SignalDesc signal) {
    bool level = signalOutputLevel(chip, signal);
    if (bit < chip.matrixOutRegs.size() && selectedIoMuxIndex(chip, bit) == 2) {
        if ((chip.matrixOutRegs[bit] & (1u << 9)) != 0) level = !level;
    }
    return level;
}

struct PadOutput {
    bool enabled = false;
    bool level = false; // nivel pretendido, mesmo com o pino liberado (open-drain alto)
};

// RTC IO MUX (ESP32 TRM, RTC_IO): um pad de RTC com o MUX_SEL do seu registrador de pad vai ao dominio do
// RTC (rtc_gpio_init: toque, DAC, ADC, GPIO de RTC) e a saida digital do IO_MUX/GPIO matrix deixa de
// chegar nele: quem o dirige e' o GPIO de RTC (RTC_GPIO_ENABLE/RTC_GPIO_OUT, bit 14 + numero do GPIO de RTC;
// rtc_gpio_set_level), e os pulls passam a ser os do pad de RTC (RUE/RDE). O QEMU (hw/misc/esp32_rtcio.c)
// repassa cada escrita desses registradores. 0xFF: o pad nao tem pull.
struct RtcPadDesc {
    uint8_t gpio;
    uint8_t rtc; // numero do GPIO de RTC
    uint8_t offset;
    uint8_t mux, rue, rde;
};
constexpr std::array<RtcPadDesc, 18> kRtcPads = {{
    {4, 10, 0x94, 19, 27, 28}, {0, 11, 0x98, 19, 27, 28}, {2, 12, 0x9C, 19, 27, 28}, {15, 13, 0xA0, 19, 27, 28},
    {13, 14, 0xA4, 19, 27, 28}, {12, 15, 0xA8, 19, 27, 28}, {14, 16, 0xAC, 19, 27, 28}, {27, 17, 0xB0, 19, 27, 28},
    {25, 6, 0x84, 17, 27, 28}, {26, 7, 0x88, 17, 27, 28}, {33, 8, 0x8C, 18, 27, 28}, {32, 9, 0x8C, 17, 22, 23},
    {36, 0, 0x7C, 27, 0xFF, 0xFF}, {37, 1, 0x7C, 26, 0xFF, 0xFF}, {38, 2, 0x7C, 25, 0xFF, 0xFF}, {39, 3, 0x7C, 24, 0xFF, 0xFF},
    {34, 4, 0x80, 29, 0xFF, 0xFF}, {35, 5, 0x80, 28, 0xFF, 0xFF},
}};
constexpr uint32_t kRtcGpioOut = 0x00, kRtcGpioEnable = 0x0C;
constexpr uint64_t kRtcIoStart = 0x3FF48400;
constexpr uint64_t kRtcIoEnd = 0x3FF484FF;

const RtcPadDesc* rtcPadMuxed(const Esp32SharedState& chip, uint32_t gpio) {
    for (const RtcPadDesc& pad : kRtcPads)
        if (pad.gpio == gpio) return (chip.rtcIoRegs[pad.offset / 4u] >> pad.mux) & 1u ? &pad : nullptr;
    return nullptr;
}

// Saida do pad `bit` com uma consulta so' ao IOMUX/GPIO matrix -- unica fonte de
// gpioIsOutputEnabled/gpioOutputLevel e do lote (gpioGetPinStates).
PadOutput gpioPadOutput(const Esp32SharedState& chip, uint32_t bit) {
    if (bit >= 34) return {}; // GPIO34-39 are input-only
    if (const RtcPadDesc* pad = rtcPadMuxed(chip, bit)) { // no dominio do RTC: o GPIO de RTC
        const uint32_t mask = 1u << (14u + pad->rtc);
        if (!(chip.rtcIoRegs[kRtcGpioEnable / 4u] & mask)) return {};
        return PadOutput{true, (chip.rtcIoRegs[kRtcGpioOut / 4u] & mask) != 0};
    }

    const SignalDesc signal = selectedPinOutputSignal(chip, bit);
    PadOutput out{signalOutputEnabled(chip, signal), gpioRawOutputLevel(chip, bit, signal)};

    if (bit < chip.matrixOutRegs.size() && selectedIoMuxIndex(chip, bit) == 2) {
        const uint32_t cfg = chip.matrixOutRegs[bit];
        if ((cfg & (1u << 10)) != 0) out.enabled = gpioEnableBit(chip, bit);
        if ((cfg & (1u << 11)) != 0) out.enabled = !out.enabled;
    }
    // Open-drain (PAD_DRIVER=1): o pino so' dirige de verdade o nivel BAIXO -- o nivel ALTO libera
    // o pino pro pull-up (interno, ver gpioGetPullState, ou externo no circuito do usuario)
    // resolver, exatamente como o hardware real faz (gpio_set_direction(..., GPIO_MODE_OUTPUT_OD)).
    // Reaproveita o MESMO ramo "floating" de McuComponent::stamp() que ja existe pro caso "nao
    // dirigido" -- nenhum caminho eletrico novo, so' esta decisao de QUANDO ele se aplica.
    if (out.enabled && gpioIsPadDriverOpenDrain(chip, bit) && out.level) out.enabled = false;
    return out;
}

int32_t gpioIsOutputEnabled(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const Esp32SharedState& chip = *s->chip;
    const bool enabled = gpioPadOutput(chip, bit).enabled;
    if (analogTraceEnabled() && bit == 27) {
        static int previous = -1;
        const int current = enabled ? 1 : 0;
        if (current != previous) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][GPIO27] output_enabled=%d mux=%u matrix=0x%08x\n",
                         current, selectedIoMuxIndex(chip, bit), chip.matrixOutRegs[bit]);
            previous = current;
        }
    }
    return enabled ? 1 : 0;
}

int32_t gpioOutputLevel(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const Esp32SharedState& chip = *s->chip;
    const bool level = gpioPadOutput(chip, bit).level;
    if (analogTraceEnabled() && bit == 27) {
        static int previous = -1;
        static uint32_t changes = 0;
        const int current = level ? 1 : 0;
        if (current != previous && changes < 32) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][GPIO27] output_level=%d ledc0=%d mux=%u\n",
                         current, chip.ledc.outputLevel[0] ? 1 : 0, selectedIoMuxIndex(chip, bit));
            previous = current;
            ++changes;
        }
    }
    return level ? 1 : 0;
}

// Pull-up/pull-down INTERNO real (IO_MUX_GPIOn_REG bits 7/8, ver getIoMuxPin/ioMuxWriteRegisterAt)
// -- consultado por McuComponent::stamp() SO' quando isOutputEnabled() for falso (pino flutuando
// OU liberado por open-drain em nivel alto, ver acima), pra puxar fraco pra VDD/GND em vez do
// floating generico. Nao depende de qual funcao IOMUX esta selecionada: o pad eletrico do ESP32
// real aplica pull-up/down independente da funcao digital roteada por cima.
int32_t gpioGetPullState(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const Esp32SharedState& chip = *s->chip;
    if (bit >= chip.ioMuxRegs.size()) return 0;
    if (const RtcPadDesc* pad = rtcPadMuxed(chip, bit)) {
        if (pad->rue == 0xFF) return 0;
        const uint32_t reg = chip.rtcIoRegs[pad->offset / 4u];
        return (((reg >> pad->rue) & 1u) ? static_cast<int32_t>(LSDN_PULL_UP) : 0) |
               (((reg >> pad->rde) & 1u) ? static_cast<int32_t>(LSDN_PULL_DOWN) : 0);
    }
    const uint16_t reg = chip.ioMuxRegs[bit];
    int32_t result = 0;
    if ((reg & kIoMuxFunPuBit) != 0) result |= static_cast<int32_t>(LSDN_PULL_UP);
    if ((reg & kIoMuxFunPdBit) != 0) result |= static_cast<int32_t>(LSDN_PULL_DOWN);
    return result;
}

// McuComponent::stamp() samples every input pad on every solve. Routing walks all 256 GPIO-matrix
// input selectors, and an unchanged level changes no routed signal (they keep levels or react to
// edges; IO_MUX and GPIO_FUNCn_IN_SEL writes route the current level themselves): only a new
// level is routed.
void gpioUpdateInputAt(Esp32SharedState& chip, uint32_t bit, bool level, uint64_t nowNs) {
    if (chip.gpioInputRouted[bit] && chip.gpioInputs[bit] == level) return;
    chip.gpioInputs[bit] = level;
    chip.gpioInputRouted[bit] = true;
    routePinInputAt(chip, bit, nowNs);
}

void gpioSetInputLevelAt(LsdnQemuModule* module, uint32_t bit, int32_t level, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    if (bit >= chip.gpioInputs.size()) return;
    gpioUpdateInputAt(chip, bit, level != 0, nowNs);
}

void gpioSetInputLevel(LsdnQemuModule* module, uint32_t bit, int32_t level) {
    gpioSetInputLevelAt(module, bit, level, 0);
}

// Sensor de toque (ver TouchState): o GPIO de cada canal do SENS e a medicao da capacitancia externa.
constexpr std::array<uint32_t, 10> kTouchChannelGpio = {4, 0, 2, 15, 13, 12, 14, 27, 32, 33};
constexpr double kTouchProbeOhms = 1'000'000.0;
constexpr double kTouchArmOhms = 1e15;
constexpr uint64_t kTouchProbeNs = 1'000;

bool touchTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_TOUCH_TRACE");
        return value && *value && value[0] != '0';
    }();
    return enabled;
}

// Os canais em medicao com a fonte `ohms` (0: desligada).
void touchDrive(Esp32SharedState& chip, double ohms) {
    TouchState& t = chip.touch;
    for (uint32_t ch = 0; ch < t.channels.size(); ++ch) {
        if (!(t.mask & (1u << ch))) continue;
        chip.analogDrive[kTouchChannelGpio[ch]] = AnalogDrive{ohms > 0.0, t.channels[ch].target, ohms};
    }
}

// O pedido do QEMU no inicio de uma medicao (ver TouchState): arma a fonte desprezivel, longe da tensao em que
// cada pad esta' (pelo ultimo valor amostrado: so' escolhe o sentido).
void touchStartProbe(Esp32SharedState& chip, uint32_t mask, uint32_t seq, uint64_t nowNs) {
    TouchState& t = chip.touch;
    if (touchTraceEnabled())
        std::fprintf(stderr, "[TOUCH] start seq=%u mask=%03x now=%llu\n", seq, mask, static_cast<unsigned long long>(nowNs));
    touchDrive(chip, 0.0); // um pedido novo encerra o anterior
    t.seq = seq;
    t.mask = mask;
    if (mask == 0) {
        t.stage = TouchState::Stage::Idle;
        t.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        t.doneSeq = seq;
        return;
    }
    for (uint32_t ch = 0; ch < t.channels.size(); ++ch) {
        if (!(mask & (1u << ch))) continue;
        TouchChannel& c = t.channels[ch];
        c.target = 0.0; // a fonte armada so' decide o no' de um pad sem mais nada ligado
        c.hasA = false;
    }
    t.t0 = nowNs;
    t.stage = TouchState::Stage::Armed;
    t.dueNs = addDelayNs(nowNs, 1);
    touchDrive(chip, kTouchArmOhms);
}

// As etapas no tempo (o despertar do modulo do ADC).
void touchAdvance(Esp32SharedState& chip, uint64_t nowNs) {
    TouchState& t = chip.touch;
    if (t.dueNs == LSDN_QEMU_MODULE_NO_WAKEUP || nowNs < t.dueNs) return;
    t.stageNs = nowNs;
    switch (t.stage) {
        case TouchState::Stage::Armed: // liga, para o trilho mais longe da tensao em T0; o stamp amostra A
            for (uint32_t ch = 0; ch < t.channels.size(); ++ch)
                if (t.mask & (1u << ch)) t.channels[ch].target = chip.gpioVoltages[kTouchChannelGpio[ch]] < 1.65 ? 3.3 : 0.0;
            t.stage = TouchState::Stage::On;
            t.pending = t.mask;
            t.dueNs = addDelayNs(nowNs, kTouchProbeNs);
            touchDrive(chip, kTouchProbeOhms);
            break;
        case TouchState::Stage::On: // forca a solucao em T1, ainda ligada
            t.stage = TouchState::Stage::Forced;
            t.dueNs = addDelayNs(nowNs, 1);
            touchDrive(chip, kTouchProbeOhms * (1.0 + 1e-9));
            break;
        case TouchState::Stage::Forced: // desliga: o stamp que isso causa amostra B
            t.stage = TouchState::Stage::Off;
            t.pending = t.mask;
            t.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            touchDrive(chip, 0.0);
            break;
        default:
            t.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            break;
    }
}

// Cada amostra de tensao de um pad em medicao: A no primeiro stamp depois de a fonte ligar, B no primeiro
// depois de desligar.
void touchSamplePad(Esp32SharedState& chip, uint32_t gpio, double voltage, uint64_t nowNs) {
    TouchState& t = chip.touch;
    if (t.stage != TouchState::Stage::On && t.stage != TouchState::Stage::Off) return;
    if (nowNs < t.stageNs) return;
    for (uint32_t ch = 0; ch < t.channels.size(); ++ch) {
        if (kTouchChannelGpio[ch] != gpio || !(t.pending & (1u << ch))) continue;
        TouchChannel& c = t.channels[ch];
        if (touchTraceEnabled())
            std::fprintf(stderr, "[TOUCH] sample ch=%u stage=%d v=%.6f now=%llu\n", ch, static_cast<int>(t.stage), voltage,
                         static_cast<unsigned long long>(nowNs));
        t.pending &= ~(1u << ch);
        if (t.stage == TouchState::Stage::On) {
            c.a = voltage;
            c.hasA = true;
            continue;
        }
        // B: a tensao em T1 = T0 + 1 ns + kTouchProbeNs, com a fonte ligada desde T0.
        const double dt = static_cast<double>(1 + kTouchProbeNs) * 1e-9;
        // A no proprio alvo: um pad sem nada que o segure (o no' vai ao alvo na hora), C = 0.
        const double ratio = c.hasA && std::abs(c.a - c.target) > 1e-3 ? (voltage - c.target) / (c.a - c.target) : 0.0;
        double farads = 0.0;
        if (ratio >= 1.0) farads = 6553.5e-12;  // nao andou: capacitancia (ou carga) enorme
        else if (ratio > 1e-12) farads = -dt / (kTouchProbeOhms * std::log(ratio));
        c.capTenthsPf = static_cast<uint16_t>(std::lround(std::clamp(farads * 1e13, 0.0, 65535.0)));
        if (touchTraceEnabled()) std::fprintf(stderr, "[TOUCH] ch=%u C=%.2f pF\n", ch, farads * 1e12);
    }
    if (t.stage == TouchState::Stage::Off && t.pending == 0) {
        t.stage = TouchState::Stage::Idle;
        t.doneSeq = t.seq;
    }
}

void gpioSetInputVoltageAt(LsdnQemuModule* module, uint32_t bit, double voltage, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    if (bit >= chip.gpioInputs.size()) return;
    chip.gpioVoltages[bit] = voltage;
    if (chip.touch.stage != TouchState::Stage::Idle) touchSamplePad(chip, bit, voltage, nowNs);
    gpioUpdateInputAt(chip, bit, voltage > 1.65, nowNs);
}

// mcu_abi.h 3.2: McuComponent le todos os pinos a cada stamp e antes/depois de cada evento do QEMU.
// Numa chamada so', com uma consulta ao IOMUX/GPIO matrix por pino (gpioPadOutput, a mesma das
// chamadas por pino); com o trace analogico ligado, pelas proprias chamadas por pino, que o imprimem.
void gpioGetPinStates(LsdnQemuModule* module, const uint32_t* bits, uint32_t count, uint8_t* out) {
    const Esp32SharedState& chip = *reinterpret_cast<GpioModuleState*>(module)->chip;
    const bool trace = analogTraceEnabled();
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t bit = bits[i];
        if (bit < chip.analogDrive.size() && chip.analogDrive[bit].active) {
            out[i] = static_cast<uint8_t>(LSDN_PIN_STATE_ANALOG);
            continue;
        }
        PadOutput pad;
        if (!trace) pad = gpioPadOutput(chip, bit);
        else if ((pad.enabled = gpioIsOutputEnabled(module, bit) != 0)) pad.level = gpioOutputLevel(module, bit) != 0;
        if (pad.enabled) {
            out[i] = static_cast<uint8_t>(LSDN_PIN_STATE_OUTPUT_ENABLED | (pad.level ? LSDN_PIN_STATE_OUTPUT_HIGH : 0u));
            continue;
        }
        const int32_t pull = gpioGetPullState(module, bit);
        out[i] = static_cast<uint8_t>(((pull & static_cast<int32_t>(LSDN_PULL_UP)) ? LSDN_PIN_STATE_PULL_UP : 0u) |
                                      ((pull & static_cast<int32_t>(LSDN_PULL_DOWN)) ? LSDN_PIN_STATE_PULL_DOWN : 0u));
    }
}

void gpioSetInputVoltagesAt(LsdnQemuModule* module, const uint32_t* bits, const double* voltages, uint32_t count,
                            uint64_t nowNs) {
    for (uint32_t i = 0; i < count; ++i) gpioSetInputVoltageAt(module, bits[i], voltages[i], nowNs);
}

void gpioDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<GpioModuleState*>(module);
}

// mcu_abi.h 3.4: a USART cujo TX o pad `bit` carrega agora (IO_MUX ou matriz de GPIO), mesma
// seleção de usartTxTransitionsUnobserved().
uint32_t gpioUartTxOnLine(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    if (bit >= 34) return 0;
    const SignalDesc signal = selectedPinOutputSignal(*s->chip, bit);
    return signal.kind == SignalKind::UartTx ? signal.index + 1u : 0u;
}

// mcu_abi.h 3.5: a fonte analogica no pad `bit` (medicao de toque, DAC).
int32_t gpioGetPinAnalog(LsdnQemuModule* module, uint32_t bit, double* volts, double* ohms) {
    const Esp32SharedState& chip = *reinterpret_cast<GpioModuleState*>(module)->chip;
    if (bit >= chip.analogDrive.size() || !chip.analogDrive[bit].active) return 0;
    *volts = chip.analogDrive[bit].volts;
    *ohms = chip.analogDrive[bit].ohms;
    return 1;
}

const LsdnQemuModuleVTable kGpioModuleVTable = {
    &gpioReset, &gpioWriteRegister, &gpioReadRegister, &gpioIsOutputEnabled, &gpioOutputLevel,
    &gpioSetInputLevel, &gpioDestroy, nullptr, nullptr, &gpioWriteRegisterAt, &gpioSetInputLevelAt, nullptr,
    &gpioSetInputVoltageAt, nullptr, nullptr, nullptr, &gpioGetPullState, nullptr,
    &gpioGetPinStates, &gpioSetInputVoltagesAt,
    nullptr, // drain_spi_byte
    &gpioUartTxOnLine,
    &gpioGetPinAnalog,
};

void ioMuxReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    s->chip->ioMuxRegs.fill(0);
}

void ioMuxWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    const uint64_t offset = address - kIoMuxStart;
    const int pin = getIoMuxPin(offset);
    if (pin < 0) return;
    chip.ioMuxRegs[static_cast<size_t>(pin)] = static_cast<uint16_t>(value);
    // LASECSIMUL_IOMUX_TRACE=1: cada escrita de IO_MUX_GPIOn_REG (função, pull, IE) -- só na
    // configuração dos pinos, nunca em caminho quente.
    static const bool ioMuxTrace = !processEnvironmentValue("LASECSIMUL_IOMUX_TRACE").empty() &&
                                   processEnvironmentValue("LASECSIMUL_IOMUX_TRACE") != "0";
    if (ioMuxTrace) {
        std::fprintf(stderr, "[LasecSimul][adapter][IOMUX] pin=%d value=0x%04llx mcu_sel=%llu pu=%d pd=%d ie=%d at=%llu\n",
                     pin, static_cast<unsigned long long>(value), static_cast<unsigned long long>((value >> 12) & 7u),
                     (value & kIoMuxFunPuBit) ? 1 : 0, (value & kIoMuxFunPdBit) ? 1 : 0, (value >> 9) & 1u ? 1 : 0,
                     static_cast<unsigned long long>(nowNs));
    }
    if (analogTraceEnabled() && pin == 27) {
        std::fprintf(stderr, "[LasecSimul][adapter][GPIO27] iomux=0x%08llx mux=%u\n",
                     static_cast<unsigned long long>(value), selectedIoMuxIndex(chip, 27));
    }
    routePinInputAt(chip, static_cast<uint32_t>(pin), nowNs);
}

void ioMuxWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    ioMuxWriteRegisterAt(module, address, value, 0);
}

uint64_t ioMuxReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    const uint64_t offset = address - kIoMuxStart;
    const int pin = getIoMuxPin(offset);
    if (pin < 0) return 0;
    return s->chip->ioMuxRegs[static_cast<size_t>(pin)];
}

void ioMuxDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<IoMuxModuleState*>(module);
}

const LsdnQemuModuleVTable kIoMuxModuleVTable = {
    &ioMuxReset, &ioMuxWriteRegister, &ioMuxReadRegister, nullptr, nullptr, nullptr, &ioMuxDestroy,
    nullptr, nullptr, &ioMuxWriteRegisterAt, nullptr, nullptr,
};

// Reset do periferico: o transmissor, o receptor e as FIFOs voltam ao reset. Os monitores e o tap do fio
// guardam bytes que ja' passaram pelo pino e ainda nao foram lidos: um reset do chip nao os desfaz (antes o
// esp_restart() e o deep sleep apagavam o fim do que o firmware imprimiu logo antes).
void usartPeripheralReset(UsartState& usart) {
    UsartState fresh{};
    fresh.txMonitor = std::move(usart.txMonitor);
    fresh.rxMonitor = std::move(usart.rxMonitor);
    fresh.txWireTap = std::move(usart.txWireTap);
    fresh.txMonitorDropped = usart.txMonitorDropped;
    fresh.rxMonitorDropped = usart.rxMonitorDropped;
    fresh.txWireTapDropped = usart.txWireTapDropped;
    usart = std::move(fresh);
}

void usartReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    usartPeripheralReset(s->chip->usarts[s->index]);
    s->chip->gpioInputRouted.fill(false); // the reset input levels get the pads' again (gpioUpdateInputAt)
}

void usartWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return;

    UsartState& usart = s->chip->usarts[s->index];
    const uint64_t offset = address - usartStartAddress(s->index);
    const uint32_t data = static_cast<uint32_t>(value);
    usart.txSilentFramesAllowed = usartTxTransitionsUnobserved(*s->chip, s->index);

    switch (offset) {
        case 0x00:
            if (usart.txFifo.size() < 128) {
                usart.txFifo.push_back(static_cast<uint8_t>(data & 0xFFu));
                usartStartTx(usart, nowNs);
            }
            break;
        case 0x14:
            usartWriteClkDiv(usart, data);
            break;
        case 0x20:
            usartWriteConf0(usart, data, nowNs);
            usart.useApb = (data & (1u << 27)) != 0;
            break;
        case 0xF10: // o divisor que o QEMU usa (UART_CLKDIV em 20.4)
            usart.clkdivRaw = data;
            break;
        case 0x40: // UART_IDLE_CONF: TX_BRK_NUM [27:20], o tamanho do break
            usart.txBreakBits = static_cast<uint8_t>((data >> 20) & 0xFFu);
            break;
        case 0x44: // UART_RS485_CONF: DL0_EN (bit 1) e DL1_EN (bit 2), um bit de stop a mais cada
            usart.dlBits = static_cast<uint8_t>(((data >> 1) & 1u) + ((data >> 2) & 1u));
            break;
        default:
            break;
    }
}

void usartWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    usartWriteRegisterAt(module, address, value, 0);
}

uint64_t usartReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return 0;

    UsartState& usart = s->chip->usarts[s->index];
    const uint64_t offset = address - usartStartAddress(s->index);
    switch (offset) {
        case 0x00:
            if (usart.rxFifo.empty()) return 0;
            {
                const uint8_t data = static_cast<uint8_t>(usart.rxFifo.front());
                usart.rxFifo.pop_front();
                return data;
            }
        case 0xF04:
            // Canal privado: o mesmo byte com os erros que o receptor viu nele (kUartRx* >> 8 nos bits
            // [10:8]), para o Core levar ao modelo de UART do QEMU (UART_INT_RAW: PARITY_ERR, FRM_ERR, BRK_DET).
            if (usart.rxFifo.empty()) return 0;
            {
                const uint16_t entry = usart.rxFifo.front();
                usart.rxFifo.pop_front();
                return entry;
            }
        case 0x1C:
            return static_cast<uint64_t>(usart.rxFifo.size()) |
                   (static_cast<uint64_t>(usart.txFifo.size()) << 16u);
        case 0x60:
            return static_cast<uint64_t>(usart.rxFifo.size() & 0x7Fu) << 13u;
        case 0x78:
            return 0x15122500u;
        case 0xF00:
            // Canal privado Core<->adaptador (fora do mapa do periférico real): 1 enquanto um quadro
            // de RX está sendo recebido -- o Core trata esse despertar como entrada do guest.
            return usart.rxPhase != UartRxPhase::Idle ? 1u : 0u;
        default:
            return 0;
    }
}
int32_t usartIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    return line == kUartTxLine && s->index < s->chip->usarts.size() ? 1 : 0;
}
int32_t usartOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    return line == kUartTxLine && s->index < s->chip->usarts.size() && s->chip->usarts[s->index].txLevel ? 1 : 0;
}
void usartSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (line == kUartRxLine && s->index < s->chip->usarts.size()) {
        usartSetRxLevel(s->chip->usarts[s->index], level != 0, 0);
    }
}
void usartSetInputLevelAt(LsdnQemuModule* module, uint32_t line, int32_t level, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (line == kUartRxLine && s->index < s->chip->usarts.size()) {
        usartSetRxLevel(s->chip->usarts[s->index], level != 0, nowNs);
    }
}
void usartDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<UsartModuleState*>(module);
}

uint64_t usartNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs);

uint64_t usartNextWakeupDelayNs(LsdnQemuModule* module) {
    return usartNextWakeupDelayNsAt(module, 0);
}

uint64_t usartNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    if (s->index >= s->chip->usarts.size()) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return nextUsartWakeupDelayNs(s->chip->usarts[s->index], nowNs);
}

void usartOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    if (s->index >= s->chip->usarts.size()) return;
    UsartState& usart = s->chip->usarts[s->index];
    usart.txSilentFramesAllowed = usartTxTransitionsUnobserved(*s->chip, s->index);
    usartAdvanceDueWork(usart, nowNs);
}

// Monitor fora da banda (mcu_abi.h minor 6) -- ver `UsartState::txMonitor`/`rxMonitor`,
// `pushMonitorByte`, e os pontos de captura em `usartAdvanceTx`/`usartAdvanceRx` acima.
int32_t usartDrainMonitorByte(LsdnQemuModule* module, int32_t tx, uint8_t* outByte) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size() || !outByte) return 0;
    std::deque<uint8_t>& monitor = tx != 0 ? s->chip->usarts[s->index].txMonitor : s->chip->usarts[s->index].rxMonitor;
    if (monitor.empty()) return 0;
    *outByte = monitor.front();
    monitor.pop_front();
    return 1;
}

uint32_t usartMonitorDroppedCount(LsdnQemuModule* module, int32_t tx) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return 0;
    return tx != 0 ? s->chip->usarts[s->index].txMonitorDropped : s->chip->usarts[s->index].rxMonitorDropped;
}

int32_t usartDrainWireTapByte(LsdnQemuModule* module, uint8_t* outByte) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size() || !outByte) return 0;
    std::deque<uint8_t>& tap = s->chip->usarts[s->index].txWireTap;
    if (tap.empty()) return 0;
    *outByte = tap.front();
    tap.pop_front();
    return 1;
}

// Injeção de RX fora da banda (mcu_abi.h minor 7) -- lado ESCRITA do monitor: bytes entram direto
// no FIFO real de RX (mesmo `usart.rxFifo` que `usartAdvanceRx` alimenta bit-a-bit ao amostrar o
// pino elétrico), como se tivessem chegado por fio -- sem simular temporização de bit nenhuma
// (ferramenta de monitor/dev, ver QemuModule::injectRxBytes). Respeita o mesmo limite de 128
// bytes/descarte silencioso que o caminho elétrico real já usa (`usartWriteRegisterAt`/
// `usartAdvanceRx`). Também alimenta `rxMonitor` explicitamente -- `usartAdvanceRx` é quem faz
// isso hoje pro caminho elétrico (ver captura em `usartAdvanceRx` acima); bytes injetados bypassam
// esse caminho, então não apareceriam no próprio painel "Entrada" de quem enviou sem este passo
// extra.
size_t usartInjectRxBytes(LsdnQemuModule* module, const uint8_t* bytes, size_t count) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size() || !bytes) return 0;
    UsartState& usart = s->chip->usarts[s->index];
    size_t accepted = 0;
    for (size_t i = 0; i < count; ++i) {
        if (usart.rxFifo.size() >= 128) break;
        usart.rxFifo.push_back(bytes[i]);
        pushMonitorByte(usart.rxMonitor, usart.rxMonitorDropped, bytes[i]);
        ++accepted;
    }
    return accepted;
}

// mcu_abi.h 3.2: UART0_RX/UART0_TX dedicados, numa chamada so' (ver gpioGetPinStates).
void usartGetPinStates(LsdnQemuModule* module, const uint32_t* lines, uint32_t count, uint8_t* out) {
    for (uint32_t i = 0; i < count; ++i) {
        out[i] = usartIsOutputEnabled(module, lines[i])
            ? static_cast<uint8_t>(LSDN_PIN_STATE_OUTPUT_ENABLED |
                                   (usartOutputLevel(module, lines[i]) ? LSDN_PIN_STATE_OUTPUT_HIGH : 0u))
            : uint8_t{0};
    }
}

// Sem set_input_voltage_at, o Core ja' entregava cada amostra pelo limiar de 1,65 V.
void usartSetInputVoltagesAt(LsdnQemuModule* module, const uint32_t* lines, const double* voltages, uint32_t count,
                             uint64_t nowNs) {
    for (uint32_t i = 0; i < count; ++i) usartSetInputLevelAt(module, lines[i], voltages[i] > 1.65 ? 1 : 0, nowNs);
}

const LsdnQemuModuleVTable kUsartModuleVTable = {
    &usartReset, &usartWriteRegister, &usartReadRegister, &usartIsOutputEnabled, &usartOutputLevel,
    &usartSetInputLevel, &usartDestroy, &usartNextWakeupDelayNs, &usartOnWakeup,
    &usartWriteRegisterAt, &usartSetInputLevelAt, &usartNextWakeupDelayNsAt, nullptr,
    &usartDrainMonitorByte, &usartMonitorDroppedCount, &usartInjectRxBytes, nullptr,
    &usartDrainWireTapByte, &usartGetPinStates, &usartSetInputVoltagesAt,
};

// SDA do escravo depois de SDA_HOLD (no minimo 50 ns: SCL e SDA nao mudam no mesmo solve).
void i2cSlaveDriveSda(I2cState& i2c, bool low, uint64_t nowNs) {
    i2c.sSdaLow = low;
    i2c.sSdaDueNs = addDelayNs(nowNs, std::max<uint64_t>(i2c.sdaHoldNs, 50));
}

void i2cSlaveLoadByte(I2cState& i2c) {
    if (i2c.sTx.empty()) {
        i2c.sTxByte = 0xFF; // a FIFO vazia: o barramento fica em alto
        return;
    }
    i2c.sTxByte = i2c.sTx.front();
    i2c.sTx.pop_front();
    i2c.sEvents.push_back(i2c.sTxByte | (kI2cSlaveTxTaken << 8));
}


bool i2cSlaveTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_I2C_SLAVE_TRACE");
        return value && *value && value[0] != '0';
    }();
    return enabled;
}

void i2cSlaveEvent(I2cState& i2c, uint32_t event, uint64_t nowNs) {
    i2c.sEvents.push_back(event);
    if (i2cSlaveTraceEnabled())
        std::fprintf(stderr, "[I2C-SLAVE] t=%llu addr=0x%02x event=%u byte=0x%02x\n", static_cast<unsigned long long>(nowNs),
                     i2c.slaveAddr, (event >> 8) & 0xFu, event & 0xFFu);
}

void i2cSlaveEdge(I2cState& i2c, bool sclBefore, bool sdaBefore, uint64_t nowNs);

/* O nivel de SCL ou SDA que a matriz traz do pad ao I2C `index` (o mestre amostra dali; o escravo reage a borda). */
void i2cInputAt(I2cState& i2c, uint32_t index, bool scl, bool level, uint64_t nowNs) {
    const bool sclBefore = i2c.sclInput, sdaBefore = i2c.sdaInput;
    if (scl) i2c.sclInput = level;
    else i2c.sdaInput = level;
    if (sclBefore == i2c.sclInput && sdaBefore == i2c.sdaInput) return;
    static int traced = 0;
    if (i2cSlaveTraceEnabled() && i2c.slaveMode && traced < 80) {
        ++traced;
        std::fprintf(stderr, "[I2C-SLAVE] in i2c%u t=%llu scl=%d sda=%d addr=0x%02x phase=%d clocks=%u\n", index,
                     static_cast<unsigned long long>(nowNs), i2c.sclInput, i2c.sdaInput, i2c.slaveAddr,
                     static_cast<int>(i2c.sPhase), i2c.sClocks);
    }
    if (i2c.slaveMode) i2cSlaveEdge(i2c, sclBefore, sdaBefore, nowNs);
}

/* Uma borda de SCL ou SDA nos pads, com os niveis de antes. */
void i2cSlaveEdge(I2cState& i2c, bool sclBefore, bool sdaBefore, uint64_t nowNs) {
    const bool scl = i2c.sclInput, sda = i2c.sdaInput;
    if (scl && sclBefore && sda != sdaBefore) {
        if (!sda) { // START ou START repetido
            i2c.sPhase = I2cSlavePhase::Address;
            i2c.sClocks = 0;
            i2c.sShift = 0;
        } else {    // STOP
            if (i2c.sAddressed)
                i2cSlaveEvent(i2c, (kI2cSlaveStop << 8) | (uint32_t(i2c.sLastState) << 13) | (i2c.sRead ? 1u << 12 : 0), nowNs);
            i2c.sAddressed = false;
            i2c.sPhase = I2cSlavePhase::Idle;
        }
        if (i2c.sSdaLow) i2cSlaveDriveSda(i2c, false, nowNs);
        return;
    }
    if (scl == sclBefore) return;
    if (scl) { // subida: amostra
        switch (i2c.sPhase) {
            case I2cSlavePhase::Address:
            case I2cSlavePhase::Receive:
                if (i2c.sClocks < 8) i2c.sShift = static_cast<uint8_t>((i2c.sShift << 1) | (sda ? 1u : 0u));
                if (++i2c.sClocks == 8) {
                    if (i2c.sPhase == I2cSlavePhase::Address) {
                        if ((i2c.sShift >> 1) != (i2c.slaveAddr & 0x7Fu)) {
                            i2c.sPhase = I2cSlavePhase::Ignore; // outro endereco: ate' o proximo START
                            break;
                        }
                        i2c.sRead = (i2c.sShift & 1u) != 0;
                        i2c.sAddressed = true;
                        i2c.sLastState = 2;
                        i2cSlaveEvent(i2c, (kI2cSlaveAddressed << 8) | (i2c.sRead ? 1u << 12 : 0), nowNs);
                    } else {
                        i2c.sLastState = 5;
                        i2cSlaveEvent(i2c, i2c.sShift | (kI2cSlaveRx << 8), nowNs);
                    }
                }
                break;
            case I2cSlavePhase::Transmit:
                if (++i2c.sClocks == 9) {
                    i2c.sMasterAck = !sda;
                    i2c.sLastState = 6;
                }
                break;
            default:
                break;
        }
        return;
    }
    // descida: dirige o proximo bit
    switch (i2c.sPhase) {
        case I2cSlavePhase::Address:
        case I2cSlavePhase::Receive:
            if (i2c.sClocks == 8) {
                i2cSlaveDriveSda(i2c, true, nowNs); // ACK
            } else if (i2c.sClocks == 9) {
                i2c.sClocks = 0;
                i2c.sShift = 0;
                if (i2c.sPhase == I2cSlavePhase::Address && i2c.sRead) {
                    i2c.sPhase = I2cSlavePhase::Transmit;
                    i2cSlaveLoadByte(i2c);
                    i2cSlaveDriveSda(i2c, (i2c.sTxByte & 0x80u) == 0, nowNs);
                } else {
                    i2c.sPhase = I2cSlavePhase::Receive;
                    i2cSlaveDriveSda(i2c, false, nowNs);
                }
            }
            break;
        case I2cSlavePhase::Transmit:
            if (i2c.sClocks >= 1 && i2c.sClocks <= 7) {
                i2cSlaveDriveSda(i2c, ((i2c.sTxByte >> (7 - i2c.sClocks)) & 1u) == 0, nowNs);
            } else if (i2c.sClocks == 8) {
                i2cSlaveDriveSda(i2c, false, nowNs); // o ACK e' do mestre
            } else if (i2c.sClocks == 9) {
                i2c.sClocks = 0;
                if (i2c.sMasterAck) {
                    i2cSlaveLoadByte(i2c);
                    i2cSlaveDriveSda(i2c, (i2c.sTxByte & 0x80u) == 0, nowNs);
                } else {
                    i2c.sPhase = I2cSlavePhase::Ignore; // NACK: a leitura acabou, espera o STOP
                }
            }
            break;
        default:
            break;
    }
}

void i2cReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    s->chip->i2cs[s->index] = {};
    s->chip->i2cs[s->index].apbHz = s->chip->apbHz;
    s->chip->gpioInputRouted.fill(false); // see usartReset()
}

// Offsets reais do periferico I2C do ESP32 (ver hw/i2c/esp32_i2c.h no fork QEMU) -- so' os que o
// Core precisa reconhecer (o resto do mapa de registrador e' tratado 100% dentro do QEMU).
constexpr uint64_t kI2cLowPeriodOffset = 0x00; // dobra como canal de aprendizado do periodo real
constexpr uint64_t kI2cCtrOffset = 0x04;
constexpr uint64_t kI2cStatusOffset = 0x08;
constexpr uint64_t kI2cCmdOffset = 0x58;
constexpr uint64_t kI2cCmdCount = 16;
constexpr uint32_t kI2cCtrTransStartBit = 1u << 5;
constexpr uint32_t kI2cCmdOpcodeShift = 11;
constexpr uint32_t kI2cCmdAckValBit = 1u << 10;
constexpr uint32_t kI2cCmdOpcodeMask = 0x7u;
enum : uint32_t { kI2cOpRstart = 0, kI2cOpWrite = 1, kI2cOpRead = 2, kI2cOpStop = 3 };
// Transacao I2C comandada pelo Core (VNEXT_B: BATCH que o fast path nao pode atender -- ha
// instrumento, pull-up ou dispositivo sem i2c_transfer no barramento). Registradores privados,
// fora do mapa real do periferico. Palavra de operacao: [7:0] byte, [9:8] tipo (I2cOpKind),
// bit 10 NACK (leitura), bit 11 abortar no NACK (escrita); toda operacao assim registra resultado.
constexpr uint64_t kI2cCoreOpOffset = 0xF00;
constexpr uint64_t kI2cCoreResultCountOffset = 0xF04;
constexpr uint64_t kI2cCoreResultOffset = 0xF08;
// Escravo: o evento mais antigo para o QEMU (ver I2cSlavePhase), bit 63 = havia um.
constexpr uint64_t kI2cSlaveEventOffset = 0xF0C;
constexpr uint64_t kI2cSlaveAddrOffset = 0x10;
constexpr uint64_t kI2cFifoConfOffset = 0x18;
constexpr uint64_t kI2cFifoDataOffset = 0x1C;
constexpr uint64_t kI2cSdaHoldOffset = 0x30;
constexpr uint32_t kI2cCtrMsModeBit = 1u << 4;
constexpr uint32_t kI2cFifoConfTxRstBit = 1u << 13;

void i2cKick(I2cState& i2c, uint64_t nowNs);

/* SCL e SDA nao podem mudar no mesmo solve: os PIN_CHANGE de nos distintos nao possuem uma ordem
 * eletrica garantida. Um intervalo minimo separa a descida de SCL da troca de SDA, preservando o
 * mesmo meio-periodo total (salvo clocks patologicos de 1 ns) e evitando START/STOP falsos. */
uint64_t i2cEdgeSettleNs(const I2cState& i2c) {
    return std::max<uint64_t>(1, i2c.halfPeriodNs / 4u);
}
uint64_t i2cLowRemainderNs(const I2cState& i2c) {
    const uint64_t separationNs = i2cEdgeSettleNs(i2c);
    return i2c.halfPeriodNs > separationNs ? i2c.halfPeriodNs - separationNs : 1;
}

void i2cAdvance(I2cState& i2c, uint64_t nowNs) {
    switch (i2c.phase) {
        case I2cPhase::Idle:
            return;

        // ---- START / repeated-START (opcode Restart -- ver I2cOpKind) ----
        case I2cPhase::RestartRelease:
            i2c.sclOutputLevel = false; // primeiro baixa SCL; SDA so muda no proximo solve
            i2c.phase = I2cPhase::RestartDataHigh;
            i2c.dueNs = addDelayNs(nowNs, i2cEdgeSettleNs(i2c));
            return;

        case I2cPhase::RestartDataHigh:
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = true; // solta/sobe SDA -- recria "barramento ocioso"
            i2c.phase = I2cPhase::RestartClockHigh;
            i2c.dueNs = addDelayNs(nowNs, i2cLowRemainderNs(i2c));
            return;

        case I2cPhase::RestartClockHigh:
            i2c.sclOutputLevel = true; // SCL e SDA altos -- precondicao do START satisfeita
            i2c.phase = I2cPhase::StartFall;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::StartFall:
            i2c.sdaOutputLevel = false; // SDA cai com SCL alto -- START/repeated-START completo
            i2c.phase = I2cPhase::StartSettle;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::StartSettle:
            i2c.sclOutputLevel = false; // SCL desce -- pronto pro 1o bit do proximo Write
            i2c.phase = I2cPhase::Idle;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        // ---- WRITE (mestre envia um byte) ----
        case I2cPhase::WriteBitSetup:
            i2c.sclOutputLevel = true; // sobe SCL -- escravo amostra o bit agora
            i2c.phase = I2cPhase::WriteBitHold;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::WriteBitHold:
            i2c.sclOutputLevel = false;
            ++i2c.bitIndex;
            i2c.phase = I2cPhase::WriteBitChange;
            i2c.dueNs = addDelayNs(nowNs, i2cEdgeSettleNs(i2c));
            return;

        case I2cPhase::WriteBitChange:
            if (i2c.bitIndex < 8) {
                i2c.sdaOutputLevel = (i2c.shiftByte & (0x80u >> i2c.bitIndex)) != 0;
                i2c.phase = I2cPhase::WriteBitSetup;
            } else {
                // Libera SDA pro escravo dirigir o ACK -- mesma convencao de
                // devices/simulide-complex/src/lib.c::i2c_clock_bit (so' PUXA pra baixo, nunca
                // dirige alto; depende do pull-up externo do circuito do usuario, igual hardware
                // real e igual o proprio SimulIDE exige).
                i2c.sdaOutputEnabled = false;
                i2c.phase = I2cPhase::WriteAckSetup;
            }
            i2c.dueNs = addDelayNs(nowNs, i2cLowRemainderNs(i2c));
            return;

        case I2cPhase::WriteAckSetup:
            i2c.sclOutputLevel = true; // sobe SCL -- amostra o ACK do escravo em sdaInput a seguir
            i2c.phase = I2cPhase::WriteAckHold;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::WriteAckHold:
            i2c.lastAck = !i2c.sdaInput; // ACK real = SDA puxado pra baixo pelo escravo
            i2c.sclOutputLevel = false;
            i2c.phase = I2cPhase::WriteAckRelease;
            i2c.dueNs = addDelayNs(nowNs, i2cEdgeSettleNs(i2c));
            if (i2c.currentOp.record) {
                i2c.coreResults.push_back((i2c.lastAck ? 1u << 8 : 0u) |
                                          (static_cast<uint32_t>(I2cOpKind::Write) << 9));
            }
            if (!i2c.lastAck && i2c.currentOp.abortOnNack) {
                // NACK com ACK_CHECK_EN: o controlador para de executar comandos; o barramento e'
                // liberado com STOP em vez de seguir mandando bytes que ninguem confirma.
                i2c.pendingOps.clear();
                i2c.pendingOps.push_back(I2cOp{I2cOpKind::Stop});
            }
            return;

        case I2cPhase::WriteAckRelease:
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = true; // retoma controle, idle-alto -- base limpa pro proximo passo
            i2c.phase = I2cPhase::Idle;
            i2c.dueNs = addDelayNs(nowNs, i2cLowRemainderNs(i2c));
            return;

        // ---- READ (mestre recebe um byte do escravo) ----
        case I2cPhase::ReadBitSetup:
            i2c.sclOutputLevel = true; // sobe SCL -- MESTRE amostra SDA (dirigido pelo escravo) agora
            i2c.shiftByte = static_cast<uint8_t>((i2c.shiftByte << 1) | (i2c.sdaInput ? 1u : 0u));
            i2c.phase = I2cPhase::ReadBitHold;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::ReadBitHold:
            i2c.sclOutputLevel = false;
            ++i2c.bitIndex;
            if (i2c.bitIndex < 8) {
                i2c.phase = I2cPhase::ReadBitSetup;
                i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            } else {
                // Mestre agora dirige o ACK/NACK: ACK (mais bytes a seguir) = puxa SDA pra baixo;
                // NACK (ultimo byte da leitura) = libera SDA (sobe via pull-up) -- MESMA convencao
                // open-drain do WRITE acima, so' que quem decide agora e' o ACK_VAL do firmware
                // (I2cOp::nack), nao o escravo.
                i2c.phase = I2cPhase::ReadAckDrive;
                i2c.dueNs = addDelayNs(nowNs, i2cEdgeSettleNs(i2c));
            }
            return;

        case I2cPhase::ReadAckDrive:
            if (i2c.pendingNack) {
                i2c.sdaOutputEnabled = false;
            } else {
                i2c.sdaOutputEnabled = true;
                i2c.sdaOutputLevel = false;
            }
            i2c.phase = I2cPhase::ReadAckSetup;
            i2c.dueNs = addDelayNs(nowNs, i2cLowRemainderNs(i2c));
            return;

        case I2cPhase::ReadAckSetup:
            i2c.sclOutputLevel = true; // sobe SCL -- ACK/NACK do mestre fica visivel no barramento
            i2c.phase = I2cPhase::ReadAckHold;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::ReadAckHold:
            i2c.sclOutputLevel = false;
            i2c.phase = I2cPhase::ReadAckRelease;
            i2c.dueNs = addDelayNs(nowNs, i2cEdgeSettleNs(i2c));
            return;

        case I2cPhase::ReadAckRelease:
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = true; // retoma controle, idle-alto
            i2c.lastReadByte = i2c.shiftByte; // disponibiliza o byte pro readRegister(A_I2C_CMD)
            if (i2c.currentOp.record) {
                i2c.coreResults.push_back(i2c.shiftByte | (i2c.pendingNack ? 0u : 1u << 8) |
                                          (static_cast<uint32_t>(I2cOpKind::Read) << 9));
            }
            i2c.phase = I2cPhase::Idle;
            i2c.dueNs = addDelayNs(nowNs, i2cLowRemainderNs(i2c));
            return;

        // ---- STOP ----
        case I2cPhase::StopSetup:
            i2c.sclOutputLevel = true; // sobe SCL com SDA ainda baixo -- prepara a borda do STOP
            i2c.phase = I2cPhase::StopRise;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cPhase::StopRise:
            i2c.sdaOutputLevel = true; // SDA sobe com SCL alto: STOP completo
            i2c.sclOutputEnabled = false; // barramento livre -- pull-up externo mantem os niveis
            i2c.sdaOutputEnabled = false;
            i2c.phase = I2cPhase::Idle;
            i2c.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;
    }
}

void i2cKick(I2cState& i2c, uint64_t nowNs) {
    if (i2c.phase != I2cPhase::Idle || i2c.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP) return;
    if (i2c.pendingOps.empty()) return;

    const I2cOp op = i2c.pendingOps.front();
    i2c.pendingOps.pop_front();
    i2c.currentOp = op;

    switch (op.kind) {
        case I2cOpKind::Restart:
            i2c.sclOutputEnabled = true;
            i2c.sclOutputLevel = false; // garante SCL baixo antes de soltar SDA (RestartRelease)
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = true;
            i2c.phase = I2cPhase::RestartRelease;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cOpKind::Write:
            i2c.shiftByte = op.byte;
            i2c.bitIndex = 0;
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = (i2c.shiftByte & 0x80u) != 0; // MSB primeiro
            i2c.phase = I2cPhase::WriteBitSetup;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cOpKind::Read:
            i2c.shiftByte = 0;
            i2c.bitIndex = 0;
            i2c.pendingNack = op.nack;
            i2c.sdaOutputEnabled = false; // libera SDA -- o ESCRAVO dirige durante a leitura
            i2c.phase = I2cPhase::ReadBitSetup;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;

        case I2cOpKind::Stop:
            i2c.sdaOutputEnabled = true;
            i2c.sdaOutputLevel = false; // SDA baixo antes de subir -- STOP real
            i2c.phase = I2cPhase::StopSetup;
            i2c.dueNs = addDelayNs(nowNs, i2c.halfPeriodNs);
            return;
    }
}

void i2cWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return;
    I2cState& i2c = s->chip->i2cs[s->index];
    const uint64_t offset = address - i2cStartAddress(s->index);
    const uint32_t data = static_cast<uint32_t>(value);

    if (offset == kI2cLowPeriodOffset) {
        // esp32_i2c_updt_frequency (fork QEMU) espelha aqui o periodo de BIT COMPLETO real (ns),
        // ja' calculado do clock configurado de verdade (LOW_PERIOD/HIGH_PERIOD + APB freq) --
        // aprende de uma vez (fica valendo pras transacoes seguintes), substitui o palpite inicial.
        if (data > 0) i2c.halfPeriodNs = std::max<uint64_t>(1, data / 2u);
        i2c.sclCycles = value >> 32;
        return;
    }
    if (offset == kI2cCoreOpOffset) {
        I2cOp op{static_cast<I2cOpKind>((data >> 8) & 0x3u), static_cast<uint8_t>(data & 0xFFu),
                 (data & (1u << 10)) != 0};
        op.record = op.kind == I2cOpKind::Write || op.kind == I2cOpKind::Read;
        op.abortOnNack = op.kind == I2cOpKind::Write && (data & (1u << 11)) != 0;
        i2c.pendingOps.push_back(op);
        i2cKick(i2c, nowNs);
        return;
    }
    if (offset == kI2cCtrOffset) {
        // O QEMU e o motor eletrico sao assincronos: o proximo TRANS_START pode chegar quando o
        // ultimo STOP/ACK ja terminou no periferico emulado, mas ainda aguarda sua ultima fase no
        // Scheduler do Core. Por isso uma escrita de CTR apenas delimita a transacao logica; nao
        // apaga pendingOps nem a fase fisica atual. Os opcodes espelhados entram no fim da mesma
        // fila e preservam a ordem eletrica do barramento. MS_MODE 0 liga o escravo.
        const bool slave = (data & kI2cCtrMsModeBit) == 0;
        if (slave != i2c.slaveMode) {
            i2c.slaveMode = slave;
            i2c.sPhase = I2cSlavePhase::Idle;
            if (i2c.sSdaLow) i2cSlaveDriveSda(i2c, false, nowNs);
        }
        return;
    }
    if (offset == kI2cSlaveAddrOffset) {
        i2c.slaveAddr = static_cast<uint16_t>(data & 0x7FFFu);
        if (i2cSlaveTraceEnabled()) std::fprintf(stderr, "[I2C-SLAVE] i2c%u SLAVE_ADDR=0x%x\n", s->index, data);
        return;
    }
    if (offset == kI2cSdaHoldOffset) {
        i2c.sdaHoldNs = (uint64_t(data & 0x3FFu) * 1'000'000'000ull) / i2c.apbHz;
        return;
    }
    if (offset == kI2cFifoDataOffset) { // a TX FIFO do escravo
        if (i2c.sTx.size() < 32) i2c.sTx.push_back(static_cast<uint8_t>(data & 0xFFu));
        return;
    }
    if (offset == kI2cFifoConfOffset) {
        if (data & kI2cFifoConfTxRstBit) i2c.sTx.clear();
        return;
    }
    if (offset >= kI2cCmdOffset && offset < kI2cCmdOffset + kI2cCmdCount * 4) {
        const uint32_t opcode = (data >> kI2cCmdOpcodeShift) & kI2cCmdOpcodeMask;
        if (opcode == kI2cOpRstart) {
            i2c.pendingOps.push_back(I2cOp{I2cOpKind::Restart, 0, false});
        } else if (opcode == kI2cOpWrite) {
            i2c.pendingOps.push_back(I2cOp{I2cOpKind::Write, static_cast<uint8_t>(data & 0xFFu), false});
        } else if (opcode == kI2cOpRead) {
            const bool nack = (data & kI2cCmdAckValBit) != 0;
            const uint32_t byteNum = data & 0xFFu;
            for (uint32_t i = 0; i < byteNum && i2c.pendingOps.size() < 64; ++i) {
                i2c.pendingOps.push_back(I2cOp{I2cOpKind::Read, 0, nack});
            }
        } else if (opcode == kI2cOpStop) {
            i2c.pendingOps.push_back(I2cOp{I2cOpKind::Stop, 0, false});
        }
        i2cKick(i2c, nowNs);
    }
}

void i2cWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    i2cWriteRegisterAt(module, address, value, 0);
}

uint64_t i2cReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return 0;
    I2cState& i2c = s->chip->i2cs[s->index];
    const uint64_t offset = address - i2cStartAddress(s->index);
    if (offset == kI2cCoreResultCountOffset) return i2c.coreResults.size();
    if (offset == kI2cSlaveEventOffset) {
        if (i2c.sEvents.empty()) return 0;
        const uint32_t event = i2c.sEvents.front();
        i2c.sEvents.pop_front();
        return event | (uint64_t(1) << 63);
    }
    if (offset == kI2cCoreResultOffset) {
        if (i2c.coreResults.empty()) return 0;
        const uint32_t result = i2c.coreResults.front();
        i2c.coreResults.pop_front();
        return result;
    }
    if (offset == kI2cStatusOffset) {
        // Mesma forma de I2C_STATUS_REG do hardware real (ver hw/i2c/esp32_i2c.h): BUS_BUSY = bit
        // 4, ACK_REC = bit 0 (0 = ACK recebido, 1 = NACK). esp32_i2c_event() (fork QEMU) agora le'
        // este valor de volta pra decidir ACK_ERR de verdade (antes sempre 0/sucesso fixo).
        uint64_t status = 0;
        if (!i2c.pendingOps.empty() || i2c.phase != I2cPhase::Idle) status |= (1u << 4);
        if (!i2c.lastAck) status |= 1u;
        return status;
    }
    if (offset == kI2cCmdOffset) {
        // Canal privado Core<->QEMU (mesmo offset que o WRITE usa pro sentido contrario): byte que
        // o mestre acabou de receber eletricamente na ultima operacao Read completada.
        return i2c.lastReadByte;
    }
    return 0;
}

uint64_t i2cNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    if (s->index >= s->chip->i2cs.size()) return LSDN_QEMU_MODULE_NO_WAKEUP;
    const I2cState& i2c = s->chip->i2cs[s->index];
    return delayUntilNs(std::min(i2c.dueNs, i2c.sSdaDueNs), nowNs);
}
uint64_t i2cNextWakeupDelayNs(LsdnQemuModule* module) { return i2cNextWakeupDelayNsAt(module, 0); }

void i2cOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    if (s->index >= s->chip->i2cs.size()) return;
    I2cState& i2c = s->chip->i2cs[s->index];
    if (i2c.sSdaDueNs != LSDN_QEMU_MODULE_NO_WAKEUP && i2c.sSdaDueNs <= nowNs) {
        i2c.sSdaDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        i2c.sdaOutputEnabled = i2c.sSdaLow; // dreno aberto: so' puxa para baixo
        i2c.sdaOutputLevel = false;
    }
    if (i2c.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP && i2c.dueNs <= nowNs) {
        i2c.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        i2cAdvance(i2c, nowNs);
    }
    i2cKick(i2c, nowNs);
}

int32_t i2cIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return 0;
    if (line == kI2cSclLine) return s->chip->i2cs[s->index].sclOutputEnabled ? 1 : 0;
    if (line == kI2cSdaLine) return s->chip->i2cs[s->index].sdaOutputEnabled ? 1 : 0;
    return 0;
}
int32_t i2cOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return 0;
    if (line == kI2cSclLine) return s->chip->i2cs[s->index].sclOutputLevel ? 1 : 0;
    if (line == kI2cSdaLine) return s->chip->i2cs[s->index].sdaOutputLevel ? 1 : 0;
    return 0;
}
void i2cSetInputLevelAt(LsdnQemuModule* module, uint32_t line, int32_t level, uint64_t nowNs) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size() || (line != kI2cSclLine && line != kI2cSdaLine)) return;
    i2cInputAt(s->chip->i2cs[s->index], s->index, line == kI2cSclLine, level != 0, nowNs);
}
void i2cSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    i2cSetInputLevelAt(module, line, level, 0);
}
void i2cDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<I2cModuleState*>(module);
}

const LsdnQemuModuleVTable kI2cModuleVTable = {
    &i2cReset, &i2cWriteRegister, &i2cReadRegister, &i2cIsOutputEnabled, &i2cOutputLevel,
    &i2cSetInputLevel, &i2cDestroy, &i2cNextWakeupDelayNs, &i2cOnWakeup, &i2cWriteRegisterAt,
    &i2cSetInputLevelAt, &i2cNextWakeupDelayNsAt,
};

void spiReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    s->chip->spis[s->index] = {};
    s->chip->gpioInputRouted.fill(false); // see usartReset()
}

// Offsets reais do periferico SPI do ESP32 (ver hw/ssi/esp32_spi.h no fork QEMU).
constexpr uint64_t kSpiCmdOffset = 0x00;   // A_SPI_CMD -- reaproveitado como marcador real de inicio/fim de transacao (ver esp32_spi.c)
constexpr uint64_t kSpiClockOffset = 0x18; // SPI_CLOCK_REG (sem REG32 nomeado no header -- ver write_clk_reg)
constexpr uint64_t kSpiPinOffset = 0x34;   // A_SPI_PIN -- CS0_DIS/CS0_POL reais
constexpr uint64_t kSpiDataOffset = 0x80;  // A_SPI_W0 -- primeira palavra do buffer de dados
// Canal privado: le (e consome) o proximo byte recebido no MISO, 0 se nao ha nenhum.
constexpr uint64_t kSpiRxOffset = 0xF80;
constexpr uint64_t kSpiMisoByteOffset = 0xF84;
constexpr uint32_t kSpiRxCaptureBit = 1u << 8;
constexpr uint32_t kSpiNoClockBit = 1u << 13;
constexpr uint32_t kSpiCphaBit = 1u << 14;
constexpr uint32_t kSpiCkIdleEdgeBit = 1u << 29; // SPI_PIN.CK_IDLE_EDGE: o SCK ocioso em alto (CPOL)
constexpr uint32_t kSpiCs0DisBit = 1u << 0;
// Posicao do bit de polaridade de CS0 no SPI_PIN_REG real do ESP32 -- a referencia local disponivel
// (SimulIDE/qemu_lasecSimul) nao expoe FIELD() nomeado pra isto (so' CS_DIS nos bits 0-2 e' usado
// de fato pelo proprio esp32_spi.c, ver esp32_spi_reset() pin_reg=0x6). bit13 e' o melhor palpite
// documentado sem o TRM completo em maos -- so' importa se algum firmware realmente configurar
// polaridade nao-padrao (raro: toda biblioteca observada usa o default ativo-baixo, que nao
// depende deste bit nunca ter sido escrito).
constexpr uint32_t kSpiCs0PolBit = 1u << 13;

// CS0 automatico: SPI_PIN_REG (CS0_DIS/POL) + o marcador real de inicio/fim de transacao (ver
// A_SPI_CMD acima) -- recomputado sempre que qualquer um dos dois muda, nunca lido "ao vivo" nos
// getters (mesmo padrao dos outros campos de saida deste adaptador, todos pre-computados).
void spiUpdateCs0(SpiState& spi) {
    const bool disabled = (spi.pinReg & kSpiCs0DisBit) != 0;
    const bool activeHigh = (spi.pinReg & kSpiCs0PolBit) != 0;
    spi.cs0OutputEnabled = !disabled;
    spi.cs0OutputLevel = spi.csAsserted ? activeHigh : !activeHigh;
}

void spiKick(Esp32SharedState& chip, uint32_t index, uint64_t nowNs);

// mcu_abi.h 3.3: o SPI `index` transmite o byte sem bordas quando o clock e o MOSI dele saem, cada
// um, por exatamente um pad dirigido (nem open-drain), e esse par foi declarado pelo Core (fios so'
// com escravos que aceitam bytes inteiros). Reavaliado a cada byte: o roteamento muda em runtime.
bool spiBytePairFor(const Esp32SharedState& chip, uint32_t index, uint32_t& clockPin, uint32_t& dataPin);

// LASECSIMUL_SPI_ENGINE_TRACE=1: cada byte do motor SPI (chegada, início no fio) e o CS de hardware.
bool spiEngineTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_SPI_ENGINE_TRACE");
        return value != nullptr && value[0] != 0 && std::strcmp(value, "0") != 0;
    }();
    return enabled;
}

// Instante da borda `edge` (1..16, uma a cada meio periodo) do byte em curso. O periodo vem em ps
// e cada borda e' arredondada uma unica vez a partir do inicio do byte, nunca somada a anterior: a
// 80 MHz (12,5 ns) o SCK sai a 80 MHz na media e o byte dura 100 ns, em vez de 12 ns por bit
// (83 MHz); uma borda atrasada tambem nao empurra as seguintes.
uint64_t spiEdgeDueNs(const SpiState& spi, uint32_t edge) {
    return addDelayNs(spi.byteStartNs, (edge * spi.bitPeriodPs / 2u + 500u) / 1000u);
}

// Fim do pedaco: o que o MISO trouxe fica pronto para o Core levar ao QEMU. Sem teto pequeno: num DMA
// longo milhares de bytes esperam aqui entre duas sincronizacoes, e o QEMU segura o fim da transacao ate'
// chegarem todos (esp32_spi_finish).
void spiFinishRx(SpiState& spi) {
    if (spi.captureRx && spi.rxBytes.size() < (1u << 20))
        spi.rxBytes.push_back(spi.rxShift | kSpiRxCaptureBit | (static_cast<uint32_t>(spi.rxIndex) << 16));
    spi.captureRx = false;
}

bool spiCpol(const SpiState& spi) { return (spi.pinReg & kSpiCkIdleEdgeBit) != 0; }

// Uma borda do pedaco em curso. SCK sai de CPOL e volta a ele: as bordas impares sao as de ida
// ("leading"), as pares as de volta. Com CPHA 0 o bit ja' esta' no MOSI antes da primeira borda, a de ida
// captura e a de volta poe o proximo bit; com CPHA 1 a de ida poe o bit e a de volta captura (ESP32 TRM:
// CK_IDLE_EDGE da' o CPOL e CK_OUT_EDGE xor CK_IDLE_EDGE o CPHA).
void spiAdvance(SpiState& spi) {
    switch (spi.phase) {
        case SpiPhase::Idle:
            return;

        case SpiPhase::Edges: {
            const uint32_t k = ++spi.edge;
            const uint32_t bit = (k - 1u) / 2u;
            const bool leading = (k & 1u) != 0;
            if (!spi.noClock) {
                spi.clkOutputLevel = leading != spiCpol(spi);
                if (leading == !spi.cpha) {
                    // Borda de captura: o escravo amostra o MOSI e o mestre o MISO (que o escravo ainda
                    // nao mudou nesta borda).
                    if (spi.captureRx && spi.misoInput) spi.rxShift = static_cast<uint8_t>(spi.rxShift | (0x80u >> bit));
                } else {
                    const uint32_t next = spi.cpha ? bit : bit + 1u;
                    if (next < spi.chunkBits) spi.mosiOutputLevel = (spi.shiftByte & (0x80u >> next)) != 0;
                }
            }
            if (k >= 2u * spi.chunkBits) {
                spiFinishRx(spi);
                spi.phase = SpiPhase::Idle;
                spi.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            } else {
                spi.dueNs = spiEdgeDueNs(spi, k + 1u);
            }
            if (spiEngineTraceEnabled())
                std::fprintf(stderr, "[SPI_ENGINE] edge %u sck=%d mosi=%d next=%llu\n", k, spi.clkOutputLevel ? 1 : 0,
                             spi.mosiOutputLevel ? 1 : 0, static_cast<unsigned long long>(spi.dueNs));
            return;
        }

        case SpiPhase::SilentLastEdge:
            // Instante da 8a borda de subida, quando o escravo fecharia o byte no fio. Sem bordas o
            // escravo nao desloca nada: as 8 amostras do MISO sao o nivel parado dele.
            spi.tap.push_back(SpiTapByte{spi.shiftByte, spi.silentClockPin, spi.silentDataPin});
            if (spi.captureRx) spi.rxShift = spi.misoInput ? 0xFFu : 0x00u;
            spi.phase = SpiPhase::SilentEnd;
            spi.dueNs = spiEdgeDueNs(spi, 16u);
            return;

        case SpiPhase::SilentEnd:
            spiFinishRx(spi);
            spi.phase = SpiPhase::Idle;
            spi.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;
    }
}

bool spiMisoInputMatches(const Esp32SharedState& chip, uint32_t pin, uint32_t index) {
    const SignalDesc direct = selectedDirectInputSignal(chip, pin);
    if (direct.kind == SignalKind::SpiMiso && direct.index == index) return true;
    for (uint32_t func = 0; func < chip.matrixInRegs.size(); ++func) {
        if ((chip.matrixInRegs[func] & 0x3Fu) != pin) continue;
        const SignalDesc matrix = matrixInputSignal(func);
        if (matrix.kind == SignalKind::SpiMiso && matrix.index == index) return true;
    }
    return false;
}

bool spiBytePairFor(const Esp32SharedState& chip, uint32_t index, uint32_t& clockPin, uint32_t& dataPin) {
    if (chip.spiBytePairs.empty()) return false;
    int clockPads = 0, dataPads = 0;
    for (uint32_t pin = 0; pin < 40; ++pin) {
        const SignalDesc signal = selectedPinOutputSignal(chip, pin);
        if (signal.index != index) continue;
        if (signal.kind == SignalKind::SpiClk) {
            clockPin = pin;
            ++clockPads;
        } else if (signal.kind == SignalKind::SpiMosi) {
            dataPin = pin;
            ++dataPads;
        }
    }
    if (clockPads != 1 || dataPads != 1) return false;
    for (const uint32_t pin : {clockPin, dataPin})
        if (!gpioPadOutput(chip, pin).enabled || gpioIsPadDriverOpenDrain(chip, pin)) return false;
    for (const SpiBytePairPins& pair : chip.spiBytePairs) {
        if (pair.clock != clockPin || pair.data != dataPin) continue;
        if (pair.miso != UINT32_MAX && !spiMisoInputMatches(chip, pair.miso, index)) return false;
        return true;
    }
    return false;
}

void spiKick(Esp32SharedState& chip, uint32_t index, uint64_t nowNs) {
    SpiState& spi = chip.spis[index];
    if (spi.phase != SpiPhase::Idle || spi.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP) return;
    if (spi.pendingBytes.empty()) return;

    const uint32_t mirrored = spi.pendingBytes.front();
    spi.pendingBytes.pop_front();
    spi.shiftByte = static_cast<uint8_t>(mirrored & 0xFFu);
    spi.captureRx = (mirrored & kSpiRxCaptureBit) != 0;
    spi.chunkBits = static_cast<uint8_t>(8u - ((mirrored >> 9) & 7u));
    spi.noClock = (mirrored & kSpiNoClockBit) != 0;
    spi.cpha = (mirrored & kSpiCphaBit) != 0;
    spi.rxIndex = static_cast<uint16_t>(mirrored >> 16);
    spi.rxShift = 0;
    if (spiEngineTraceEnabled())
        std::fprintf(stderr, "[SPI_ENGINE] start byte=%02x at=%llu period_ps=%llu queued=%zu\n", spi.shiftByte,
                     static_cast<unsigned long long>(nowNs), static_cast<unsigned long long>(spi.bitPeriodPs),
                     spi.pendingBytes.size());
    spi.edge = 0;
    spi.byteStartNs = nowNs;
    spi.clkOutputEnabled = true;
    spi.mosiOutputEnabled = true;
    // Sem bordas so' o byte inteiro em MODE0 com clock: e' o que os escravos de byte inteiro esperam.
    if (spi.chunkBits == 8 && !spi.cpha && !spi.noClock && !spiCpol(spi) &&
        spiBytePairFor(chip, index, spi.silentClockPin, spi.silentDataPin)) {
        // Sem bordas: os pads ficam no nivel atual; 8a borda de subida na 15a borda, como abaixo
        // (meio periodo ate' a 1a, um periodo entre elas).
        spi.phase = SpiPhase::SilentLastEdge;
        spi.dueNs = spiEdgeDueNs(spi, 15u);
        return;
    }
    spi.clkOutputLevel = spiCpol(spi);
    if (!spi.cpha && !spi.noClock) spi.mosiOutputLevel = (spi.shiftByte & 0x80u) != 0; // o 1o bit antes da 1a borda
    spi.phase = SpiPhase::Edges;
    if (spi.noClock) { // dummy com USR_DUMMY_IDLE: o tempo dos ciclos passa sem SCK nem MOSI
        spi.edge = static_cast<uint8_t>(2u * spi.chunkBits - 1u);
        spi.dueNs = spiEdgeDueNs(spi, 2u * spi.chunkBits);
        return;
    }
    spi.dueNs = spiEdgeDueNs(spi, 1u);
}

void spiWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return;
    SpiState& spi = s->chip->spis[s->index];
    const uint64_t offset = address - spiStartAddress(s->index);

    if (spiEngineTraceEnabled())
        std::fprintf(stderr, "[SPI_ENGINE] write off=%02llx value=%llx at=%llu phase=%d\n",
                     static_cast<unsigned long long>(offset), static_cast<unsigned long long>(value),
                     static_cast<unsigned long long>(nowNs), static_cast<int>(spi.phase));
    if (offset == kSpiCmdOffset) {
        // esp32_spi.c espelha 1 (inicio) antes do 1o byte de uma transacao HSPI/VSPI (numero>=2) e
        // 0 (fim) quando o ultimo byte termina -- bracket automatico real ao redor de QUALQUER
        // comando USR, sem depender de nenhuma biblioteca/firmware especifico.
        spi.csAsserted = value != 0;
        spiUpdateCs0(spi);
        return;
    }
    if (offset == kSpiClockOffset) {
        // esp32_spi.c::write_clk_reg ja' converte pro periodo de UM bit em picossegundos antes de
        // espelhar aqui.
        if (value > 0) spi.bitPeriodPs = static_cast<uint64_t>(value);
        return;
    }
    if (offset == kSpiPinOffset) {
        // esp32_spi.c espelha TODA escrita de SPI_PIN_REG (CS0_DIS/CS0_POL e CK_IDLE_EDGE reais). O
        // periferico configurado ja' dirige o SCK no nivel ocioso.
        spi.pinReg = static_cast<uint32_t>(value);
        spiUpdateCs0(spi);
        if (spi.phase == SpiPhase::Idle) {
            spi.clkOutputLevel = spiCpol(spi);
            spi.clkOutputEnabled = true;
        }
        return;
    }
    if (offset == kSpiDataOffset) {
        // esp32_spi.c (numero>=2, HSPI/VSPI) espelha UM byte por vez, ja' pausado pelo timer
        // interno do proprio QEMU (esp32_spi_event) -- SPI0/SPI1 (flash/PSRAM onboard) nunca
        // chegam aqui, resolvidos 100% dentro do QEMU via ssi_transfer interno. O valor traz, alem
        // do byte, se o MISO dele deve ser amostrado e onde o QEMU o guarda (ver SpiState).
        if (spi.pendingBytes.size() < 64) spi.pendingBytes.push_back(static_cast<uint32_t>(value));
        spiKick(*s->chip, s->index, nowNs);
        return;
    }
    if (offset == kSpiMisoByteOffset) {
        // Resposta byte-a-byte do Core, calculada pelo escravo no fim do ultimo clock sem bordas.
        spi.rxShift = static_cast<uint8_t>(value);
    }
}

void spiWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    spiWriteRegisterAt(module, address, value, 0);
}

uint64_t spiReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size() || address - spiStartAddress(s->index) != kSpiRxOffset) return 0;
    std::deque<uint32_t>& rx = s->chip->spis[s->index].rxBytes;
    if (rx.empty()) return 0;
    const uint32_t value = rx.front();
    rx.pop_front();
    return value;
}

uint64_t spiNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    if (s->index >= s->chip->spis.size()) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return delayUntilNs(s->chip->spis[s->index].dueNs, nowNs);
}
uint64_t spiNextWakeupDelayNs(LsdnQemuModule* module) { return spiNextWakeupDelayNsAt(module, 0); }

void spiOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    if (s->index >= s->chip->spis.size()) return;
    SpiState& spi = s->chip->spis[s->index];
    if (spi.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP && spi.dueNs <= nowNs) {
        spi.dueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        spiAdvance(spi);
    }
    spiKick(*s->chip, s->index, nowNs);
}

int32_t spiIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return 0;
    const SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: return spi.clkOutputEnabled ? 1 : 0;
        case kSpiMisoLine: return spi.misoOutputEnabled ? 1 : 0;
        case kSpiMosiLine: return spi.mosiOutputEnabled ? 1 : 0;
        case kSpiCs0Line: return spi.cs0OutputEnabled ? 1 : 0;
        default: return 0;
    }
}
int32_t spiOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return 0;
    const SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: return spi.clkOutputLevel ? 1 : 0;
        case kSpiMisoLine: return spi.misoOutputLevel ? 1 : 0;
        case kSpiMosiLine: return spi.mosiOutputLevel ? 1 : 0;
        case kSpiCs0Line: return spi.cs0OutputLevel ? 1 : 0;
        default: return 0;
    }
}
void spiSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return;
    SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: spi.clkInput = level != 0; break;
        case kSpiMisoLine: spi.misoInput = level != 0; break;
        case kSpiMosiLine: spi.mosiInput = level != 0; break;
        case kSpiCs0Line: spi.cs0Input = level != 0; break;
        default: break;
    }
}
void spiDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<SpiModuleState*>(module);
}

int32_t spiDrainSpiByte(LsdnQemuModule* module, uint8_t* outByte, uint32_t* outClockPin, uint32_t* outDataPin) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return 0;
    std::deque<SpiTapByte>& tap = s->chip->spis[s->index].tap;
    if (tap.empty() || !outByte || !outClockPin || !outDataPin) return 0;
    *outByte = tap.front().byte;
    *outClockPin = tap.front().clockPin;
    *outDataPin = tap.front().dataPin;
    tap.pop_front();
    return 1;
}

const LsdnQemuModuleVTable kSpiModuleVTable = {
    &spiReset, &spiWriteRegister, &spiReadRegister, &spiIsOutputEnabled, &spiOutputLevel,
    &spiSetInputLevel, &spiDestroy, &spiNextWakeupDelayNs, &spiOnWakeup, &spiWriteRegisterAt,
    nullptr, &spiNextWakeupDelayNsAt,
    nullptr, // set_input_voltage_at
    nullptr, // drain_monitor_byte
    nullptr, // monitor_dropped_count
    nullptr, // inject_rx_bytes
    nullptr, // get_pull_state
    nullptr, // drain_wire_tap_byte
    nullptr, // get_pin_states
    nullptr, // set_input_voltages_at
    &spiDrainSpiByte,
};

bool selectedAdcChannel(uint32_t value, uint8_t& channel) {
    const uint32_t mask = (value & 0x7FF80000u) >> 19u;
    if (mask == 0) return false;
    for (uint8_t bit = 0; bit < 16; ++bit) {
        if ((mask & (1u << bit)) != 0) {
            channel = bit;
            return true;
        }
    }
    return false;
}

int adcChannelToGpio(bool adc2, uint8_t channel) {
    static constexpr std::array<int, 8> kAdc1Gpio = {36, 37, 38, 39, 32, 33, 34, 35};
    static constexpr std::array<int, 10> kAdc2Gpio = {4, 0, 2, 15, 13, 12, 14, 27, 25, 26};
    if (!adc2) return channel < kAdc1Gpio.size() ? kAdc1Gpio[channel] : -1;
    return channel < kAdc2Gpio.size() ? kAdc2Gpio[channel] : -1;
}

uint16_t adcRawFromVoltage(double voltage) {
    // Modelo eletrico inicial: 12 bits no intervalo nominal 0..3,3 V. A nao-linearidade e as
    // curvas por atenuacao do ADC real podem ser acrescentadas depois sem mudar a ABI.
    const double clamped = std::clamp(voltage, 0.0, 3.3);
    return static_cast<uint16_t>(std::lround(clamped * 4095.0 / 3.3));
}

// Canal privado do sensor de toque (ver TouchState). Escrita: o QEMU comecou uma medicao --
// (numero do pedido << 16) | canais do SENS. Leitura: a capacitancia externa de cada canal (0,1 pF) e o
// numero do ultimo pedido ja' medido, que o Core publica no snapshot.
constexpr uint64_t kTouchProbeOffset = 0x380;
constexpr uint64_t kTouchCapOffset = 0x384;  // + 4 * canal
constexpr uint64_t kTouchDoneOffset = 0x3AC;

// ceil(a * b / d), com o produto em 128 bits (o quociente cabe em 64).
uint64_t mulDivCeil(uint64_t a, uint64_t b, uint64_t d) {
#if defined(_MSC_VER) && !defined(__clang__)
    uint64_t hi = 0;
    const uint64_t lo = _umul128(a, b, &hi);
    const uint64_t sum = lo + (d - 1);
    if (sum < lo) ++hi;
    uint64_t rem = 0;
    return _udiv128(hi, sum, d, &rem);
#else
    return static_cast<uint64_t>((static_cast<unsigned __int128>(a) * b + d - 1) / d);
#endif
}

constexpr uint64_t kI2sAdcT0Offset = 0x3C0, kI2sAdcNumOffset = 0x3C4, kI2sAdcCommitOffset = 0x3C8,
                   kI2sAdcPadsOffset = 0x3CC, kI2sAdcSamplesOffset = 0x3D0;
constexpr size_t kI2sAdcMaxPending = 1u << 16;

void i2sAdcAdvance(Esp32SharedState& chip, uint64_t nowNs) {
    I2sAdcSampler& a = chip.i2sAdc;
    while (a.on && a.dueNs <= nowNs) {
        const int gpio = adcChannelToGpio(a.unit != 0, a.pads[a.next % a.len]);
        double volts = 0.0;
        if (gpio >= 0 && static_cast<size_t>(gpio) < chip.gpioVoltages.size()) volts = chip.gpioVoltages[static_cast<size_t>(gpio)];
        if (a.out.size() < kI2sAdcMaxPending) a.out.push_back(static_cast<uint16_t>(std::lround(std::clamp(volts, 0.0, 6.5535) * 10000.0)));
        ++a.next;
        a.dueNs = a.t0 + mulDivCeil(a.next, a.num, a.den);
    }
}

void adcReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    s->channel1 = 0;
    s->channel2 = 0;
    s->chip->i2sAdc = I2sAdcSampler{};
    s->chip->touch = TouchState{};
    for (const uint32_t gpio : kTouchChannelGpio) s->chip->analogDrive[gpio].active = false;
}

void adcWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    const uint64_t offset = address - kAdcStart;
    if (offset == kTouchProbeOffset) {
        touchStartProbe(*s->chip, static_cast<uint32_t>(value) & 0x3FFu, static_cast<uint32_t>(value >> 16) & 0xFFFFu, nowNs);
        return;
    }
    I2sAdcSampler& sampler = s->chip->i2sAdc;
    if (offset == kI2sAdcT0Offset) { sampler.stagedT0 = value; return; }
    if (offset == kI2sAdcNumOffset) { sampler.stagedNum = value ? value : 1; return; }
    if (offset == kI2sAdcPadsOffset) { sampler.stagedPads = value; return; }
    if (offset == kI2sAdcCommitOffset) { // o I2S comecou (ou mudou) ou parou de receber
        i2sAdcAdvance(*s->chip, nowNs);
        sampler.on = (value >> 63) != 0;
        sampler.t0 = sampler.stagedT0;
        sampler.num = sampler.stagedNum;
        sampler.den = std::max<uint64_t>(value & ((uint64_t(1) << 40) - 1), 1);
        sampler.len = static_cast<uint32_t>((value >> 56) & 0xFu) + 1;
        sampler.unit = static_cast<uint32_t>((value >> 60) & 1u);
        for (size_t i = 0; i < sampler.pads.size(); ++i) sampler.pads[i] = static_cast<uint8_t>((sampler.stagedPads >> (4 * i)) & 0xFu);
        sampler.next = 0;
        sampler.dueNs = sampler.on ? sampler.t0 : LSDN_QEMU_MODULE_NO_WAKEUP;
        i2sAdcAdvance(*s->chip, nowNs);
        return;
    }
    // O ESP-IDF escreve o registrador START diversas vezes durante uma conversao. Algumas
    // dessas escritas alteram apenas START/FORCE e deixam o bitmap de canais zerado. Nesse
    // caso o canal previamente selecionado precisa ser preservado; zerar para ADC1_CH0 fazia
    // uma leitura valida ser seguida por GPIO36=0 V e analogRead() acabava retornando zero.
    if (offset == 0x54) {
        selectedAdcChannel(static_cast<uint32_t>(value), s->channel1);
    } else if (offset == 0x94) {
        selectedAdcChannel(static_cast<uint32_t>(value), s->channel2);
    }
}

void adcWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    adcWriteRegisterAt(module, address, value, 0);
}

uint64_t adcNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    const Esp32SharedState& chip = *reinterpret_cast<AdcModuleState*>(module)->chip;
    return delayUntilNs(std::min(chip.touch.dueNs, chip.i2sAdc.dueNs), nowNs);
}

void adcOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    Esp32SharedState& chip = *reinterpret_cast<AdcModuleState*>(module)->chip;
    touchAdvance(chip, nowNs);
    i2sAdcAdvance(chip, nowNs);
}

// Canal privado do VNEXT_B: tensao do pad do canal `i` de ADC (0..7 = ADC1_CH0..7, 8..17 = ADC2_CH0..9),
// em decimos de mV. O Core a publica no snapshot e o modelo SENS do QEMU aplica a funcao de transferencia
// do chip (atenuacao, largura, inversao) com os registradores que ele mesmo guarda.
constexpr uint64_t kAdcPadVoltageOffset = 0x300;
constexpr uint32_t kAdcPadCount = 18;

uint64_t adcReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    const uint64_t offset = address - kAdcStart;
    if (offset >= kAdcPadVoltageOffset && offset < kAdcPadVoltageOffset + 4u * kAdcPadCount) {
        const uint32_t pad = static_cast<uint32_t>((offset - kAdcPadVoltageOffset) / 4u);
        const int gpio = pad < 8 ? adcChannelToGpio(false, static_cast<uint8_t>(pad))
                                 : adcChannelToGpio(true, static_cast<uint8_t>(pad - 8));
        if (gpio < 0 || static_cast<size_t>(gpio) >= s->chip->gpioVoltages.size()) return 0;
        const double volts = std::clamp(s->chip->gpioVoltages[static_cast<size_t>(gpio)], 0.0, 6.5535);
        return static_cast<uint64_t>(std::lround(volts * 10000.0));
    }
    if (offset >= kTouchCapOffset && offset < kTouchCapOffset + 4u * s->chip->touch.channels.size())
        return s->chip->touch.channels[(offset - kTouchCapOffset) / 4u].capTenthsPf;
    if (offset == kTouchDoneOffset) return s->chip->touch.doneSeq;
    if (offset == kI2sAdcSamplesOffset) { // ate' tres amostras [15:0] [31:16] [47:32], quantas [50:48], valido 63
        std::deque<uint16_t>& out = s->chip->i2sAdc.out;
        if (out.empty()) return 0;
        uint64_t v = 0;
        unsigned n = 0;
        for (; n < 3 && !out.empty(); ++n) {
            v |= uint64_t(out.front()) << (16 * n);
            out.pop_front();
        }
        return v | (uint64_t(n) << 48) | (uint64_t(1) << 63);
    }
    const bool adc2 = offset == 0x94;
    if (offset != 0x54 && !adc2) return 0;
    const int gpio = adcChannelToGpio(adc2, adc2 ? s->channel2 : s->channel1);
    if (gpio < 0 || static_cast<size_t>(gpio) >= s->chip->gpioVoltages.size()) return 0;
    return adcRawFromVoltage(s->chip->gpioVoltages[static_cast<size_t>(gpio)]);
}

void adcDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<AdcModuleState*>(module);
}

const LsdnQemuModuleVTable kAdcModuleVTable = {
    &adcReset, &adcWriteRegister, &adcReadRegister, nullptr, nullptr, nullptr, &adcDestroy,
    nullptr, &adcOnWakeup, &adcWriteRegisterAt, nullptr, &adcNextWakeupAt,
};

constexpr uint32_t kLedcConf0SigOutEn = 1u << 2;
constexpr uint32_t kLedcConf0IdleLv = 1u << 3;
constexpr uint32_t kLedcConf1DutyStart = 1u << 31;
constexpr uint32_t kLedcTimerResMask = 0x1Fu;
constexpr uint32_t kLedcTimerPause = 1u << 23;
constexpr uint32_t kLedcTimerRst = 1u << 24;
constexpr uint32_t kLedcTimerTickSel = 1u << 25;
constexpr uint32_t kLedcLsTimerParaUp = 1u << 26;
constexpr uint32_t kLedcConfApbClkSel = 1u << 0;
constexpr uint64_t kLedcTimerOffset = 0x140;
constexpr uint64_t kLedcConfOffset = 0x190;

uint32_t ledcChannelTimer(uint32_t channel, uint32_t conf0) {
    return (conf0 & 0x3u) + (channel >= 8 ? 4u : 0u);
}

// Duracao de um tick do contador: o divisor e' 10.8 em ponto fixo; o clock e' REF_TICK (1 MHz) sem
// TICK_SEL; com TICK_SEL, APB_CLK (80 MHz) nos timers de alta velocidade e SLOW_CLK nos de baixa --
// APB_CLK se LEDC_CONF.APB_CLK_SEL, senao RC_FAST (8 MHz nominais).
long double ledcTickNs(const LedcState& ledc, uint32_t timer, uint32_t config) {
    const uint32_t dividerFixed8 = (config >> 5u) & 0x3FFFFu;
    if (dividerFixed8 == 0) return 0;
    long double sourceHz = 1.0e6L;
    if ((config & kLedcTimerTickSel) != 0) {
        sourceHz = timer < 4 || (ledc.confReg & kLedcConfApbClkSel) != 0 ? static_cast<long double>(ledc.apbHz) : 8.0e6L;
    }
    return (static_cast<long double>(dividerFixed8) / 256.0L) * 1.0e9L / sourceHz;
}

// PAUSE e RST agem na hora (inclusive nos timers de baixa velocidade, que o ESP-IDF reseta com
// RST=1/RST=0 antes do PARA_UP); resolucao, divisor e clock so quando `parameters`.
void ledcApplyTimerConfig(LedcState& ledc, uint32_t timer, uint32_t config, uint64_t nowNs, bool parameters) {
    LedcTimer& t = ledc.timers[timer];
    const uint32_t previous = t.config;
    if ((config & kLedcTimerPause) != 0 && !t.paused) {
        t.paused = true;
        t.pausedAtNs = nowNs;
    } else if ((config & kLedcTimerPause) == 0 && t.paused) {
        t.paused = false;
        if (nowNs > t.pausedAtNs) t.epochNs += nowNs - t.pausedAtNs; // continua de onde parou
    }
    // RST segura o contador em 0; ao sair do reset ele recomeca a contar a partir deste instante.
    if ((config & kLedcTimerRst) != 0 || (previous & kLedcTimerRst) != 0) t.epochNs = nowNs;
    constexpr uint32_t kControlBits = kLedcTimerPause | kLedcTimerRst;
    if (!parameters) {
        t.config = (previous & ~kControlBits) | (config & kControlBits);
        return;
    }
    t.config = config & ~kLedcLsTimerParaUp;
    t.resolution = config & kLedcTimerResMask;
    t.tickNs = ledcTickNs(ledc, timer, config);
}

struct LedcPeriodShape {
    bool constant = true;   // nivel fixo durante todo o periodo
    bool level = false;     // nivel quando `constant`
    long double highStartNs = 0, highEndNs = 0;  // relativos ao inicio do periodo (end pode passar do periodo)
};

// Forma do periodo `period` do canal: alto de HPOINT ate HPOINT+DUTY ticks. A parte fracionaria do
// duty (4 bits) vira um tick extra em `frac` de cada 16 periodos, distribuido uniformemente.
LedcPeriodShape ledcPeriodShape(const LedcChannel& c, const LedcTimer& t, uint64_t period) {
    LedcPeriodShape shape;
    const uint64_t fullScale = uint64_t(1) << t.resolution;
    const uint64_t frac = c.duty & 0xFu;
    const uint64_t dutyTicks = (c.duty >> 4u) + ((period + 1) * frac / 16u - period * frac / 16u);
    if (dutyTicks == 0) return shape;
    if (dutyTicks >= fullScale) {
        shape.level = true;
        return shape;
    }
    const uint64_t hpoint = c.hpoint & (fullScale - 1u);
    shape.constant = false;
    shape.highStartNs = static_cast<long double>(hpoint) * t.tickNs;
    shape.highEndNs = static_cast<long double>(hpoint + dutyTicks) * t.tickNs;
    return shape;
}

// Duty depois de `steps` passos do fade: DUTY_SCALE move a parte inteira (acima dos 4 bits
// fracionarios), para cima com DUTY_INC.
uint32_t ledcFadeDuty(const LedcChannel& c, uint64_t steps) {
    const int64_t delta = static_cast<int64_t>(steps) * (static_cast<int64_t>(c.fadeConf1 & 0x3FFu) << 4u);
    const int64_t duty = (c.fadeConf1 & (1u << 30u)) != 0 ? static_cast<int64_t>(c.fadeStartDuty) + delta
                                                          : static_cast<int64_t>(c.fadeStartDuty) - delta;
    return static_cast<uint32_t>(std::clamp<int64_t>(duty, 0, 0x1FFFFFF));
}

// Recalcula nivel e proxima borda do canal no instante `nowNs`.
void ledcEvaluateChannel(LedcState& ledc, uint32_t channel, uint64_t nowNs) {
    LedcChannel& c = ledc.channels[channel];
    ledc.nextEdgeNs[channel] = 0;
    if ((c.conf0 & kLedcConf0SigOutEn) == 0) {
        ledc.outputLevel[channel] = (c.conf0 & kLedcConf0IdleLv) != 0;
        return;
    }
    const LedcTimer& t = ledc.timers[ledcChannelTimer(channel, c.conf0)];
    if (t.resolution == 0 || t.tickNs <= 0) {
        ledc.outputLevel[channel] = false;
        return;
    }
    const long double periodNs = t.tickNs * static_cast<long double>(uint64_t(1) << t.resolution);
    const bool frozen = t.paused || (t.config & kLedcTimerRst) != 0;
    const uint64_t at = frozen ? ((t.config & kLedcTimerRst) != 0 ? t.epochNs : t.pausedAtNs) : nowNs;
    const long double elapsed = at > t.epochNs ? static_cast<long double>(at - t.epochNs) : 0.0L;
    const uint64_t period = static_cast<uint64_t>(elapsed / periodNs);
    const long double phase = elapsed - static_cast<long double>(period) * periodNs;

    // DUTY_START pedido num periodo vale a partir do estouro seguinte do contador; dali o duty anda
    // DUTY_SCALE a cada DUTY_CYCLE periodos, DUTY_NUM vezes.
    if (c.updatePending && period > c.updateAfterPeriod) {
        c.hpoint = c.hpointReg;
        c.updatePending = false;
        c.fadeActive = true;
    }
    if (c.fadeActive) {
        const uint64_t first = c.updateAfterPeriod + 1u;
        const uint32_t num = (c.fadeConf1 >> 20u) & 0x3FFu;
        const uint32_t cycle = (c.fadeConf1 >> 10u) & 0x3FFu;
        const uint64_t steps = cycle == 0 ? num : std::min<uint64_t>(num, (period - first) / cycle);
        c.duty = ledcFadeDuty(c, steps);
        if (steps >= num) c.fadeActive = false;
    }

    const LedcPeriodShape shape = ledcPeriodShape(c, t, period);
    bool level = shape.level;
    if (!shape.constant) {
        level = shape.highEndNs <= periodNs
            ? phase >= shape.highStartNs && phase < shape.highEndNs
            : phase >= shape.highStartNs || phase < shape.highEndNs - periodNs;
    }
    ledc.outputLevel[channel] = level;
    if (frozen) return;

    // Proxima mudanca possivel: bordas deste periodo ou o estouro do contador (onde o duty pode
    // mudar por dithering ou por uma atualizacao pendente, e onde a forma recomeca).
    long double nextPhase = periodNs;
    if (!shape.constant) {
        const long double wrappedEnd = shape.highEndNs <= periodNs ? shape.highEndNs : shape.highEndNs - periodNs;
        for (const long double edge : {shape.highStartNs, wrappedEnd}) {
            if (edge > phase && edge < nextPhase) nextPhase = edge;
        }
    } else if ((c.duty & 0xFu) == 0 && !c.updatePending && !c.fadeActive) {
        return; // nivel constante e nada vai mudar no proximo periodo: nenhuma borda a agendar
    }
    const long double delta = std::max<long double>(1.0L, nextPhase - phase);
    ledc.nextEdgeNs[channel] = addDelayNs(nowNs, static_cast<uint64_t>(std::ceil(delta)));
}

void ledcEvaluateTimerChannels(LedcState& ledc, uint32_t timer, uint64_t nowNs) {
    for (uint32_t channel = 0; channel < ledc.channels.size(); ++channel) {
        if (ledcChannelTimer(channel, ledc.channels[channel].conf0) == timer) ledcEvaluateChannel(ledc, channel, nowNs);
    }
}

uint64_t ledcCurrentPeriod(const LedcState& ledc, uint32_t timer, uint64_t nowNs) {
    const LedcTimer& t = ledc.timers[timer];
    if (t.resolution == 0 || t.tickNs <= 0 || nowNs <= t.epochNs) return 0;
    const long double periodNs = t.tickNs * static_cast<long double>(uint64_t(1) << t.resolution);
    return static_cast<uint64_t>(static_cast<long double>(nowNs - t.epochNs) / periodNs);
}

void ledcReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    s->chip->ledc = LedcState{};
    s->chip->ledc.apbHz = s->chip->apbHz;
}

void ledcWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    LedcState& ledc = s->chip->ledc;
    const uint64_t offset = address - kLedcStart;
    const uint32_t value32 = static_cast<uint32_t>(value);

    if (offset == kLedcConfOffset) {
        // SLOW_CLK muda o tick de todo timer de baixa velocidade com TICK_SEL.
        ledc.confReg = value32;
        for (uint32_t timer = 4; timer < 8; ++timer) {
            ledc.timers[timer].tickNs = ledcTickNs(ledc, timer, ledc.timers[timer].config);
            ledcEvaluateTimerChannels(ledc, timer, nowNs);
        }
        return;
    }
    if (offset >= kLedcTimerOffset && offset < kLedcTimerOffset + 8u * 8u && ((offset - kLedcTimerOffset) % 8u) == 0) {
        const uint32_t timer = static_cast<uint32_t>((offset - kLedcTimerOffset) / 8u);
        // Timers de baixa velocidade so adotam resolucao/divisor/clock novos no PARA_UP; os de alta,
        // na hora.
        const bool parameters = timer < 4 || (value32 & kLedcLsTimerParaUp) != 0;
        ledcApplyTimerConfig(ledc, timer, value32, nowNs, parameters);
        if (analogTraceEnabled()) {
            std::fprintf(stderr, "[LasecSimul][adapter][LEDC] timer=%u config=0x%08x tick_ns=%.3Lf resolution=%u\n",
                         timer, value32, ledc.timers[timer].tickNs, ledc.timers[timer].resolution);
        }
        ledcEvaluateTimerChannels(ledc, timer, nowNs);
        return;
    }
    if (offset >= kLedcTimerOffset) return;

    const uint32_t channel = static_cast<uint32_t>(offset / 0x14u);
    const uint32_t registerOffset = static_cast<uint32_t>(offset % 0x14u);
    if (channel >= ledc.channels.size()) return;
    LedcChannel& c = ledc.channels[channel];
    switch (registerOffset) {
        case 0x0:  // CONF0: TIMER_SEL, SIG_OUT_EN, IDLE_LV (PARA_UP so confirma a escrita)
            c.conf0 = value32;
            break;
        case 0x4:  // HPOINT
            c.hpointReg = value32 & 0xFFFFFu;
            break;
        case 0x8:  // DUTY (21 bits inteiros + 4 fracionarios)
            c.dutyReg = value32 & 0x1FFFFFFu;
            break;
        case 0xC:  // CONF1: DUTY_START agenda a troca para o proximo estouro do contador
            if ((value32 & kLedcConf1DutyStart) != 0) {
                ledcEvaluateChannel(ledc, channel, nowNs); // fecha a atualizacao anterior ate agora
                c.updatePending = true;
                c.updateAfterPeriod = ledcCurrentPeriod(ledc, ledcChannelTimer(channel, c.conf0), nowNs);
                c.fadeActive = false;
                c.fadeStartDuty = c.dutyReg;
                c.fadeConf1 = value32 & ~kLedcConf1DutyStart;
            }
            break;
        default:
            return;
    }
    ledcEvaluateChannel(ledc, channel, nowNs);
}

void ledcWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    ledcWriteRegisterAt(module, address, value, 0);
}

uint64_t ledcReadRegister(LsdnQemuModule*, uint64_t) { return 0; }

uint64_t ledcNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    uint64_t nearest = LSDN_QEMU_MODULE_NO_WAKEUP;
    for (const uint64_t edge : s->chip->ledc.nextEdgeNs) {
        if (edge == 0) continue;
        nearest = std::min(nearest, edge <= nowNs ? uint64_t(0) : edge - nowNs);
    }
    return nearest;
}

void ledcOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    LedcState& ledc = s->chip->ledc;
    for (uint32_t channel = 0; channel < ledc.nextEdgeNs.size(); ++channel) {
        if (ledc.nextEdgeNs[channel] == 0 || ledc.nextEdgeNs[channel] > nowNs) continue;
        ledcEvaluateChannel(ledc, channel, nowNs);
    }
}

void ledcDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<LedcModuleState*>(module);
}

const LsdnQemuModuleVTable kLedcModuleVTable = {
    &ledcReset, &ledcWriteRegister, &ledcReadRegister, nullptr, nullptr, nullptr, &ledcDestroy,
    nullptr, &ledcOnWakeup, &ledcWriteRegisterAt, nullptr, &ledcNextWakeupAt,
};

// Canais privados que o QEMU espelha (hw/ssi/esp32_rmt.h): ITEM + 4n quando um item (ou o nivel
// ocioso) comeca, CARRIER + 8n / + 8n + 4 com a portadora no inicio da transmissao.
constexpr uint64_t kRmtItemOffset = 0x400;
constexpr uint64_t kRmtCarrierOffset = 0x440;
constexpr uint64_t kRmtItemLevel0 = 1u << 0;
constexpr uint64_t kRmtItemLevel1 = 1u << 1;
constexpr uint64_t kRmtItemSecond = 1u << 2;
constexpr uint64_t kRmtItemIdle = 1u << 3;
constexpr unsigned kRmtItemPsShift = 8;

uint64_t rmtPsToNs(uint64_t ps) { return (ps + 500u) / 1000u; }

// LASECSIMUL_RMT_TRACE=1: cada item/portadora espelhado pelo QEMU e cada borda gerada.
bool rmtTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_RMT_TRACE");
        return value != nullptr && value[0] != 0 && std::strcmp(value, "0") != 0;
    }();
    return enabled;
}

// Borda `k` (1, 2, ...) da portadora contada do inicio do segmento: alto por HIGH, baixo por LOW.
uint64_t rmtCarrierEdgeDueNs(const RmtChannel& c, uint64_t k) {
    return addDelayNs(c.segmentStartNs, rmtPsToNs(((k + 1) / 2) * c.carrierHighPs + (k / 2) * c.carrierLowPs));
}

void rmtStartSegment(RmtChannel& c, bool level, bool idle, uint64_t nowNs) {
    c.segmentLevel = level;
    c.segmentStartNs = nowNs;
    c.carrierEdges = 0;
    const bool carrier = !idle && c.carrierEnabled && c.carrierHighPs != 0 && c.carrierLowPs != 0 &&
                         level == c.carrierLevel;
    c.level = carrier ? true : level; // a portadora comeca na fase alta
    c.carrierNextNs = carrier ? rmtCarrierEdgeDueNs(c, 1) : LSDN_QEMU_MODULE_NO_WAKEUP;
}

void rmtReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<RmtModuleState*>(module);
    s->chip->rmt = RmtState{};
    s->chip->rmt.apbHz = s->chip->apbHz;
}

constexpr uint64_t kRmtRxConfigOffset = 0x480; // + 8n: o receptor do canal (QEMU, esp32_rmt_rx_config)
constexpr uint64_t kRmtRxEventOffset = 0x500;  // le e consome o proximo item/fim (bit 63 = havia)
constexpr uint64_t kRmtRxHardDueOffset = 0x50C; // instante do proximo fim de recepcao (despertar rigido)

uint16_t rmtRxHalf(bool level, uint64_t ticks) {
    return static_cast<uint16_t>(std::min<uint64_t>(ticks, 0x7FFFu) | (level ? 0x8000u : 0u));
}

void rmtRxPushHalf(RmtState& rmt, uint32_t n, uint16_t half) {
    RmtRx& r = rmt.rx[n];
    if (!r.halfPending) {
        r.half = half;
        r.halfPending = true;
        return;
    }
    rmt.rxEvents.push_back(uint64_t(r.half) | (uint64_t(half) << 16) | (uint64_t(n) << 32));
    r.halfPending = false;
}

// Uma borda que passou pelo filtro, em `atNs`: fecha o nivel de antes (a primeira so' comeca a recepcao).
void rmtRxAccept(RmtState& rmt, uint32_t n, bool level, uint64_t atNs) {
    RmtRx& r = rmt.rx[n];
    if (level == r.level) return;
    if (r.recording) {
        const uint64_t ticks = ((atNs - r.levelStartNs) * 1000u + r.tickPs / 2u) / r.tickPs;
        rmtRxPushHalf(rmt, n, rmtRxHalf(r.level, ticks));
    }
    r.recording = true;
    r.level = level;
    r.levelStartNs = atNs;
    r.idleDueNs = addDelayNs(atNs, (uint64_t(r.idleTicks) * r.tickPs + 999u) / 1000u);
}

void rmtRxEnd(RmtState& rmt, uint32_t n) {
    RmtRx& r = rmt.rx[n];
    rmtRxPushHalf(rmt, n, rmtRxHalf(r.level, 0)); // o fim: duracao 0
    if (r.halfPending) {
        rmt.rxEvents.push_back(uint64_t(r.half) | (uint64_t(n) << 32));
        r.halfPending = false;
    }
    rmt.rxEvents.push_back((uint64_t(n) << 32) | (uint64_t(1) << 36));
    r.recording = false;
    r.idleDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
}

void rmtRxInputAt(RmtState& rmt, uint32_t n, bool level, uint64_t nowNs) {
    RmtRx& r = rmt.rx[n];
    if (rmtTraceEnabled())
        std::fprintf(stderr, "[RMT] rx%u in=%d enabled=%d at=%llu\n", n, level ? 1 : 0, r.enabled ? 1 : 0,
                     static_cast<unsigned long long>(nowNs));
    r.raw = level;
    if (!r.enabled) {
        r.level = level;
        return;
    }
    if (!r.filterEn || r.filterThres == 0) {
        rmtRxAccept(rmt, n, level, nowNs);
        return;
    }
    if (level == r.level) { // voltou antes do filtro: o pulso some
        r.confirmDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        return;
    }
    r.pendingEdgeNs = nowNs;
    r.confirmDueNs = addDelayNs(nowNs, (uint64_t(r.filterThres) * 1'000'000'000ull + rmt.apbHz - 1u) / rmt.apbHz);
}

void rmtRxAdvance(RmtState& rmt, uint64_t nowNs) {
    for (uint32_t n = 0; n < rmt.rx.size(); ++n) {
        RmtRx& r = rmt.rx[n];
        if (r.confirmDueNs <= nowNs) {
            r.confirmDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            rmtRxAccept(rmt, n, r.raw, r.pendingEdgeNs);
        }
        if (r.idleDueNs <= nowNs) rmtRxEnd(rmt, n);
    }
}

void rmtWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<RmtModuleState*>(module);
    const uint64_t offset = address - kRmtStart;
    if (rmtTraceEnabled())
        std::fprintf(stderr, "[RMT] write off=%03llx value=%llx at=%llu\n", static_cast<unsigned long long>(offset),
                     static_cast<unsigned long long>(value), static_cast<unsigned long long>(nowNs));
    if (offset >= kRmtRxConfigOffset && offset < kRmtRxConfigOffset + 8u * 8u) {
        // [0] RX_EN, [1] RX_FILTER_EN, [9:2] RX_FILTER_THRES, [25:10] IDLE_THRES, [63:26] o tick em ps
        RmtState& rmt = s->chip->rmt;
        const uint32_t n = static_cast<uint32_t>((offset - kRmtRxConfigOffset) / 8u);
        rmtRxAdvance(rmt, nowNs);
        RmtRx& r = rmt.rx[n];
        const bool enable = (value & 1u) != 0;
        r.filterEn = (value & 2u) != 0;
        r.filterThres = static_cast<uint32_t>((value >> 2) & 0xFFu);
        r.idleTicks = static_cast<uint32_t>((value >> 10) & 0xFFFFu);
        r.tickPs = std::max<uint64_t>(value >> 26, 1);
        if (enable != r.enabled) { // ligar: espera a primeira borda; desligar: o que estava no meio se perde
            r.enabled = enable;
            r.level = r.raw;
            r.recording = false;
            r.halfPending = false;
            r.confirmDueNs = r.idleDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        }
        return;
    }
    if (offset >= kRmtItemOffset && offset < kRmtItemOffset + 4u * 8u) {
        RmtChannel& c = s->chip->rmt.channels[(offset - kRmtItemOffset) / 4u];
        const bool idle = (value & kRmtItemIdle) != 0;
        rmtStartSegment(c, (value & kRmtItemLevel0) != 0, idle, nowNs);
        c.secondDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        if (!idle && (value & kRmtItemSecond) != 0) {
            c.secondLevel = (value & kRmtItemLevel1) != 0;
            c.secondDueNs = addDelayNs(nowNs, rmtPsToNs(value >> kRmtItemPsShift));
        }
        return;
    }
    if (offset >= kRmtCarrierOffset && offset < kRmtCarrierOffset + 8u * 8u) {
        RmtChannel& c = s->chip->rmt.channels[(offset - kRmtCarrierOffset) / 8u];
        if (((offset - kRmtCarrierOffset) % 8u) == 0) {
            c.carrierEnabled = (value & 1u) != 0;
            c.carrierLevel = (value & 2u) != 0;
            c.carrierHighPs = value >> kRmtItemPsShift;
        } else {
            c.carrierLowPs = value;
        }
    }
}

void rmtWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    rmtWriteRegisterAt(module, address, value, 0);
}

uint64_t rmtReadRegister(LsdnQemuModule* module, uint64_t address) {
    RmtState& rmt = reinterpret_cast<RmtModuleState*>(module)->chip->rmt;
    const uint64_t offset = address - kRmtStart;
    if (offset == kRmtRxEventOffset) {
        if (rmt.rxEvents.empty()) return 0;
        const uint64_t event = rmt.rxEvents.front();
        rmt.rxEvents.pop_front();
        if (rmtTraceEnabled())
            std::fprintf(stderr, "[RMT] rx event %llx\n", static_cast<unsigned long long>(event));
        return event | (uint64_t(1) << 63);
    }
    if (offset == kRmtRxHardDueOffset) {
        uint64_t due = LSDN_QEMU_MODULE_NO_WAKEUP;
        for (const RmtRx& r : rmt.rx) due = std::min(due, r.idleDueNs);
        return due;
    }
    return 0;
}

uint64_t rmtNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<RmtModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t nearest = LSDN_QEMU_MODULE_NO_WAKEUP;
    for (const RmtChannel& c : s->chip->rmt.channels) {
        nearest = std::min(nearest, delayUntilNs(c.secondDueNs, nowNs));
        nearest = std::min(nearest, delayUntilNs(c.carrierNextNs, nowNs));
    }
    for (const RmtRx& r : s->chip->rmt.rx) {
        nearest = std::min(nearest, delayUntilNs(r.confirmDueNs, nowNs));
        nearest = std::min(nearest, delayUntilNs(r.idleDueNs, nowNs));
    }
    return nearest;
}

void rmtOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<RmtModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    rmtRxAdvance(s->chip->rmt, nowNs);
    for (RmtChannel& c : s->chip->rmt.channels) {
        // Em ordem de tempo: a segunda metade comeca um segmento novo (e reinicia a portadora).
        for (int guard = 0; guard < 64; ++guard) {
            const uint64_t due = std::min(c.secondDueNs, c.carrierNextNs);
            if (due == LSDN_QEMU_MODULE_NO_WAKEUP || due > nowNs) break;
            if (c.secondDueNs <= c.carrierNextNs) {
                const uint64_t at = c.secondDueNs;
                c.secondDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
                rmtStartSegment(c, c.secondLevel, false, at);
            } else {
                ++c.carrierEdges;
                c.level = (c.carrierEdges % 2u) == 0;
                c.carrierNextNs = rmtCarrierEdgeDueNs(c, c.carrierEdges + 1);
            }
            if (rmtTraceEnabled())
                std::fprintf(stderr, "[RMT] edge level=%d at=%llu\n", c.level ? 1 : 0, static_cast<unsigned long long>(nowNs));
        }
    }
}

void rmtDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<RmtModuleState*>(module);
}

const LsdnQemuModuleVTable kRmtModuleVTable = {
    &rmtReset, &rmtWriteRegister, &rmtReadRegister, nullptr, nullptr, nullptr, &rmtDestroy,
    nullptr, &rmtOnWakeup, &rmtWriteRegisterAt, nullptr, &rmtNextWakeupAt,
};

// PCNT: CONF0 da unidade -- FILTER_THRES [9:0], FILTER_EN 10, THR_ZERO_EN 11, THR_H_LIM_EN 12,
// THR_L_LIM_EN 13, THR_THRES0_EN 14, THR_THRES1_EN 15, e por canal NEG/POS/HCTRL/LCTRL (2 bits cada,
// canal 0 em [23:16], canal 1 em [31:24]). Bits de evento de PCNT_Un_STATUS: THRES1 2, THRES0 3,
// L_LIM 4, H_LIM 5, ZERO 6.
constexpr uint64_t kPcntIntEnaOffset = 0x88;
constexpr uint64_t kPcntCtrlOffset = 0xB0;
constexpr uint64_t kPcntCountOffset = 0x200;  // canal privado: contador da unidade n (+4n), 16 bits
constexpr uint64_t kPcntEventOffset = 0x240;  // le e consome o proximo evento: (unidade << 16) | STATUS, bit 31
constexpr uint64_t kPcntArmedOffset = 0x244;  // != 0: um evento pode virar interrupcao
constexpr uint32_t kPcntEventValid = 1u << 31;

int32_t pcntSigned16(uint32_t field) { return static_cast<int16_t>(field & 0xFFFFu); }

uint32_t pcntEventEnables(uint32_t conf0) { return (conf0 >> 11) & 0x1Fu; }

void pcntCount(PcntState& pcnt, uint32_t unit, uint32_t channel, bool rising) {
    PcntUnit& u = pcnt.units[unit];
    if ((pcnt.ctrl >> (2u * unit)) & 3u) return; // em reset ou pausado
    const uint32_t shift = 16u + 8u * channel;
    uint32_t edgeAction = (u.conf0 >> (shift + (rising ? 2u : 0u))) & 3u;  // 0 segura, 1 soma, 2 subtrai
    const bool ctrlHigh = u.inputs[2u + channel].level;
    const uint32_t levelAction = (u.conf0 >> (shift + (ctrlHigh ? 4u : 6u))) & 3u; // 0 mantem, 1 inverte, 2 segura
    if (levelAction >= 2u || edgeAction == 0u || edgeAction == 3u) return;
    if (levelAction == 1u) edgeAction = edgeAction == 1u ? 2u : 1u;
    int32_t count = u.count + (edgeAction == 1u ? 1 : -1);
    if (count > 32767) count = -32768; // contador de 16 bits com sinal
    if (count < -32768) count = 32767;

    uint32_t events = 0;
    if (((u.conf0 >> 15) & 1u) && count == pcntSigned16(u.conf1 >> 16)) events |= 1u << 2;
    if (((u.conf0 >> 14) & 1u) && count == pcntSigned16(u.conf1)) events |= 1u << 3;
    const int32_t highLimit = pcntSigned16(u.conf2), lowLimit = pcntSigned16(u.conf2 >> 16);
    // Ao chegar a um limite o contador volta a 0 (o evento so' com o enable).
    if (highLimit > 0 && count >= highLimit) {
        if ((u.conf0 >> 12) & 1u) events |= 1u << 5;
        count = 0;
    } else if (lowLimit < 0 && count <= lowLimit) {
        if ((u.conf0 >> 13) & 1u) events |= 1u << 4;
        count = 0;
    }
    if (((u.conf0 >> 11) & 1u) && count == 0) events |= 1u << 6;
    u.count = count;
    if (events) {
        // STATUS_Un trava os eventos da ultima interrupcao (TRM, "_LAT"): cada evento novo o regrava. O
        // servico do ESP-IDF limpa a interrupcao antes de o handler ler o STATUS.
        u.status = (u.status & 3u) | events;
        if (pcnt.events.size() < 256) pcnt.events.push_back((unit << 16) | u.status);
    }
}

void pcntCommit(PcntState& pcnt, uint32_t index, bool level) {
    PcntUnit& u = pcnt.units[index / 4u];
    PcntInput& in = u.inputs[index % 4u];
    if (in.level == level) return;
    in.level = level;
    if (index % 4u < 2u) pcntCount(pcnt, index / 4u, index % 4u, level);
}

void pcntInputAt(PcntState& pcnt, uint32_t index, bool level, uint64_t nowNs) {
    PcntUnit& u = pcnt.units[index / 4u];
    PcntInput& in = u.inputs[index % 4u];
    in.raw = level;
    const uint32_t thres = u.conf0 & 0x3FFu;
    if (!((u.conf0 >> 10) & 1u) || thres == 0) {
        in.commitDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        pcntCommit(pcnt, index, level);
        return;
    }
    // Filtro: o nivel novo so' vale depois de FILTER_THRES ciclos de APB sem mudar; um pulso mais curto
    // volta ao nivel de antes e some.
    in.commitDueNs = level == in.level ? LSDN_QEMU_MODULE_NO_WAKEUP
                                       : addDelayNs(nowNs, (uint64_t(thres) * 1'000'000'000ull + pcnt.apbHz - 1) /
                                                               pcnt.apbHz);
}

void pcntReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<PcntModuleState*>(module);
    s->chip->pcnt = PcntState{};
    s->chip->pcnt.apbHz = s->chip->apbHz;
}

void pcntWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t) {
    auto* s = reinterpret_cast<PcntModuleState*>(module);
    PcntState& pcnt = s->chip->pcnt;
    const uint64_t offset = address - kPcntStart;
    const uint32_t value32 = static_cast<uint32_t>(value);
    if (offset < 0x60) {
        PcntUnit& u = pcnt.units[offset / 12u];
        switch (offset % 12u) {
            case 0: u.conf0 = value32; break;
            case 4: u.conf1 = value32; break;
            default: u.conf2 = value32; break;
        }
        return;
    }
    if (offset == kPcntIntEnaOffset) {
        pcnt.intEna = value32 & 0xFFu;
        return;
    }
    if (offset == kPcntCtrlOffset) {
        pcnt.ctrl = value32;
        for (uint32_t unit = 0; unit < pcnt.units.size(); ++unit) {
            if ((value32 >> (2u * unit)) & 1u) pcnt.units[unit].count = 0; // PLUS_CNT_RST: zera e segura
        }
    }
}

void pcntWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    pcntWriteRegisterAt(module, address, value, 0);
}

uint64_t pcntReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<PcntModuleState*>(module);
    PcntState& pcnt = s->chip->pcnt;
    const uint64_t offset = address - kPcntStart;
    if (offset >= kPcntCountOffset && offset < kPcntCountOffset + 4u * pcnt.units.size())
        return static_cast<uint16_t>(pcnt.units[(offset - kPcntCountOffset) / 4u].count);
    if (offset == kPcntEventOffset) {
        if (pcnt.events.empty()) return 0;
        const uint32_t event = pcnt.events.front();
        pcnt.events.pop_front();
        return event | kPcntEventValid;
    }
    if (offset == kPcntArmedOffset) {
        for (uint32_t unit = 0; unit < pcnt.units.size(); ++unit) {
            if (((pcnt.intEna >> unit) & 1u) && pcntEventEnables(pcnt.units[unit].conf0)) return 1;
        }
        return 0;
    }
    return 0;
}

uint64_t pcntNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<PcntModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t nearest = LSDN_QEMU_MODULE_NO_WAKEUP;
    for (const PcntUnit& u : s->chip->pcnt.units)
        for (const PcntInput& in : u.inputs) nearest = std::min(nearest, delayUntilNs(in.commitDueNs, nowNs));
    return nearest;
}

void pcntOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<PcntModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    PcntState& pcnt = s->chip->pcnt;
    for (uint32_t index = 0; index < 4u * pcnt.units.size(); ++index) {
        PcntInput& in = pcnt.units[index / 4u].inputs[index % 4u];
        if (in.commitDueNs == LSDN_QEMU_MODULE_NO_WAKEUP || in.commitDueNs > nowNs) continue;
        in.commitDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        pcntCommit(pcnt, index, in.raw);
    }
}

void pcntDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<PcntModuleState*>(module);
}

const LsdnQemuModuleVTable kPcntModuleVTable = {
    &pcntReset, &pcntWriteRegister, &pcntReadRegister, nullptr, nullptr, nullptr, &pcntDestroy,
    nullptr, &pcntOnWakeup, &pcntWriteRegisterAt, nullptr, &pcntNextWakeupAt,
};

// ---------------------------------------------------------------------------------------------------
// MCPWM. Registradores (ESP-IDF mcpwm_struct.h): CLK_CFG 0x000; TIMERn em 0x004 + 0x10 n (CFG0, CFG1,
// SYNC, STATUS); TIMER_SYNCI_CFG 0x034; OPERATOR_TIMERSEL 0x038; OPERADOR n em 0x03C + 0x38 n (GEN_STMP_CFG,
// TSTMP_A, TSTMP_B, GEN_CFG0, GEN_FORCE, GEN_A, GEN_B, DT_CFG, DT_FED, DT_RED, CARRIER, FH_CFG0, FH_CFG1,
// FH_STATUS); FAULT_DETECT 0x0E4; CAP_TIMER_CFG 0x0E8; CAP_TIMER_PHASE 0x0EC; CAPn_CFG 0x0F0; CAPn 0x0FC;
// CAP_STATUS 0x108; UPDATE_CFG 0x10C; INT_ENA 0x110; INT_RAW 0x114. Bits de INT_RAW: TIMERn_STOP n,
// TIMERn_TEZ 3+n, TIMERn_TEP 6+n, FAULTn 9+n, FAULTn_CLR 12+n, OPn_TEA 15+n, OPn_TEB 18+n, FHn_CBC 21+n,
// FHn_OST 24+n, CAPn 27+n.
constexpr uint64_t kMcpwm0Start = 0x3FF5E000;
constexpr uint64_t kMcpwm1Start = 0x3FF6C000;
constexpr uint64_t kMcpwmLatchOffset = 0x2F0;   // canal privado: escrever trava TIMERn_STATUS no instante
constexpr uint64_t kMcpwmStatusOffset = 0x200;  // ... e ler 0x200 + 4n devolve o travado
constexpr uint64_t kMcpwmEventOffset = 0x240;   // le e consome o proximo evento: offset 0x240, valor 0x244
constexpr uint64_t kMcpwmArmedOffset = 0x248;
constexpr uint64_t kMcpwmPwmClkBasePs = 6250;   // PWM_clk = 160 MHz / (CLK_PRESCALE + 1)
constexpr uint32_t kMcpwmIntRaw = 0x114;
constexpr uint32_t kMcpwmOpBase = 0x03C;
constexpr uint32_t kMcpwmOpStride = 0x38;

struct McpwmModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t unit = 0;
    uint32_t pendingEventValue = 0; // valor do evento cujo offset ja' foi lido (kMcpwmEventOffset)
};

void mcpwmRaise(McpwmUnit& u, uint32_t bit) {
    if (((u.intEna >> bit) & 1u) && u.events.size() < 256) u.events.emplace_back(kMcpwmIntRaw, 1u << bit);
}

uint32_t mcpwmTimerMode(const McpwmTimer& t) { return (t.cfg1 >> 3) & 3u; }

uint64_t mcpwmPhaseLength(const McpwmTimer& t) {
    const uint64_t p = t.period;
    if (mcpwmTimerMode(t) == 3) return p == 0 ? 1 : 2 * p; // up-down: 0..P..0
    return p + 1;                                          // up: 0..P, down: P..0
}

// Fase -> (contagem, direcao em que a contagem chegou ali; true = decrescendo).
void mcpwmCountOf(const McpwmTimer& t, uint64_t phase, uint32_t& count, bool& down) {
    const uint32_t p = t.period;
    switch (mcpwmTimerMode(t)) {
        case 2: count = p - static_cast<uint32_t>(phase); down = true; return;
        case 3:
            if (phase <= p) { count = static_cast<uint32_t>(phase); down = phase == 0 && p != 0; }
            else { count = static_cast<uint32_t>(2 * p - phase); down = true; }
            return;
        default: count = static_cast<uint32_t>(phase); down = false; return;
    }
}

uint64_t mcpwmPhaseOf(const McpwmTimer& t, uint32_t count, bool down) {
    const uint64_t p = t.period;
    count = std::min<uint32_t>(count, t.period);
    switch (mcpwmTimerMode(t)) {
        case 2: return p - count;
        case 3: return (down && count != 0) ? 2 * p - count : count;
        default: return count;
    }
}

uint64_t mcpwmTickNs(const McpwmTimer& t, uint64_t ticks) {
    return addDelayNs(t.epochNs, (ticks * t.tickPs + 500u) / 1000u);
}

void mcpwmPhaseNow(const McpwmTimer& t, uint64_t& phase) {
    phase = (t.epochPhase + t.ticks) % mcpwmPhaseLength(t);
}

uint64_t mcpwmElapsedTicks(const McpwmTimer& t, uint64_t nowNs) {
    return nowNs > t.epochNs ? ((nowNs - t.epochNs) * 1000u) / t.tickPs : 0;
}

// Proximo tick com evento (TEZ, TEP, TEA/TEB de um operador ligado a este timer), depois do tick
// `fromTicks` (o ultimo evento processado, ou o tick de agora depois de uma escrita: um comparador novo
// que a contagem ja' passou nao gera evento atrasado).
void mcpwmScheduleTimerFrom(McpwmUnit& u, uint32_t index, uint64_t fromTicks) {
    McpwmTimer& t = u.timers[index];
    t.nextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    if (!t.running || mcpwmTimerMode(t) == 0) return;
    const uint64_t length = mcpwmPhaseLength(t);
    const uint64_t phase = (t.epochPhase + fromTicks) % length;
    std::array<uint32_t, 8> targets{};
    size_t count = 0;
    targets[count++] = 0;
    targets[count++] = t.period;
    for (uint32_t op = 0; op < 3; ++op) {
        if (((u.opTimerSel >> (2u * op)) & 3u) != index) continue;
        for (uint32_t cmp : u.ops[op].cmpActive)
            if (cmp <= t.period && count < targets.size()) targets[count++] = cmp;
    }
    uint64_t best = UINT64_MAX;
    for (size_t i = 0; i < count; ++i) {
        for (const bool down : {false, true}) {
            const uint64_t target = mcpwmPhaseOf(t, targets[i], down);
            uint64_t delta = (target + length - phase) % length;
            if (delta == 0) delta = length;
            best = std::min(best, delta);
        }
    }
    t.nextTicks = fromTicks + best;
    t.nextNs = mcpwmTickNs(t, t.nextTicks);
}

void mcpwmScheduleTimer(McpwmUnit& u, uint32_t index) { mcpwmScheduleTimerFrom(u, index, u.timers[index].ticks); }

// Depois de uma escrita no instante `nowNs` (os eventos ate' ali ja' processados, ver mcpwmCatchUp).
void mcpwmRescheduleAt(McpwmUnit& u, uint32_t index, uint64_t nowNs) {
    McpwmTimer& t = u.timers[index];
    if (t.running) mcpwmScheduleTimerFrom(u, index, std::max(t.ticks, mcpwmElapsedTicks(t, nowNs)));
}

void mcpwmStartTimer(McpwmUnit& u, uint32_t index, uint64_t nowNs) {
    McpwmTimer& t = u.timers[index];
    const uint64_t pwmClkPs = kMcpwmPwmClkBasePs * ((u.clkCfg & 0xFFu) + 1u);
    t.tickPs = pwmClkPs * ((t.cfg0 & 0xFFu) + 1u); // o prescale do timer vale ao (re)iniciar
    uint64_t phase = 0;
    if (t.running) mcpwmPhaseNow(t, phase);
    t.epochNs = nowNs;
    t.epochPhase = phase;
    t.ticks = 0;
    t.running = true;
    mcpwmScheduleTimer(u, index);
}

// Rebase da contagem num tick ja' processado (periodo novo, sync): a fase e' recalculada no modo novo.
void mcpwmRebase(McpwmTimer& t, uint32_t count, bool down, uint64_t atNs) {
    t.epochNs = atNs;
    t.ticks = 0;
    t.epochPhase = mcpwmPhaseOf(t, count, down) % mcpwmPhaseLength(t);
}

bool mcpwmShadowEnabled(const McpwmUnit& u, uint32_t op) {
    return (u.updateCfg & 1u) && ((u.updateCfg >> (2u + 2u * op)) & 1u);
}

// Sombra -> ativo nos eventos que o metodo de atualizacao pede (bit0 TEZ, bit1 TEP, bit2 sync, bit3 nunca).
bool mcpwmUpdateOn(uint32_t method, bool tez, bool tep, bool sync) {
    if (method & 8u) return false;
    return (tez && (method & 1u)) || (tep && (method & 2u)) || (sync && (method & 4u));
}

void mcpwmOpShadow(McpwmUnit& u, uint32_t op, bool tez, bool tep, bool sync) {
    if (!mcpwmShadowEnabled(u, op)) return;
    McpwmOperator& o = u.ops[op];
    for (uint32_t i = 0; i < 2; ++i)
        if (mcpwmUpdateOn((o.stmpCfg >> (4u * i)) & 0xFu, tez, tep, sync)) o.cmpActive[i] = o.cmpShadow[i];
    if (mcpwmUpdateOn(o.genCfg0 & 0xFu, tez, tep, sync)) o.actionActive = o.actionShadow;
    // DT_FED_UPMETHOD [3:0] e DT_RED_UPMETHOD [7:4] (o driver do ESP-IDF pede TEZ).
    if (mcpwmUpdateOn(o.dtCfg & 0xFu, tez, tep, sync)) o.dtFed = o.dtFedShadow;
    if (mcpwmUpdateOn((o.dtCfg >> 4) & 0xFu, tez, tep, sync)) o.dtRed = o.dtRedShadow;
}

bool mcpwmApplyAction(bool level, uint32_t action) {
    switch (action & 3u) {
        case 1: return false;
        case 2: return true;
        case 3: return !level;
        default: return level;
    }
}

uint64_t mcpwmDeadClockPs(const McpwmUnit& u, uint32_t op) {
    const McpwmOperator& o = u.ops[op];
    const uint64_t pwmClkPs = kMcpwmPwmClkBasePs * ((u.clkCfg & 0xFFu) + 1u);
    if (!((o.dtCfg >> 17) & 1u)) return pwmClkPs; // DT_CLK_SEL 0: PWM_clk; 1: o clock do timer
    return u.timers[(u.opTimerSel >> (2u * op)) & 3u].tickPs;
}

// Dead time (chaves S0..S8 do TRM) e tratamento de falha, dos geradores ate' os pinos.
void mcpwmUpdateOutputs(McpwmUnit& u, uint32_t op, uint64_t nowNs) {
    McpwmOperator& o = u.ops[op];
    const uint32_t dt = o.dtCfg;
    const bool redIn = ((dt >> 11) & 1u) ? o.gen[1] : o.gen[0];        // S4 RED_INSEL
    const bool redOutInverted = o.redLevel != (((dt >> 13) & 1u) != 0); // S2 RED_OUTINVERT
    const bool fedIn = ((dt >> 8) & 1u) ? redOutInverted                // S8 DEB_MODE: RED e FED em serie
                                        : (((dt >> 12) & 1u) ? o.gen[1] : o.gen[0]); // S5 FED_INSEL
    // RED atrasa a subida, FED a descida; um pulso mais curto que o atraso some.
    const uint64_t clockPs = mcpwmDeadClockPs(u, op);
    if (!redIn) { o.redLevel = false; o.redDueNs = LSDN_QEMU_MODULE_NO_WAKEUP; }
    else if (!o.redLevel && o.redDueNs == LSDN_QEMU_MODULE_NO_WAKEUP)
        o.redDueNs = addDelayNs(nowNs, (uint64_t(o.dtRed & 0xFFFFu) * clockPs + 500u) / 1000u);
    if (fedIn) { o.fedLevel = true; o.fedDueNs = LSDN_QEMU_MODULE_NO_WAKEUP; }
    else if (o.fedLevel && o.fedDueNs == LSDN_QEMU_MODULE_NO_WAKEUP)
        o.fedDueNs = addDelayNs(nowNs, (uint64_t(o.dtFed & 0xFFFFu) * clockPs + 500u) / 1000u);
    const bool redOut = o.redLevel != (((dt >> 13) & 1u) != 0);
    const bool fedOut = o.fedLevel != (((dt >> 14) & 1u) != 0);           // S3 FED_OUTINVERT
    const bool pathA = ((dt >> 15) & 1u) ? o.gen[0] : redOut;            // S1 A_OUTBYPASS
    const bool pathB = ((dt >> 16) & 1u) ? o.gen[1] : fedOut;            // S0 B_OUTBYPASS
    std::array<bool, 2> out{((dt >> 9) & 1u) ? pathB : pathA,            // S6 A_OUTSWAP
                            ((dt >> 10) & 1u) ? pathA : pathB};          // S7 B_OUTSWAP
    // Falha: OST (trava ate' CLR_OST) acima de CBC; acao conforme o sentido do timer do operador.
    if (o.ostOn || o.cbcOn) {
        const McpwmTimer& t = u.timers[(u.opTimerSel >> (2u * op)) & 3u];
        uint64_t phase = 0;
        mcpwmPhaseNow(t, phase);
        uint32_t count = 0;
        bool down = false;
        mcpwmCountOf(t, phase, count, down);
        for (uint32_t g = 0; g < 2; ++g) {
            const uint32_t base = 8u + 8u * g + (o.ostOn ? 0u : 4u) + (down ? 0u : 2u);
            const uint32_t action = (o.fhCfg0 >> base) & 3u;
            if (action == 1u) out[g] = false;
            else if (action == 2u) out[g] = true;
            else if (action == 3u) out[g] = !o.out[g];
        }
    }
    o.out = out;
}

void mcpwmApplyForce(McpwmOperator& o) {
    for (uint32_t g = 0; g < 2; ++g) {
        const uint32_t mode = (o.genForce >> (6u + 2u * g)) & 3u; // CNTUFORCE: 1 baixo, 2 alto
        if (mode == 1u) o.gen[g] = false;
        else if (mode == 2u) o.gen[g] = true;
    }
}

void mcpwmSync(McpwmUnit& u, uint32_t source, uint64_t nowNs, uint32_t depth = 0);

// Um tick de evento do timer `index`: sombras, acoes dos geradores, interrupcoes, sync out e parada.
void mcpwmTimerEvent(McpwmUnit& u, uint32_t index, uint64_t atNs) {
    McpwmTimer& t = u.timers[index];
    t.ticks = t.nextTicks;
    uint64_t phase = 0;
    mcpwmPhaseNow(t, phase);
    uint32_t count = 0;
    bool down = false;
    mcpwmCountOf(t, phase, count, down);
    const bool tez = count == 0, tep = count == t.period;
    if (tez) mcpwmRaise(u, 3u + index);
    if (tep) mcpwmRaise(u, 6u + index);
    // Periodo: PERIOD_UPMETHOD 0 imediato (ja' aplicado na escrita), bit0 TEZ, bit1 sync.
    const uint32_t shadowPeriod = (t.cfg0 >> 8) & 0xFFFFu;
    if (tez && ((t.cfg0 >> 24) & 1u) && shadowPeriod != t.period) {
        t.period = shadowPeriod;
        mcpwmRebase(t, 0, down, atNs);
    }
    for (uint32_t op = 0; op < 3; ++op) {
        if (((u.opTimerSel >> (2u * op)) & 3u) != index) continue;
        McpwmOperator& o = u.ops[op];
        mcpwmOpShadow(u, op, tez, tep, false);
        const bool tea = count == o.cmpActive[0], teb = count == o.cmpActive[1];
        if (tea) mcpwmRaise(u, 15u + op);
        if (teb) mcpwmRaise(u, 18u + op);
        // Prioridade (da menor para a maior, a maior vale): crescendo TEZ < TEA < TEB < TEP;
        // decrescendo TEP < TEA < TEB < TEZ.
        const uint32_t dirShift = down ? 12u : 0u;
        const std::array<std::pair<bool, uint32_t>, 4> events = down
            ? std::array<std::pair<bool, uint32_t>, 4>{{{tep, 2u}, {tea, 4u}, {teb, 6u}, {tez, 0u}}}
            : std::array<std::pair<bool, uint32_t>, 4>{{{tez, 0u}, {tea, 4u}, {teb, 6u}, {tep, 2u}}};
        for (uint32_t g = 0; g < 2; ++g) {
            for (const auto& [happened, shift] : events)
                if (happened) o.gen[g] = mcpwmApplyAction(o.gen[g], o.actionActive[g] >> (dirShift + shift));
        }
        mcpwmApplyForce(o);
        // CBC sai no TEZ/TEP pedido (FH_CBCPULSE) se a falha ja' passou.
        if (o.cbcOn && (((o.fhCfg1 >> 1) & 1u && tez) || ((o.fhCfg1 >> 2) & 1u && tep))) {
            bool fault = false;
            for (uint32_t f = 0; f < 3; ++f)
                fault = fault || (((o.fhCfg0 >> (3u - f)) & 1u) && ((u.faultDetect >> (6u + f)) & 1u));
            o.cbcOn = fault;
        }
        mcpwmUpdateOutputs(u, op, atNs);
    }
    // Sync out: SYNCO_SEL 1 TEZ, 2 TEP.
    const uint32_t synco = (t.sync >> 2) & 3u;
    const bool stopNow = (t.stopAt == 1u && tez) || (t.stopAt == 2u && tep);
    if ((synco == 1u && tez) || (synco == 2u && tep)) mcpwmSync(u, 1u + index, atNs);
    if (stopNow) {
        t.running = false;
        t.stopAt = 0;
        t.nextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
        mcpwmRaise(u, index);
        return;
    }
    mcpwmScheduleTimer(u, index);
}

// Fonte de sync: 1-3 sync out do timer 0-2, 4-6 SYNC0-2 da GPIO matrix. Cada timer com SYNCI_EN que a
// escolheu recarrega PHASE no sentido PHASE_DIRECTION; com SYNCO_SEL 0 ele repassa o sync.
void mcpwmSync(McpwmUnit& u, uint32_t source, uint64_t nowNs, uint32_t depth) {
    if (depth > 3) return;
    for (uint32_t i = 0; i < 3; ++i) {
        McpwmTimer& t = u.timers[i];
        if (((u.synciCfg >> (3u * i)) & 7u) != source || !(t.sync & 1u)) continue;
        if (t.running) {
            for (uint32_t op = 0; op < 3; ++op)
                if (((u.opTimerSel >> (2u * op)) & 3u) == i) mcpwmOpShadow(u, op, false, false, true);
            if ((t.cfg0 >> 25) & 1u) t.period = (t.cfg0 >> 8) & 0xFFFFu;
            mcpwmRebase(t, (t.sync >> 4) & 0xFFFFu, ((t.sync >> 20) & 1u) != 0, nowNs);
            mcpwmScheduleTimer(u, i);
        }
        if (((t.sync >> 2) & 3u) == 0u) mcpwmSync(u, 1u + i, nowNs, depth + 1);
    }
}

uint32_t mcpwmCapValue(const McpwmUnit& u, uint64_t nowNs) {
    // Timer de captura: 32 bits em APB_CLK desde CAP_TIMER_EN (ou o ultimo sync, com CAP_TIMER_PHASE).
    const uint64_t elapsed = nowNs > u.capEpochNs ? nowNs - u.capEpochNs : 0;
    return u.capEpochValue + static_cast<uint32_t>((elapsed * u.apbHz) / 1'000'000'000ull);
}

void mcpwmCapture(McpwmUnit& u, uint32_t channel, bool negedge, uint64_t nowNs) {
    u.events.emplace_back(0x0FCu + 4u * channel, mcpwmCapValue(u, nowNs));
    // CAP_STATUS: bit n = a ultima captura do canal n foi numa borda de descida.
    u.capStatus = negedge ? (u.capStatus | (1u << channel)) : (u.capStatus & ~(1u << channel));
    u.events.emplace_back(0x108u, u.capStatus);
    mcpwmRaise(u, 27u + channel);
}

void mcpwmFaultChanged(McpwmUnit& u, uint32_t fault, bool active, uint64_t nowNs) {
    const uint32_t bit = 1u << (6u + fault);
    const bool was = (u.faultDetect & bit) != 0;
    if (was == active) return;
    u.faultDetect = active ? (u.faultDetect | bit) : (u.faultDetect & ~bit);
    u.events.emplace_back(0x0E4u, u.faultDetect);
    mcpwmRaise(u, (active ? 9u : 12u) + fault);
    if (!active) return;
    for (uint32_t op = 0; op < 3; ++op) {
        McpwmOperator& o = u.ops[op];
        const bool ost = (o.fhCfg0 >> (7u - fault)) & 1u, cbc = (o.fhCfg0 >> (3u - fault)) & 1u;
        if (ost && !o.ostOn) { o.ostOn = true; mcpwmRaise(u, 24u + op); }
        if (cbc && !o.cbcOn) { o.cbcOn = true; mcpwmRaise(u, 21u + op); }
        if (ost || cbc) {
            u.events.emplace_back(kMcpwmOpBase + kMcpwmOpStride * op + 0x34u, (o.ostOn ? 2u : 0u) | (o.cbcOn ? 1u : 0u));
            mcpwmUpdateOutputs(u, op, nowNs);
        }
    }
}

void mcpwmRunUntil(McpwmUnit& u, uint64_t nowNs);

void mcpwmInputAt(McpwmUnit& u, uint32_t input, bool level, uint64_t nowNs) {
    mcpwmRunUntil(u, nowNs);
    const bool was = u.inputs[input];
    u.inputs[input] = level;
    if (was == level) return;
    if (input < 3) { // SYNC0-2: borda de subida (EXTERNAL_SYNCIn_INVERT inverte)
        const bool inverted = (u.synciCfg >> (9u + input)) & 1u;
        if (level != inverted) mcpwmSync(u, 4u + input, nowNs);
        return;
    }
    if (input < 6) { // F0-2: ativo no nivel FAULTn_POLE, com FAULTn_EN
        const uint32_t f = input - 3u;
        const bool enabled = (u.faultDetect >> f) & 1u, pole = (u.faultDetect >> (3u + f)) & 1u;
        mcpwmFaultChanged(u, f, enabled && level == pole, nowNs);
        return;
    }
    const uint32_t c = input - 6u; // CAP0-2
    const uint32_t cfg = u.capChnCfg[c];
    if (!(cfg & 1u) || !(u.capTimerCfg & 1u)) return;
    const bool effective = level != (((cfg >> 11) & 1u) != 0); // CAPn_IN_INVERT
    const bool wanted = effective ? ((cfg >> 2) & 1u) : ((cfg >> 1) & 1u); // MODE bit2 subida, bit1 descida
    if (!wanted) return;
    if (++u.capEdges[c] < ((cfg >> 3) & 0xFFu) + 1u) return; // CAPn_PRESCALE
    u.capEdges[c] = 0;
    mcpwmCapture(u, c, !effective, nowNs);
}

void mcpwmRunUntil(McpwmUnit& u, uint64_t nowNs);

void mcpwmWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<McpwmModuleState*>(module);
    McpwmUnit& u = s->chip->mcpwm[s->unit];
    const uint32_t offset = static_cast<uint32_t>(address - (s->unit ? kMcpwm1Start : kMcpwm0Start));
    const uint32_t v = static_cast<uint32_t>(value);
    mcpwmRunUntil(u, nowNs); // a escrita vale a partir deste instante: o que veio antes ja' aconteceu
    if (offset == kMcpwmLatchOffset) {
        for (uint32_t i = 0; i < 3; ++i) {
            McpwmTimer& t = u.timers[i];
            uint32_t count = 0;
            bool down = false;
            if (t.running) {
                const uint64_t ticks = nowNs > t.epochNs ? ((nowNs - t.epochNs) * 1000u) / t.tickPs : 0;
                mcpwmCountOf(t, (t.epochPhase + ticks) % mcpwmPhaseLength(t), count, down);
            } else {
                mcpwmCountOf(t, (t.epochPhase + t.ticks) % mcpwmPhaseLength(t), count, down);
            }
            // Na volta do up-down o sentido de STATUS ja' e' o novo: decrescendo em P, crescendo em 0.
            if (mcpwmTimerMode(t) == 3) down = (count == t.period && t.period != 0) || (down && count != 0);
            u.timerStatus[i] = count | (down ? (1u << 16) : 0u);
        }
        return;
    }
    if (offset == 0x000) { u.clkCfg = v; return; }
    if (offset >= 0x004 && offset < 0x034) {
        const uint32_t i = (offset - 0x004) / 0x10u;
        McpwmTimer& t = u.timers[i];
        switch ((offset - 0x004) % 0x10u) {
            case 0x0:
                t.cfg0 = v;
                if (((v >> 24) & 3u) == 0u) { // atualizacao imediata do periodo: a contagem segue de onde esta'
                    const uint64_t phase = (t.epochPhase + (t.running ? std::max(t.ticks, mcpwmElapsedTicks(t, nowNs)) : t.ticks)) %
                                           mcpwmPhaseLength(t);
                    uint32_t count = 0;
                    bool down = false;
                    mcpwmCountOf(t, phase, count, down);
                    t.period = (v >> 8) & 0xFFFFu;
                    mcpwmRebase(t, std::min(count, t.period), down, nowNs);
                    if (t.running) mcpwmScheduleTimer(u, i);
                }
                break;
            case 0x4: {
                t.cfg1 = v;
                const uint32_t start = v & 7u;
                if (mcpwmTimerMode(t) == 0u) {
                    t.running = false;
                    t.nextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
                } else if (start >= 2u) {
                    t.stopAt = start == 3u ? 1u : (start == 4u ? 2u : 0u);
                    if (!t.running) mcpwmStartTimer(u, i, nowNs);
                } else {
                    t.stopAt = start == 0u ? 1u : 2u;
                }
                break;
            }
            case 0x8: {
                const bool toggled = ((t.sync ^ v) >> 1) & 1u; // SYNC_SW: um toggle dispara
                t.sync = v;
                if (toggled && (v & 1u)) {
                    // Software sync deste timer: recarrega a fase; o sync out vai junto.
                    mcpwmRebase(t, (v >> 4) & 0xFFFFu, ((v >> 20) & 1u) != 0, nowNs);
                    if (t.running) mcpwmScheduleTimer(u, i);
                    mcpwmSync(u, 1u + i, nowNs);
                }
                break;
            }
            default: break;
        }
        return;
    }
    if (offset == 0x034) { u.synciCfg = v; return; }
    if (offset == 0x038) {
        u.opTimerSel = v;
        for (uint32_t i = 0; i < 3; ++i) mcpwmRescheduleAt(u, i, nowNs);
        return;
    }
    if (offset >= kMcpwmOpBase && offset < kMcpwmOpBase + 3u * kMcpwmOpStride) {
        const uint32_t op = (offset - kMcpwmOpBase) / kMcpwmOpStride;
        McpwmOperator& o = u.ops[op];
        const bool immediate = !mcpwmShadowEnabled(u, op);
        switch ((offset - kMcpwmOpBase) % kMcpwmOpStride) {
            case 0x00: o.stmpCfg = v; break;
            case 0x04: case 0x08: {
                const uint32_t i = ((offset - kMcpwmOpBase) % kMcpwmOpStride - 0x04u) / 4u;
                o.cmpShadow[i] = v & 0xFFFFu;
                if (immediate || ((o.stmpCfg >> (4u * i)) & 0xFu) == 0u) o.cmpActive[i] = o.cmpShadow[i];
                mcpwmRescheduleAt(u, (u.opTimerSel >> (2u * op)) & 3u, nowNs);
                break;
            }
            case 0x0C: o.genCfg0 = v; break;
            case 0x10: {
                const uint32_t toggled = o.lastForce ^ v;
                o.genForce = v;
                o.lastForce = v;
                // NCIFORCE: um toggle forca o nivel uma vez (NCIFORCE_MODE 1 baixo, 2 alto).
                for (uint32_t g = 0; g < 2; ++g) {
                    if (!((toggled >> (10u + 3u * g)) & 1u)) continue;
                    const uint32_t mode = (v >> (11u + 3u * g)) & 3u;
                    if (mode == 1u) o.gen[g] = false;
                    else if (mode == 2u) o.gen[g] = true;
                }
                mcpwmApplyForce(o);
                mcpwmUpdateOutputs(u, op, nowNs);
                break;
            }
            case 0x14: case 0x18: {
                const uint32_t g = ((offset - kMcpwmOpBase) % kMcpwmOpStride - 0x14u) / 4u;
                o.actionShadow[g] = v;
                if (immediate || (o.genCfg0 & 0xFu) == 0u) o.actionActive[g] = v;
                break;
            }
            case 0x1C: o.dtCfg = v; mcpwmUpdateOutputs(u, op, nowNs); break;
            // O atraso e' DT_FED/DT_RED ciclos ("red*100ns" no driver do ESP-IDF, que grava red).
            case 0x20:
                o.dtFedShadow = v;
                if (immediate || (o.dtCfg & 0xFu) == 0u) o.dtFed = v;
                break;
            case 0x24:
                o.dtRedShadow = v;
                if (immediate || ((o.dtCfg >> 4) & 0xFu) == 0u) o.dtRed = v;
                break;
            case 0x2C: o.fhCfg0 = v; break;
            case 0x30: {
                // CLR_OST limpa na subida; FORCE_CBC/FORCE_OST disparam num toggle (com SW_CBC/SW_OST).
                const uint32_t previous = o.lastFhCfg1;
                o.fhCfg1 = v;
                o.lastFhCfg1 = v;
                const uint32_t toggled = previous ^ v;
                if ((~previous & v) & 1u) o.ostOn = false;
                if (((toggled >> 3) & 1u) && (o.fhCfg0 & 1u) && !o.cbcOn) { o.cbcOn = true; mcpwmRaise(u, 21u + op); }
                if (((toggled >> 4) & 1u) && ((o.fhCfg0 >> 4) & 1u) && !o.ostOn) { o.ostOn = true; mcpwmRaise(u, 24u + op); }
                u.events.emplace_back(kMcpwmOpBase + kMcpwmOpStride * op + 0x34u, (o.ostOn ? 2u : 0u) | (o.cbcOn ? 1u : 0u));
                mcpwmUpdateOutputs(u, op, nowNs);
                break;
            }
            default: break;
        }
        return;
    }
    switch (offset) {
        case 0x0E4: u.faultDetect = (u.faultDetect & 0x1C0u) | (v & 0x3Fu); break;
        case 0x0E8: {
            const bool wasOn = u.capTimerCfg & 1u;
            u.capTimerCfg = v & ~(1u << 5);
            if ((v & 1u) && !wasOn) { u.capEpochNs = nowNs; u.capEpochValue = 0; }
            if (v & (1u << 5)) { u.capEpochNs = nowNs; u.capEpochValue = u.capTimerPhase; } // CAP_SYNC_SW
            break;
        }
        case 0x0EC: u.capTimerPhase = v; break;
        case 0x0F0: case 0x0F4: case 0x0F8: {
            const uint32_t c = (offset - 0x0F0u) / 4u;
            u.capChnCfg[c] = v & ~(1u << 12);
            if ((v >> 12) & 1u) mcpwmCapture(u, c, false, nowNs); // CAPn_SW
            break;
        }
        case 0x10C: {
            const uint32_t toggled = u.updateCfg ^ v;
            u.updateCfg = v;
            // GLOBAL_FORCE_UP (bit1) e OPn_FORCE_UP (bit 3+2n): um toggle passa as sombras ao ativo.
            for (uint32_t op = 0; op < 3; ++op) {
                if (!((toggled >> 1) & 1u) && !((toggled >> (3u + 2u * op)) & 1u)) continue;
                McpwmOperator& o = u.ops[op];
                o.cmpActive = o.cmpShadow;
                o.actionActive = o.actionShadow;
                o.dtFed = o.dtFedShadow;
                o.dtRed = o.dtRedShadow;
            }
            for (uint32_t i = 0; i < 3; ++i) mcpwmRescheduleAt(u, i, nowNs);
            break;
        }
        case 0x110: u.intEna = v; break;
        default: break;
    }
}

void mcpwmWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    mcpwmWriteRegisterAt(module, address, value, 0);
}

uint64_t mcpwmReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<McpwmModuleState*>(module);
    McpwmUnit& u = s->chip->mcpwm[s->unit];
    const uint32_t offset = static_cast<uint32_t>(address - (s->unit ? kMcpwm1Start : kMcpwm0Start));
    if (offset >= kMcpwmStatusOffset && offset < kMcpwmStatusOffset + 12u) return u.timerStatus[(offset - kMcpwmStatusOffset) / 4u];
    if (offset == kMcpwmEventOffset) {
        if (u.events.empty()) return 0;
        const auto [reg, value] = u.events.front();
        u.events.pop_front();
        s->pendingEventValue = value;
        return reg | (1ull << 31);
    }
    if (offset == kMcpwmEventOffset + 4u) return s->pendingEventValue;
    if (offset == kMcpwmArmedOffset) return u.intEna != 0 ? 1u : 0u;
    return 0;
}

uint64_t mcpwmNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<McpwmModuleState*>(module);
    if (s->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    const McpwmUnit& u = s->chip->mcpwm[s->unit];
    uint64_t nearest = LSDN_QEMU_MODULE_NO_WAKEUP;
    for (const McpwmTimer& t : u.timers) nearest = std::min(nearest, delayUntilNs(t.nextNs, nowNs));
    for (const McpwmOperator& o : u.ops) {
        nearest = std::min(nearest, delayUntilNs(o.redDueNs, nowNs));
        nearest = std::min(nearest, delayUntilNs(o.fedDueNs, nowNs));
    }
    return nearest;
}

void mcpwmOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<McpwmModuleState*>(module);
    if (s->chip->digitalClockGated) return;
    mcpwmRunUntil(s->chip->mcpwm[s->unit], nowNs);
}

// Processa, em ordem de tempo, todo evento de timer e fim de atraso do dead time ate' `nowNs`.
void mcpwmRunUntil(McpwmUnit& u, uint64_t nowNs) {
    for (int guard = 0; guard < 64; ++guard) {
        // O mais cedo primeiro: eventos de timer e fins de atraso do dead time.
        uint64_t due = LSDN_QEMU_MODULE_NO_WAKEUP;
        int which = -1;
        for (uint32_t i = 0; i < 3; ++i)
            if (u.timers[i].nextNs < due) { due = u.timers[i].nextNs; which = static_cast<int>(i); }
        for (uint32_t op = 0; op < 3; ++op) {
            if (u.ops[op].redDueNs < due) { due = u.ops[op].redDueNs; which = 10 + static_cast<int>(op); }
            if (u.ops[op].fedDueNs < due) { due = u.ops[op].fedDueNs; which = 20 + static_cast<int>(op); }
        }
        if (which < 0 || due > nowNs) break;
        if (which < 3) {
            mcpwmTimerEvent(u, static_cast<uint32_t>(which), due);
        } else if (which < 20) {
            McpwmOperator& o = u.ops[which - 10];
            o.redDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            o.redLevel = true;
            mcpwmUpdateOutputs(u, static_cast<uint32_t>(which - 10), due);
        } else {
            McpwmOperator& o = u.ops[which - 20];
            o.fedDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            o.fedLevel = false;
            mcpwmUpdateOutputs(u, static_cast<uint32_t>(which - 20), due);
        }
    }
}

void mcpwmReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<McpwmModuleState*>(module);
    s->chip->mcpwm[s->unit] = McpwmUnit{};
    s->chip->mcpwm[s->unit].apbHz = s->chip->apbHz;
}

void mcpwmDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<McpwmModuleState*>(module);
}

const LsdnQemuModuleVTable kMcpwmModuleVTable = {
    &mcpwmReset, &mcpwmWriteRegister, &mcpwmReadRegister, nullptr, nullptr, nullptr, &mcpwmDestroy,
    nullptr, &mcpwmOnWakeup, &mcpwmWriteRegisterAt, nullptr, &mcpwmNextWakeupAt,
};

// ---------------------------------------------------------------------------------------------------
// TWAI (ESP32 TRM, Two-Wire Automotive Interface). Registradores do SJA1000 PeliCAN (soc/twai_struct.h):
// MOD 0x00, CMR 0x04, SR 0x08, IR 0x0C, IER 0x10, BTR0 0x18, BTR1 0x1C, ALC 0x2C, ECC 0x30, EWLR 0x34,
// RXERR 0x38, TXERR 0x3C, ACR0-3/AMR0-3 em 0x40-0x5C no modo reset e o buffer de TX/RX (13 bytes) em
// 0x40-0x70 em operacao, RMC 0x74, CDR 0x7C. O comportamento segue o controlador do OpenCores (can_bsp.v)
// que as erratas do ESP-IDF descrevem: TEC = 128 ao entrar em bus off, descontado a cada 11 recessivos, e
// o bus off so' termina com TEC e REC em 0; o REC para de subir em 128 e volta a 127 numa recepcao boa;
// ALI/BEI so' voltam depois de ler ALC/ECC (isso fica no QEMU); em listen only o flag de erro ativo ainda
// sai dominante (TWAI_ERRATA_FIX_LISTEN_ONLY_DOM).
//
// Tempo: cada bit tem o segmento de sincronismo, TSEG1 e TSEG2 em TQ = 2 (BRP + 1) / APB (x2 com o BRP_DIV
// do IER); amostra no fim de TSEG1 (tres vezes com SAM); hard sync na borda de descida com o barramento
// livre; ressincronizacao de ate' SJW TQ nas outras bordas de descida.
//
// Despertares: as bordas do proprio TX sao suaves, o guest nao para nelas. Um plano previsto (o RX segue
// o TX deste no' e o resto do barramento fica como estava) marca cada instante em que algo observavel muda;
// os que levantam interrupcao vao no despertar rigido (kTwaiHardDueOffset), onde o guest para. Uma borda de
// RX fora do plano (outro no', ACK, arbitragem) refaz o plano no instante dela. CLKOUT nao e' modelado.
constexpr uint64_t kTwaiStart = 0x3FF6B000;
constexpr uint64_t kTwaiEnd = 0x3FF6B2FF;
constexpr uint64_t kTwaiEventOffset = 0x200;   // le e consome o proximo evento: offset | bit 31; valor em 0x204
constexpr uint64_t kTwaiStateOffset = 0x208;   // SR (TBS..BS) | TEC << 8 | REC << 16
constexpr uint64_t kTwaiHardDueOffset = 0x20C; // instante (ns) do proximo despertar que levanta interrupcao
constexpr uint64_t kTwaiApbPs = 12'500;        // APB_CLK 80 MHz
constexpr uint32_t kTwaiIrRi = 0x01, kTwaiIrTi = 0x02, kTwaiIrEi = 0x04, kTwaiIrEpi = 0x20, kTwaiIrAli = 0x40,
                   kTwaiIrBei = 0x80;
constexpr uint32_t kTwaiRaisedEvent = 1u << 31; // na previsao: algum evento saiu (quadro, MOD), com ou sem IRQ
constexpr uint8_t kTwaiModRm = 0x01, kTwaiModLom = 0x02, kTwaiModStm = 0x04, kTwaiModAfm = 0x08;
// ECC: tipo [7:6], direcao 5 (1 = recepcao), segmento [4:0] (tabela do SJA1000)
constexpr uint32_t kTwaiErrBit = 0, kTwaiErrForm = 1, kTwaiErrStuff = 2, kTwaiErrOther = 3;
constexpr uint32_t kTwaiSegSof = 0x03, kTwaiSegId28 = 0x02, kTwaiSegId20 = 0x06, kTwaiSegSrtr = 0x04,
                   kTwaiSegIde = 0x05, kTwaiSegId17 = 0x07, kTwaiSegId12 = 0x0F, kTwaiSegId4 = 0x0E,
                   kTwaiSegRtr = 0x0C, kTwaiSegR1 = 0x0D, kTwaiSegR0 = 0x09, kTwaiSegDlc = 0x0B,
                   kTwaiSegData = 0x0A, kTwaiSegCrc = 0x08, kTwaiSegCrcDelim = 0x18, kTwaiSegAckSlot = 0x19,
                   kTwaiSegAckDelim = 0x1B, kTwaiSegEof = 0x1A, kTwaiSegActFlag = 0x11, kTwaiSegErrDelim = 0x17,
                   kTwaiSegOvlFlag = 0x1C;

struct TwaiModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t pendingEventValue = 0; // valor do evento cujo offset ja' foi lido (kTwaiEventOffset)
};

uint16_t twaiCrcBit(uint16_t crc, bool bit) {
    const bool next = bit != (((crc >> 14) & 1u) != 0);
    crc = static_cast<uint16_t>((crc << 1) & 0x7FFFu);
    return next ? static_cast<uint16_t>(crc ^ 0x4599u) : crc;
}

void twaiEmit(TwaiEngine& e, uint32_t offset, uint32_t value, uint32_t irq) {
    e.raised |= irq | kTwaiRaisedEvent;
    if (e.events && e.events->size() < 4096) e.events->emplace_back(offset, value);
}

void twaiIrq(TwaiEngine& e, uint32_t bits) {
    bits &= e.ier & 0xEFu; // o bit 4 do IER e' o BRP_DIV; um IR so' trava com o enable ligado
    if (bits) twaiEmit(e, 0x0C, bits, bits);
}

// SR sem RBS/DOS (a FIFO de RX mora no QEMU). RS e TS ficam em 1 enquanto o no' espera o barramento livre.
uint32_t twaiStatus(const TwaiEngine& e) {
    const bool wait = e.waitingBusFree;
    return (e.tbs ? 0x04u : 0u) | (e.tcs ? 0x08u : 0u) | ((e.receiving || wait) ? 0x10u : 0u) |
           ((e.transmitting || wait) ? 0x20u : 0u) | (e.es ? 0x40u : 0u) | (e.busOff ? 0x80u : 0u);
}

// Tudo o que o guest ou o circuito veem do controlador: SR, contadores, MOD e o pino de TX.
uint64_t twaiObservable(const TwaiEngine& e) {
    return uint64_t(twaiStatus(e)) | (uint64_t(e.tec) << 8) | (uint64_t(e.rec) << 20) | (uint64_t(e.mode) << 32) |
           (uint64_t(e.txLevel) << 40);
}

void twaiTiming(TwaiEngine& e) {
    const uint64_t brp = (e.btr0 & 0x3Fu) + 1u;
    e.tqPs = 2u * brp * ((e.ier & 0x10u) ? 2u : 1u) * (1'000'000'000'000ull / e.apbHz);
    const uint64_t tseg1 = (e.btr1 & 0x0Fu) + 1u, tseg2 = ((e.btr1 >> 4) & 7u) + 1u;
    e.bitPs = (1u + tseg1 + tseg2) * e.tqPs;
    e.samplePs = (1u + tseg1) * e.tqPs;
    e.sjwTq = ((e.btr0 >> 6) & 3u) + 1u;
    e.triple = (e.btr1 & 0x80u) != 0;
}

void twaiAnchor(TwaiEngine& e, uint64_t atPs) {
    e.bitStartPs = atPs;
    e.sampleAtPs = atPs + e.samplePs;
    e.bitEndPs = atPs + e.bitPs;
    e.sampled = e.resynced = e.txEdgeThisBit = false;
}

void twaiNextBit(TwaiEngine& e) {
    const bool before = e.txLevel;
    twaiAnchor(e, e.bitEndPs);
    e.txLevel = e.nextTx;
    e.txEdgeThisBit = e.txLevel != before;
}

// Barramento livre ha' tempo: o relogio de bit continua na mesma fase; o bit em curso agora vira o atual.
void twaiUnpark(TwaiEngine& e, uint64_t atPs) {
    if (!e.parked) return;
    e.parked = false;
    if (atPs > e.bitStartPs) {
        const uint64_t bits = (atPs - e.bitStartPs) / e.bitPs;
        twaiAnchor(e, e.bitStartPs + bits * e.bitPs);
        e.sampled = e.sampleAtPs < atPs;
    }
}

void twaiSetRx(TwaiEngine& e, uint64_t atPs, bool level) {
    if (level == e.rxLevel) return;
    e.rxChangePs[1] = e.rxChangePs[0];
    e.rxBefore[1] = e.rxBefore[0];
    e.rxChangePs[0] = atPs;
    e.rxBefore[0] = e.rxLevel;
    e.rxLevel = level;
}

bool twaiLevelAt(const TwaiEngine& e, uint64_t atPs) {
    if (atPs >= e.rxChangePs[0]) return e.rxLevel;
    if (atPs >= e.rxChangePs[1]) return e.rxBefore[0];
    return e.rxBefore[1];
}

// O nivel amostrado: uma vez no ponto de amostragem, ou a maioria de tres (SAM: 2 TQ, 1 TQ antes e nele).
bool twaiSampleValue(const TwaiEngine& e) {
    if (!e.triple) return e.rxLevel;
    const int votes = int(twaiLevelAt(e, e.sampleAtPs - 2u * e.tqPs)) + int(twaiLevelAt(e, e.sampleAtPs - e.tqPs)) +
                      int(e.rxLevel);
    return votes >= 2;
}

// O RX previsto neste bit: segue o TX deste no' e o que o barramento mostrava; desligado, fica onde esta'.
bool twaiPredictedRx(const TwaiEngine& e) { return e.rxFollow == 2 ? e.rxLevel : (e.txLevel && e.ext); }

void twaiSetTbs(TwaiEngine& e) {
    if (e.tbs) return;
    e.tbs = true; // TI na subida do TBS
    twaiIrq(e, kTwaiIrTi);
}

void twaiFinishTx(TwaiEngine& e, bool success) {
    e.needTx = e.selfRx = e.singleShot = e.abortTx = false;
    e.tcs = success;
    twaiSetTbs(e);
}

bool twaiCanTransmit(const TwaiEngine& e) { return e.needTx && !(e.mode & kTwaiModLom) && !e.busOff; }

void twaiEnterReset(TwaiEngine& e) {
    e.phase = TwaiPhase::Reset;
    e.parked = false;
    e.txRole = e.ackDrive = e.transmitting = e.receiving = false;
    e.waitingBusFree = true;
    e.needTx = e.selfRx = e.singleShot = e.abortTx = false;
    twaiSetTbs(e); // em reset o buffer de TX esta' livre
    e.txLevel = e.nextTx = true;
    e.busFreeEnabled = false;
    e.busFreeCount = 0;
    e.rxFollow = 0;
}

void twaiEnterBusOff(TwaiEngine& e) {
    e.busOff = true;
    e.mode |= kTwaiModRm; // o hardware entra em reset sozinho
    e.tec = 128;          // conta a recuperacao: um a menos a cada 11 recessivos
    e.rec = 0;
    twaiEmit(e, 0x00, e.mode, 0);
    twaiEnterReset(e);
}

// Depois de qualquer mudanca de TEC/REC/EWL: bus off, error passive (EPI) e ES/BS (EI).
void twaiCounters(TwaiEngine& e) {
    if (e.tec >= 256 && !e.busOff) twaiEnterBusOff(e);
    if (e.busOff && e.tec == 0 && e.rec == 0 && !(e.mode & kTwaiModRm)) e.busOff = false;
    const bool over = e.tec >= 128 || e.rec >= 128;
    if (!over && e.passive) {
        e.passive = false;
        if (!e.busOff) twaiIrq(e, kTwaiIrEpi); // de passive para active; saindo de bus off nao ha' EPI
    } else if (over && !e.passive && !e.busOff && e.phase != TwaiPhase::Reset) {
        e.passive = true; // em reset so' na saida (OpenCores: error_frame/go_error_frame/saida do reset)
        twaiIrq(e, kTwaiIrEpi);
    }
    const bool es = e.tec >= e.ewl || e.rec >= e.ewl;
    if (es != e.es || e.busOff != e.eiBusOff) {
        e.es = es;
        e.eiBusOff = e.busOff;
        twaiIrq(e, kTwaiIrEi);
    }
}

void twaiLeaveReset(TwaiEngine& e, uint64_t atPs) {
    twaiTiming(e);
    e.phase = TwaiPhase::Integrating;
    e.parked = false;
    e.busFreeEnabled = e.waitingBusFree = true;
    e.busFreeCount = 0;
    e.ext = e.rxLevel;
    twaiAnchor(e, atPs);
    e.txLevel = e.nextTx = true;
    twaiCounters(e);
}

void twaiStartRx(TwaiEngine& e) {
    e.n = e.run = e.id = e.dlc = e.dataLen = e.crcStart = e.tail = 0;
    e.runLevel = e.b12 = e.ide = e.rtr = e.crcErr = e.ackDrive = false;
    e.stuffed = true;
    e.data = {};
    e.crc = e.crcRx = 0;
    e.phase = TwaiPhase::Frame;
    e.overloads = 0;
}

// O quadro do buffer de TX como sai no fio: SOF ate' o fim do CRC com stuffing, depois o delimitador do CRC,
// o slot e o delimitador do ACK e os 7 bits de EOF.
void twaiBuildTx(TwaiEngine& e) {
    const std::array<uint8_t, 13>& b = e.txBuf;
    const bool ext = (b[0] & 0x80u) != 0, remote = (b[0] & 0x40u) != 0;
    const uint32_t dlc = b[0] & 0x0Fu, len = remote ? 0u : std::min<uint32_t>(dlc, 8u);
    std::vector<uint8_t> bits; // nivel (bit 0) | arbitragem (bit 2)
    const auto put = [&bits](uint32_t value, int count, bool arbitration) {
        for (int i = count - 1; i >= 0; --i)
            bits.push_back(static_cast<uint8_t>(((value >> i) & 1u) | (arbitration ? 4u : 0u)));
    };
    put(0, 1, false); // SOF
    if (ext) {
        const uint32_t id = (uint32_t(b[1]) << 21) | (uint32_t(b[2]) << 13) | (uint32_t(b[3]) << 5) | (uint32_t(b[4]) >> 3);
        put(id >> 18, 11, true);
        put(3, 2, true); // SRR, IDE
        put(id & 0x3FFFFu, 18, true);
        put(remote ? 1u : 0u, 1, true);
        put(0, 2, false); // r1, r0
    } else {
        put((uint32_t(b[1]) << 3) | (uint32_t(b[2]) >> 5), 11, true);
        put(remote ? 1u : 0u, 1, true);
        put(0, 2, false); // IDE, r0
    }
    put(dlc, 4, false);
    for (uint32_t i = 0; i < len; ++i) put(b[(ext ? 5u : 3u) + i], 8, false);
    uint16_t crc = 0;
    for (const uint8_t bit : bits) crc = twaiCrcBit(crc, (bit & 1u) != 0);
    put(crc, 15, false);
    e.txBits.clear();
    uint32_t run = 0;
    bool last = false;
    for (const uint8_t bit : bits) {
        const bool level = (bit & 1u) != 0;
        if (run == 5) { // depois de 5 iguais, um bit complementar (marcado como stuffing)
            last = !last;
            e.txBits.push_back(static_cast<uint8_t>((last ? 1u : 0u) | 2u | (e.txBits.back() & 4u)));
            run = 1;
        }
        if (run && level == last) ++run;
        else { last = level; run = 1; }
        e.txBits.push_back(bit);
    }
    if (run == 5) e.txBits.push_back(static_cast<uint8_t>((last ? 0u : 1u) | 2u));
    for (int i = 0; i < 10; ++i) e.txBits.push_back(1); // delimitador do CRC, ACK, delimitador do ACK, EOF
}

enum class TwaiBit : uint8_t { Ok, StuffBit, StuffError, FormError, CrcDelim, AckSlot, AckDelim, Eof6, Eof7, Eof7Dominant };

// Um bit do barramento no decodificador do quadro (todo no' decodifica, o transmissor tambem).
TwaiBit twaiDecode(TwaiEngine& e, bool bit) {
    if (e.stuffed) {
        if (e.run == 5) { // so' pode ser um bit de stuffing
            if (bit == e.runLevel) return TwaiBit::StuffError;
            e.runLevel = bit;
            e.run = 1;
            if (e.crcStart && e.n == e.crcStart + 15u) e.stuffed = false;
            return TwaiBit::StuffBit;
        }
        if (e.run && bit == e.runLevel) ++e.run;
        else { e.runLevel = bit; e.run = 1; }
        const uint32_t n = e.n++, b = bit ? 1u : 0u;
        if (!e.crcStart || n < e.crcStart) e.crc = twaiCrcBit(e.crc, bit);
        const uint32_t dlcEnd = e.ide ? 38u : 18u;
        if (n == 0) {
        } else if (n <= 11) e.id = (e.id << 1) | b;
        else if (n == 12) e.b12 = bit;
        else if (n == 13) { e.ide = bit; e.rtr = !bit && e.b12; }
        else if (e.ide && n <= 31) e.id = (e.id << 1) | b;
        else if (e.ide && n == 32) e.rtr = bit;
        else if (n <= dlcEnd - 4u) {
        } else if (n <= dlcEnd) {
            e.dlc = (e.dlc << 1) | b;
            if (n == dlcEnd) {
                e.dataLen = e.rtr ? 0u : std::min<uint32_t>(e.dlc, 8u);
                e.crcStart = dlcEnd + 1u + 8u * e.dataLen;
            }
        } else if (n < e.crcStart) {
            uint8_t& byte = e.data[(n - dlcEnd - 1u) / 8u];
            byte = static_cast<uint8_t>((byte << 1) | b);
        } else e.crcRx = static_cast<uint16_t>(((uint32_t(e.crcRx) << 1) | b) & 0x7FFFu);
        if (e.crcStart && e.n == e.crcStart + 15u) {
            e.crcErr = e.crcRx != e.crc;
            if (e.run != 5) e.stuffed = false; // com 5 iguais no fim do CRC ainda vem um bit de stuffing
        }
        return TwaiBit::Ok;
    }
    switch (e.tail++) {
        case 0: return bit ? TwaiBit::CrcDelim : TwaiBit::FormError;
        case 1: return TwaiBit::AckSlot;
        case 2: return bit ? TwaiBit::AckDelim : TwaiBit::FormError;
        case 8: return bit ? TwaiBit::Eof6 : TwaiBit::FormError;
        case 9: return bit ? TwaiBit::Eof7 : TwaiBit::Eof7Dominant;
        default: return bit ? TwaiBit::Ok : TwaiBit::FormError; // EOF1..5
    }
}

// Segmento (ECC) do bit que o decodificador vai ler agora.
uint32_t twaiSegment(const TwaiEngine& e) {
    if (!e.stuffed) {
        switch (e.tail) {
            case 0: return kTwaiSegCrcDelim;
            case 1: return kTwaiSegAckSlot;
            case 2: return kTwaiSegAckDelim;
            default: return kTwaiSegEof;
        }
    }
    const uint32_t n = e.n;
    if (n == 0) return kTwaiSegSof;
    if (n <= 8) return kTwaiSegId28;
    if (n <= 11) return kTwaiSegId20;
    if (n == 12) return e.txRole && (e.txBuf[0] & 0x80u) ? kTwaiSegSrtr : kTwaiSegRtr;
    if (n == 13) return kTwaiSegIde;
    if (e.ide) {
        if (n <= 18) return kTwaiSegId17;
        if (n <= 26) return kTwaiSegId12;
        if (n <= 31) return kTwaiSegId4;
        if (n == 32) return kTwaiSegRtr;
        if (n == 33) return kTwaiSegR1;
        if (n == 34) return kTwaiSegR0;
        if (n <= 38) return kTwaiSegDlc;
    } else {
        if (n == 14) return kTwaiSegR0;
        if (n <= 18) return kTwaiSegDlc;
    }
    return n < e.crcStart ? kTwaiSegData : kTwaiSegCrc;
}

bool twaiMatch(uint8_t value, uint8_t code, uint8_t mask) { return ((value ^ code) & ~mask & 0xFFu) == 0; }

// Filtro de aceitacao do SJA1000 (AMR em 1 = nao compara); os bytes de dado so' contam se o quadro os tem.
bool twaiAccept(const TwaiEngine& e, const std::array<uint8_t, 16>& f, uint32_t len) {
    const std::array<uint8_t, 4>& c = e.acr;
    const std::array<uint8_t, 4>& m = e.amr;
    const bool ext = (f[0] & 0x80u) != 0;
    if (e.mode & kTwaiModAfm) { // filtro unico
        if (!ext)
            return twaiMatch(f[1], c[0], m[0]) && twaiMatch(f[2], c[1], m[1] | 0x0Fu) &&
                   (len < 1 || twaiMatch(f[3], c[2], m[2])) && (len < 2 || twaiMatch(f[4], c[3], m[3]));
        return twaiMatch(f[1], c[0], m[0]) && twaiMatch(f[2], c[1], m[1]) && twaiMatch(f[3], c[2], m[2]) &&
               twaiMatch(f[4], c[3], m[3] | 0x03u);
    }
    if (!ext) { // dois filtros: o 1 tambem olha o primeiro byte de dado (ACR1/AMR1 [3:0] e ACR3/AMR3 [3:0])
        const bool first = twaiMatch(f[1], c[0], m[0]) && twaiMatch(f[2], c[1], m[1] | 0x0Fu) &&
                           (len < 1 || twaiMatch(f[3], static_cast<uint8_t>((c[1] << 4) | (c[3] & 0x0Fu)),
                                                 static_cast<uint8_t>((m[1] << 4) | (m[3] & 0x0Fu))));
        const bool second = twaiMatch(f[1], c[2], m[2]) && twaiMatch(f[2], c[3], m[3] | 0x0Fu);
        return first || second;
    }
    return (twaiMatch(f[1], c[0], m[0]) && twaiMatch(f[2], c[1], m[1])) ||
           (twaiMatch(f[1], c[2], m[2]) && twaiMatch(f[2], c[3], m[3]));
}

// Quadro valido no sexto bit do EOF: vai para a FIFO de RX do QEMU (13 bytes como o buffer de RX).
void twaiStoreRx(TwaiEngine& e) {
    std::array<uint8_t, 16> f{};
    f[0] = static_cast<uint8_t>((e.ide ? 0x80u : 0u) | (e.rtr ? 0x40u : 0u) | (e.dlc & 0x0Fu));
    uint32_t at = 3;
    if (e.ide) {
        f[1] = static_cast<uint8_t>(e.id >> 21);
        f[2] = static_cast<uint8_t>(e.id >> 13);
        f[3] = static_cast<uint8_t>(e.id >> 5);
        f[4] = static_cast<uint8_t>(((e.id & 0x1Fu) << 3) | (e.rtr ? 0x04u : 0u));
        at = 5;
    } else {
        f[1] = static_cast<uint8_t>(e.id >> 3);
        f[2] = static_cast<uint8_t>(((e.id & 7u) << 5) | (e.rtr ? 0x10u : 0u));
    }
    for (uint32_t i = 0; i < e.dataLen; ++i) f[at + i] = e.data[i];
    if (!twaiAccept(e, f, e.dataLen)) return;
    for (uint32_t w = 0; w < 4; ++w)
        twaiEmit(e, 0x40u + 4u * w,
                 uint32_t(f[4 * w]) | (uint32_t(f[4 * w + 1]) << 8) | (uint32_t(f[4 * w + 2]) << 16) | (uint32_t(f[4 * w + 3]) << 24), 0);
    twaiEmit(e, 0x74, at + e.dataLen, (e.ier & kTwaiIrRi) ? kTwaiIrRi : 0u);
}

// Erro detectado neste bit: ECC/BEI, contadores (regras 1 e 3 com as excecoes) e o flag a partir do proximo.
void twaiError(TwaiEngine& e, uint32_t type, uint32_t segment, bool asTx, bool countTec = true) {
    const bool lom = (e.mode & kTwaiModLom) != 0;
    twaiEmit(e, 0x30, (type << 6) | (asTx ? 0u : 0x20u) | segment, (e.ier & kTwaiIrBei) ? kTwaiIrBei : 0u);
    e.ackErrExc = false;
    if (asTx) {
        // Excecao 1: error passive sem ACK so' conta se aparecer um dominante no flag passivo.
        if (type == kTwaiErrOther && segment == kTwaiSegAckSlot && e.passive) e.ackErrExc = true;
        else if (countTec) e.tec += 8;
    } else if (!lom && e.rec < 128) e.rec += 1;
    const bool wasTx = e.txRole;
    e.flagByTx = asTx;
    e.txRole = e.ackDrive = false;
    if (wasTx && (e.singleShot || e.abortTx)) twaiFinishTx(e, false);
    e.phase = TwaiPhase::ErrorFlag;
    e.count = e.same = 0;
    twaiCounters(e);
    if (e.phase != TwaiPhase::ErrorFlag) return; // bus off
    e.flagPassive = e.passive;
    e.nextTx = e.flagPassive; // ativo: 6 dominantes; passivo: 6 recessivos
}

void twaiStartOverload(TwaiEngine& e) {
    e.phase = TwaiPhase::OverloadFlag;
    e.count = 0;
    e.flagByTx = e.lastWasTx;
    e.txRole = e.ackDrive = false;
    e.nextTx = false;
    ++e.overloads;
}

void twaiStartOwnFrame(TwaiEngine& e) {
    twaiStartRx(e);
    e.txRole = e.transmitting = e.lastWasTx = true;
    e.receiving = false;
    e.txPos = 0;
    e.nextTx = (e.txBits[0] & 1u) != 0; // o SOF, dominante
}

// SOF de outro no' (amostrado dominante com o barramento livre): com um quadro pendente e podendo, entra na
// arbitragem a partir do ID; senao recebe.
void twaiSofDetected(TwaiEngine& e, bool joinable) {
    twaiStartRx(e);
    twaiDecode(e, false);
    if (joinable && twaiCanTransmit(e)) {
        e.txRole = e.transmitting = e.lastWasTx = true;
        e.receiving = false;
        e.txPos = 1;
        e.nextTx = (e.txBits[1] & 1u) != 0;
        return;
    }
    e.txRole = e.transmitting = e.lastWasTx = false;
    e.receiving = true;
    e.nextTx = true;
}

void twaiIdleOrStart(TwaiEngine& e) {
    e.transmitting = e.receiving = false;
    if (twaiCanTransmit(e)) {
        twaiStartOwnFrame(e);
        return;
    }
    e.phase = TwaiPhase::Idle;
    e.nextTx = true;
    e.parked = true;
}

void twaiFrameSample(TwaiEngine& e, bool bit) {
    const bool lom = (e.mode & kTwaiModLom) != 0;
    const uint32_t segment = twaiSegment(e);
    if (e.txRole) {
        const uint8_t sentBits = e.txBits[e.txPos];
        const bool sent = (sentBits & 1u) != 0;
        if (sent != bit) {
            const bool ackSlot = !e.stuffed && e.tail == 1;
            if (!sent) { // mandou dominante e leu recessivo
                twaiError(e, kTwaiErrBit, segment, true);
                return;
            }
            if (!ackSlot) {
                if (!(sentBits & 4u)) {
                    twaiError(e, kTwaiErrBit, segment, true);
                    return;
                }
                if (sentBits & 2u) { // stuffing recessivo lido dominante na arbitragem: excecao 2 (TEC nao conta)
                    twaiError(e, kTwaiErrStuff, segment, true, false);
                    return;
                }
                // Arbitragem perdida: segue como receptor deste quadro e tenta de novo depois.
                twaiEmit(e, 0x2C, e.n - 1u, (e.ier & kTwaiIrAli) ? kTwaiIrAli : 0u);
                e.txRole = e.transmitting = e.lastWasTx = false;
                e.receiving = true;
                if (e.singleShot || e.abortTx) twaiFinishTx(e, false);
            }
        }
    } else if (e.ackDrive && bit) {
        twaiError(e, kTwaiErrBit, kTwaiSegAckSlot, false);
        return;
    }
    switch (twaiDecode(e, bit)) {
        case TwaiBit::StuffError: twaiError(e, kTwaiErrStuff, segment, e.txRole); return;
        case TwaiBit::FormError: twaiError(e, kTwaiErrForm, segment, e.txRole); return;
        case TwaiBit::CrcDelim:
            if (!e.txRole && !e.crcErr && !lom) e.ackDrive = true; // o slot seguinte: ACK dominante
            break;
        case TwaiBit::AckSlot:
            e.ackDrive = false;
            if (e.txRole && bit && !(e.mode & kTwaiModStm)) { // ninguem deu ACK (o self test dispensa)
                twaiError(e, kTwaiErrOther, kTwaiSegAckSlot, true);
                return;
            }
            break;
        case TwaiBit::AckDelim:
            if (!e.txRole) {
                if (e.crcErr) { // erro de CRC: o flag comeca depois do delimitador do ACK
                    twaiError(e, kTwaiErrOther, kTwaiSegAckDelim, false);
                    return;
                }
                if (!lom && e.rec > 0) {
                    e.rec = e.rec > 127 ? 127 : e.rec - 1;
                    twaiCounters(e);
                }
            }
            break;
        case TwaiBit::Eof6:
            if (!e.txRole || e.selfRx) twaiStoreRx(e); // valido para o receptor no penultimo bit do EOF
            break;
        case TwaiBit::Eof7:
            if (e.txRole) { // valido para o transmissor no fim do EOF
                e.txRole = false;
                if (e.tec > 0) --e.tec;
                twaiFinishTx(e, true);
                twaiCounters(e);
            }
            e.phase = TwaiPhase::Intermission;
            e.count = 0;
            e.nextTx = true;
            return;
        case TwaiBit::Eof7Dominant:
            if (e.txRole) {
                twaiError(e, kTwaiErrForm, kTwaiSegEof, true);
                return;
            }
            twaiStartOverload(e);
            return;
        default: break;
    }
    if (e.txRole) {
        ++e.txPos;
        e.nextTx = e.txPos >= e.txBits.size() || (e.txBits[e.txPos] & 1u) != 0;
    } else {
        e.nextTx = !e.ackDrive;
    }
}

// O ponto de amostragem de um bit: o protocolo anda um bit e decide o nivel do proximo.
void twaiOnSample(TwaiEngine& e, bool bit) {
    const bool lom = (e.mode & kTwaiModLom) != 0;
    switch (e.phase) {
        case TwaiPhase::Reset: return;
        case TwaiPhase::Integrating:
            e.nextTx = true;
            if (!e.busFreeEnabled) return;
            if (!bit) {
                e.busFreeCount = 0;
                return;
            }
            if (e.busFreeCount < 10) {
                ++e.busFreeCount;
                return;
            }
            e.busFreeCount = 0; // 11 recessivos: barramento livre
            if (e.tec > 0) --e.tec;
            if (e.busOff) { // recuperacao: o bus off termina com TEC e REC em 0
                twaiCounters(e);
                return;
            }
            e.waitingBusFree = e.busFreeEnabled = false;
            twaiCounters(e);
            twaiIdleOrStart(e);
            return;
        case TwaiPhase::Idle:
            if (!bit) twaiSofDetected(e, true);
            else if (twaiCanTransmit(e)) twaiStartOwnFrame(e);
            else { e.nextTx = true; e.parked = true; }
            return;
        case TwaiPhase::Suspend:
            if (!bit) twaiSofDetected(e, false);
            else if (++e.count >= 8) twaiIdleOrStart(e);
            else e.nextTx = true;
            return;
        case TwaiPhase::Intermission:
            ++e.count;
            if (!bit) {
                if (e.count <= 2) twaiStartOverload(e);
                else twaiSofDetected(e, true); // dominante no terceiro bit: SOF de outro no'
                return;
            }
            if (e.count >= 3) {
                e.transmitting = e.receiving = false;
                if (e.lastWasTx && e.passive) {
                    e.phase = TwaiPhase::Suspend;
                    e.count = 0;
                    e.nextTx = true;
                    return;
                }
                twaiIdleOrStart(e);
                return;
            }
            e.nextTx = true;
            return;
        case TwaiPhase::Frame: twaiFrameSample(e, bit); return;
        case TwaiPhase::ErrorFlag:
        case TwaiPhase::OverloadFlag: {
            const bool overload = e.phase == TwaiPhase::OverloadFlag;
            if (overload || !e.flagPassive) {
                if (bit) { // bit error no flag dominante: +8 e o flag recomeca (regras 4 e 5)
                    if (e.flagByTx) e.tec += 8;
                    else if (!lom && e.rec < 128) e.rec += 8;
                    twaiEmit(e, 0x30, (kTwaiErrBit << 6) | (e.flagByTx ? 0u : 0x20u) | (overload ? kTwaiSegOvlFlag : kTwaiSegActFlag),
                             (e.ier & kTwaiIrBei) ? kTwaiIrBei : 0u);
                    e.count = 0;
                    twaiCounters(e);
                    if (e.phase != TwaiPhase::Reset) e.nextTx = false;
                    return;
                }
                if (++e.count >= 6) {
                    e.phase = overload ? TwaiPhase::OverloadWait : TwaiPhase::ErrorWait;
                    e.dominantRun = 6;
                    e.firstAfterFlag = true;
                    e.nextTx = true;
                    return;
                }
                e.nextTx = false;
                return;
            }
            // Flag passivo: completo com 6 bits iguais seguidos, de qualquer nivel.
            if (!bit && e.ackErrExc) {
                e.ackErrExc = false;
                e.tec += 8;
                twaiCounters(e);
                if (e.phase == TwaiPhase::Reset) return;
            }
            if (e.same && bit == e.sameLevel) ++e.same;
            else { e.sameLevel = bit; e.same = 1; }
            if (e.same >= 6) {
                e.phase = TwaiPhase::ErrorWait;
                e.dominantRun = 0;
                e.firstAfterFlag = true;
            }
            e.nextTx = true;
            return;
        }
        case TwaiPhase::ErrorWait:
        case TwaiPhase::OverloadWait: {
            const bool overload = e.phase == TwaiPhase::OverloadWait;
            if (bit) { // o primeiro recessivo ja' e' o primeiro bit do delimitador
                e.phase = overload ? TwaiPhase::OverloadDelim : TwaiPhase::ErrorDelim;
                e.count = 1;
                e.nextTx = true;
                return;
            }
            if (!overload && e.firstAfterFlag && !e.flagByTx && !lom && e.rec < 128) e.rec += 8; // regra 2
            e.firstAfterFlag = false;
            ++e.dominantRun;
            // Regra 6: o 14o dominante seguido (8o depois de um flag passivo) e cada 8 a mais.
            const uint32_t first = (!overload && e.flagPassive) ? 8u : 14u;
            if (e.dominantRun >= first && (e.dominantRun - first) % 8u == 0) {
                if (e.flagByTx) e.tec += 8;
                else if (!lom && e.rec < 128) e.rec += 8;
            }
            twaiCounters(e);
            if (e.phase != TwaiPhase::Reset) e.nextTx = true;
            return;
        }
        case TwaiPhase::ErrorDelim:
        case TwaiPhase::OverloadDelim:
            if (!bit) {
                twaiError(e, kTwaiErrForm, kTwaiSegErrDelim, e.flagByTx);
                return;
            }
            if (++e.count >= 8) {
                e.phase = TwaiPhase::Intermission;
                e.count = 0;
            }
            e.nextTx = true;
            return;
    }
}

void twaiSample(TwaiEngine& e, bool bit) {
    e.sampled = true;
    if (e.txLevel) e.ext = bit;
    e.raised = 0;
    twaiOnSample(e, bit);
    e.lastSampled = bit;
}

// Estados que podem durar indefinidamente sem mudar nada observavel com o barramento preso em dominante:
// esperando o barramento livre, ou um receptor com o REC no teto esperando o fim de um erro.
bool twaiStableDominant(const TwaiEngine& e) {
    if (e.rxLevel || !e.sampled || e.lastSampled) return false;
    if (e.phase == TwaiPhase::Integrating) return true;
    return (e.phase == TwaiPhase::ErrorWait || e.phase == TwaiPhase::OverloadWait) && !e.flagByTx &&
           !e.firstAfterFlag && ((e.mode & kTwaiModLom) || e.rec >= 128);
}

// Processa os pontos de amostragem e inicios de bit ate' nowPs (inclusive: um despertar; exclusive: uma
// borda de RX ou uma escrita, cujo instante ainda vem). Marca o plano para refazer se o barramento saiu do
// previsto.
void twaiRun(TwaiState& s, uint64_t nowPs, bool inclusive) {
    TwaiEngine& e = s.e;
    for (uint32_t guard = 0; guard < (1u << 24); ++guard) {
        if (e.phase == TwaiPhase::Reset || e.parked) return;
        if (twaiStableDominant(e) && e.bitEndPs + e.bitPs < nowPs) {
            const uint64_t bits = (nowPs - e.bitEndPs) / e.bitPs - 1u;
            e.bitStartPs += bits * e.bitPs;
            e.sampleAtPs += bits * e.bitPs;
            e.bitEndPs += bits * e.bitPs;
            e.dominantRun += static_cast<uint32_t>(std::min<uint64_t>(bits, 1u << 20));
        }
        const uint64_t at = e.sampled ? e.bitEndPs : e.sampleAtPs;
        if (at > nowPs || (!inclusive && at == nowPs)) return;
        if (e.sampled) {
            twaiNextBit(e);
            continue;
        }
        const bool bit = twaiSampleValue(e);
        if (bit != twaiPredictedRx(e)) s.replan = true;
        // So' a descida prova a ligacao (um RX solto e recessivo coincide com o TX subindo).
        if (e.txEdgeThisBit && !e.txLevel && !bit) e.rxFollow = 1;
        else if (!e.txLevel && bit) e.rxFollow = 2; // dirigindo dominante e o barramento recessivo: RX solto
        twaiSample(e, bit);
    }
}

// Previsao a partir do estado atual: copia o motor e anda com o RX previsto, anotando cada instante em que o
// pino de TX ou algo observavel muda. Os que levantam interrupcao sao rigidos, a menos que a previsao dependa
// de outro no' (recebendo o quadro dele, ou com ele dirigindo dominante agora): esses chegam como bordas.
// Enquanto nao se viu o RX seguir o TX, o ponto de amostragem depois de cada borda do TX tambem e' rigido.
void twaiPlan(TwaiState& s) {
    s.plan.clear();
    s.planPos = 0;
    s.replan = false;
    const TwaiEngine& real = s.e;
    if (real.phase == TwaiPhase::Reset || real.parked) return;
    TwaiEngine sim = real;
    sim.events = nullptr;
    const auto push = [&s](uint64_t atPs, bool hard) {
        if (!s.plan.empty() && s.plan.back().atPs == atPs) s.plan.back().hard = s.plan.back().hard || hard;
        else s.plan.push_back(TwaiPlanPoint{atPs, hard});
    };
    bool verify = false;
    for (uint32_t step = 0; step < 4096; ++step) {
        if (sim.phase == TwaiPhase::Reset || sim.parked) break;
        if (sim.sampled) {
            const uint64_t at = sim.bitEndPs;
            const bool before = sim.txLevel;
            twaiNextBit(sim);
            twaiSetRx(sim, at, twaiPredictedRx(sim));
            if (sim.txLevel != before) {
                push(at, false);
                verify = true;
            }
            continue;
        }
        const uint64_t at = sim.sampleAtPs;
        const bool speculative = !sim.ext || (sim.phase == TwaiPhase::Frame && !sim.txRole && sim.stuffed);
        const uint64_t before = twaiObservable(sim);
        twaiSample(sim, twaiSampleValue(sim));
        const bool changed = sim.raised != 0 || twaiObservable(sim) != before;
        const bool irq = (sim.raised & 0xFFu) != 0;
        const bool hard = (irq && !speculative) || (verify && real.rxFollow != 1);
        if (changed || verify) push(at, hard);
        verify = false;
        if ((irq && hard) || (speculative && changed)) break;
    }
}

// Descarta os pontos ja' feitos e refaz o plano se o barramento saiu do previsto ou ele acabou.
void twaiAfter(TwaiState& s, uint64_t nowPs, bool inclusive) {
    while (s.planPos < s.plan.size() &&
           (s.plan[s.planPos].atPs < nowPs || (inclusive && s.plan[s.planPos].atPs == nowPs)))
        ++s.planPos;
    if (s.replan || s.planPos >= s.plan.size()) twaiPlan(s);
}

void twaiResync(TwaiEngine& e, uint64_t atPs) {
    e.resynced = true;
    if (!e.sampled) { // antes do ponto de amostragem: borda atrasada, a fase 1 cresce
        const uint64_t late = (atPs - e.bitStartPs) / e.tqPs;
        const uint64_t shift = std::min<uint64_t>(late, e.sjwTq) * e.tqPs;
        e.sampleAtPs += shift;
        e.bitEndPs += shift;
    } else { // depois: borda adiantada (e' do proximo bit), a fase 2 encolhe
        const uint64_t early = (e.bitEndPs - atPs + e.tqPs - 1u) / e.tqPs;
        const uint64_t shift = std::min<uint64_t>(early, e.sjwTq) * e.tqPs;
        e.bitEndPs = std::max(e.bitEndPs - shift, atPs);
    }
}

void twaiInputAt(TwaiState& s, bool level, uint64_t nowNs) {
    TwaiEngine& e = s.e;
    e.events = &s.events;
    if (level == e.rxLevel) return;
    const uint64_t at = nowNs * 1000u;
    twaiRun(s, at, false); // os pontos antes da borda ainda veem o nivel antigo
    const bool active = e.phase != TwaiPhase::Reset && !e.parked;
    // A borda que o proprio TX acabou de pôr no barramento ja' estava no plano.
    const bool expected = active && e.rxFollow != 2 && !e.sampled && e.bitStartPs == at && level == (e.txLevel && e.ext);
    const bool falling = e.rxLevel && !level;
    twaiSetRx(e, at, level);
    if (e.txLevel) e.ext = level;
    if (falling && e.phase != TwaiPhase::Reset && !expected) {
        if (e.phase == TwaiPhase::Idle || e.phase == TwaiPhase::Integrating || e.phase == TwaiPhase::Intermission ||
            e.phase == TwaiPhase::Suspend) {
            e.parked = false; // hard sync: o bit comeca na borda
            twaiAnchor(e, at);
            e.resynced = true;
        } else if (!e.resynced && e.lastSampled) {
            twaiResync(e, at);
        }
    }
    if (!expected) s.replan = true;
    twaiAfter(s, at, false);
}

void twaiWrite(TwaiEngine& e, uint64_t offset, uint32_t value, uint64_t atPs) {
    const bool reset = (e.mode & kTwaiModRm) != 0;
    const uint8_t v = static_cast<uint8_t>(value);
    switch (offset) {
        case 0x00: { // LOM/STM/AFM so' em reset; RM sempre
            const uint8_t next = reset ? static_cast<uint8_t>(v & 0x0Fu) : static_cast<uint8_t>((e.mode & 0x0Eu) | (v & 1u));
            e.mode = next;
            if (!reset && (next & kTwaiModRm)) twaiEnterReset(e);
            else if (reset && !(next & kTwaiModRm)) twaiLeaveReset(e, atPs);
            return;
        }
        case 0x04: // CMR: TR 0, AT 1, SRR 4 (RRB e CDO sao da FIFO, no QEMU)
            if (reset) return;
            if ((v & 0x11u) && e.tbs && !(e.mode & kTwaiModLom)) {
                e.needTx = true;
                e.tbs = e.tcs = false;
                e.selfRx = (v & 0x10u) != 0;
                e.singleShot = (v & 0x02u) != 0; // TR ou SRR junto com AT: uma tentativa so'
                e.abortTx = false;
                twaiBuildTx(e);
                twaiUnpark(e, atPs);
            } else if ((v & 0x02u) && e.needTx) {
                if (!e.transmitting) twaiFinishTx(e, false); // ainda nao comecou: cancela
                else e.abortTx = true;                        // em curso: termina, sem nova tentativa
            }
            return;
        case 0x10: e.ier = v; return;
        case 0x18: if (reset) e.btr0 = v; return;
        case 0x1C: if (reset) e.btr1 = v; return;
        case 0x34:
            if (reset) {
                e.ewl = v;
                twaiCounters(e);
            }
            return;
        case 0x38:
            if (reset && !e.busOff) {
                e.rec = v;
                twaiCounters(e);
            }
            return;
        case 0x3C: // TXERR: 255 provoca bus off; menos que isso tira do bus off
            if (!reset) return;
            if (v == 255 && !e.busOff) twaiEnterBusOff(e);
            else {
                e.tec = v;
                if (v < 255) e.busOff = false;
            }
            twaiCounters(e);
            return;
        default: break;
    }
    if (offset >= 0x40 && offset <= 0x70 && offset % 4u == 0) {
        const uint32_t i = static_cast<uint32_t>((offset - 0x40) / 4u);
        if (reset) {
            if (i < 4) e.acr[i] = v;
            else if (i < 8) e.amr[i - 4] = v;
        } else if (e.tbs) {
            e.txBuf[i] = v; // travado enquanto uma transmissao esta' pendente
        }
    }
}

TwaiState& twaiOf(LsdnQemuModule* module) {
    TwaiState& s = reinterpret_cast<TwaiModuleState*>(module)->chip->twai;
    s.e.events = &s.events;
    return s;
}

void twaiHwReset(TwaiState& s) {
    TwaiEngine fresh{};
    fresh.rxLevel = s.e.rxLevel; // o pino continua onde esta'
    fresh.rxChangePs = s.e.rxChangePs;
    fresh.rxBefore = s.e.rxBefore;
    s.e = fresh;
    s.events.clear();
    s.plan.clear();
    s.planPos = 0;
    s.replan = false;
    s.e.events = &s.events;
}

void twaiReset(LsdnQemuModule* module) {
    TwaiState& s = twaiOf(module);
    s = TwaiState{};
    s.e.events = &s.events;
    s.e.apbHz = reinterpret_cast<TwaiModuleState*>(module)->chip->apbHz;
}

void twaiWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    TwaiState& s = twaiOf(module);
    const uint64_t offset = address - kTwaiStart;
    if (offset >= 0x80) return;
    const uint64_t at = nowNs * 1000u;
    twaiRun(s, at, false);
    twaiWrite(s.e, offset, static_cast<uint32_t>(value), at);
    s.replan = true;
    twaiAfter(s, at, false);
}

void twaiWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    twaiWriteRegisterAt(module, address, value, 0);
}

uint64_t twaiReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* m = reinterpret_cast<TwaiModuleState*>(module);
    TwaiState& s = twaiOf(module);
    const uint64_t offset = address - kTwaiStart;
    if (offset == kTwaiEventOffset) {
        if (s.events.empty()) return 0;
        const auto event = s.events.front();
        s.events.pop_front();
        m->pendingEventValue = event.second;
        return event.first | (1u << 31);
    }
    if (offset == kTwaiEventOffset + 4) return m->pendingEventValue;
    if (offset == kTwaiStateOffset)
        return twaiStatus(s.e) | (std::min<uint32_t>(s.e.tec, 255u) << 8) | (std::min<uint32_t>(s.e.rec, 255u) << 16);
    if (offset == kTwaiHardDueOffset) {
        for (size_t i = s.planPos; i < s.plan.size(); ++i)
            if (s.plan[i].hard) return (s.plan[i].atPs + 999u) / 1000u;
        return LSDN_QEMU_MODULE_NO_WAKEUP;
    }
    return 0;
}

uint64_t twaiNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    const TwaiState& s = twaiOf(module);
    if (reinterpret_cast<TwaiModuleState*>(module)->chip->digitalClockGated) return LSDN_QEMU_MODULE_NO_WAKEUP;
    if (s.planPos >= s.plan.size()) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return delayUntilNs((s.plan[s.planPos].atPs + 999u) / 1000u, nowNs);
}

void twaiOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    TwaiState& s = twaiOf(module);
    if (reinterpret_cast<TwaiModuleState*>(module)->chip->digitalClockGated) return;
    const uint64_t at = nowNs * 1000u;
    twaiRun(s, at, true);
    twaiAfter(s, at, true);
}

void twaiDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<TwaiModuleState*>(module);
}

const LsdnQemuModuleVTable kTwaiModuleVTable = {
    &twaiReset, &twaiWriteRegister, &twaiReadRegister, nullptr, nullptr, nullptr, &twaiDestroy,
    nullptr, &twaiOnWakeup, &twaiWriteRegisterAt, nullptr, &twaiNextWakeupAt,
};

/* RTC_IO (0x3FF48400): os registradores dos pads de RTC que o QEMU repassa (ver kRtcPads). E' dominio do
 * RTC: um reset do digital nao os toca (socDigitalReset). Os enderecos 0xF0..0xF8, fora do RTC_IO do chip,
 * trazem o DAC no modo do I2S (ver dacUpdate). */
struct RtcIoModuleState {
    Esp32SharedState* chip;
};

/* DAC (ESP32 TRM, DAC): os dois DACs de 8 bits saem no GPIO25 (RTC_IO_PAD_DAC1) e no GPIO26 (PAD_DAC2)
 * com o pad no dominio do RTC (MUX_SEL) e ligado (XPD_DAC): VDD3P3_RTC * codigo / 255 (dac_output_voltage
 * do ESP-IDF), por uma resistencia de saida de ~20 Ohm medida em placa (esp32.com); o limite de corrente
 * (~12,7 mA) nao e' modelado. O codigo e' o PDAC_DAC do pad ou, com SENS DAC_DIG_FORCE (o modo DAC do I2S0,
 * i2s_set_dac_mode), a amostra do I2S: o QEMU (hw/misc/esp32_i2s.c) manda cada uma com o seu instante
 * (0xF0), o modo (0xF4) e o fim do fluxo (0xF8). O gerador de cosseno (SENS_SAR_DAC_CTRL2.DAC_CW_ENx) nao e'
 * modelado. */
constexpr double kDacOhms = 20.0;
constexpr uint64_t kRtcIoDacSample = 0xF0, kRtcIoDacDigital = 0xF4, kRtcIoDacCut = 0xF8;
constexpr uint64_t kRtcIoDacCwConfig = 0xFC;
constexpr uint32_t kDacCwPhaseReset = 1u << 16;
constexpr uint64_t kDacCwClockHz = 8'000'000;

uint16_t dacCwPhaseAt(const Esp32SharedState& chip, uint64_t nowNs) {
    const uint64_t elapsed = nowNs >= chip.dacCwEpochNs ? nowNs - chip.dacCwEpochNs : 0;
    const uint64_t rtcTicks = elapsed / 125u; // RTC_FAST is nominally 8 MHz
    return static_cast<uint16_t>(chip.dacCwPhaseBase + rtcTicks * (chip.dacCwCtrl1 & 0xFFFFu));
}

uint8_t dacCwCode(const Esp32SharedState& chip, uint32_t channel, uint64_t nowNs) {
    const uint32_t shift = channel == 0 ? 16u : 18u;
    const uint32_t invShift = channel == 0 ? 20u : 22u;
    const uint32_t dcShift = channel == 0 ? 0u : 8u;
    const uint32_t scale = (chip.dacCwCtrl2 >> shift) & 3u;
    const uint32_t phaseSel = (chip.dacCwCtrl2 >> invShift) & 3u;
    const uint8_t rawDc = static_cast<uint8_t>(chip.dacCwCtrl2 >> dcShift);
    int dc = rawDc == 0x80u ? 0 : static_cast<int8_t>(rawDc);
    if (phaseSel == 3u) dc = -dc; // IDF adjusts DC for its 180-degree phase selection
    const uint16_t phase = dacCwPhaseAt(chip, nowNs);
    const long double angle = static_cast<long double>(phase) * (2.0L * 3.1415926535897932384626433832795L / 65536.0L);
    const long double amplitude = 127.0L / static_cast<long double>(1u << scale);
    int signedSample = static_cast<int>(std::lround(std::cos(angle) * amplitude));
    signedSample = std::clamp(signedSample, -128, 127);
    uint8_t code = static_cast<uint8_t>(static_cast<int8_t>(signedSample));
    // TRM INV maps the signed generator sample to the pad code; modes 2/3 are the IDF's
    // 0/180-degree selections. Modes 0/1 are the raw register bit inversions.
    if (phaseSel == 2u) code ^= 0x80u;
    else if (phaseSel == 3u) code = static_cast<uint8_t>(128 - signedSample);
    else if (phaseSel == 1u) code ^= 0xFFu;
    return static_cast<uint8_t>(std::clamp(static_cast<int>(code) + dc, 0, 255));
}

bool dacCwRunning(const Esp32SharedState& chip) {
    return (chip.dacCwCtrl1 & kDacCwPhaseReset) && (chip.dacCwCtrl1 & 0xFFFFu) && !chip.dacDigital &&
           (((chip.dacCwCtrl2 >> 24) & 3u) != 0);
}

void dacCwRearm(Esp32SharedState& chip, uint64_t nowNs) {
    if (!dacCwRunning(chip)) { chip.dacCwNextNs = LSDN_QEMU_MODULE_NO_WAKEUP; return; }
    const long double hz = static_cast<long double>(kDacCwClockHz) * (chip.dacCwCtrl1 & 0xFFFFu) / 65536.0L;
    const uint64_t period = std::max<uint64_t>(1, static_cast<uint64_t>(std::floor(1.0e9L / (hz * 32.0L))));
    chip.dacCwNextNs = addDelayNs(nowNs, period);
}

void dacUpdate(Esp32SharedState& chip, uint64_t nowNs = 0) {
    static constexpr struct { uint32_t gpio, offset; } kDacs[2] = {{25, 0x84}, {26, 0x88}};
    for (size_t i = 0; i < 2; ++i) {
        const uint32_t reg = chip.rtcIoRegs[kDacs[i].offset / 4u];
        const bool on = ((reg >> 17) & 1u) && ((reg >> 18) & 1u);
        const bool cw = ((chip.dacCwCtrl2 >> (i == 0 ? 24u : 25u)) & 1u) != 0;
        const uint32_t code = chip.dacDigital ? chip.dacDigitalCode[i]
                             : (cw && (chip.dacCwCtrl1 & kDacCwPhaseReset)) ? dacCwCode(chip, static_cast<uint32_t>(i), nowNs)
                             : (reg >> 19) & 0xFFu;
        chip.analogDrive[kDacs[i].gpio] = AnalogDrive{on, 3.3 * static_cast<double>(code) / 255.0, kDacOhms};
    }
}

// As amostras do I2S que chegaram ao seu instante.
void dacApplySamples(Esp32SharedState& chip, uint64_t nowNs) {
    bool changed = false;
    while (!chip.dacSamples.empty() && chip.dacSamples.front().first <= nowNs) {
        const uint32_t codes = chip.dacSamples.front().second;
        if (codes & (1u << 16)) chip.dacDigitalCode[0] = static_cast<uint8_t>(codes);
        if (codes & (1u << 17)) chip.dacDigitalCode[1] = static_cast<uint8_t>(codes >> 8);
        chip.dacSamples.pop_front();
        changed = true;
    }
    if (changed && chip.dacDigital) dacUpdate(chip, nowNs);
}

void rtcIoReset(LsdnQemuModule* module) {
    Esp32SharedState& chip = *reinterpret_cast<RtcIoModuleState*>(module)->chip;
    chip.dacDigital = false;
    chip.dacSamples.clear();
    chip.dacDigitalCode = {};
    chip.dacCwCtrl1 = 0;
    chip.dacCwCtrl2 = 0x03000000;
    chip.dacCwEpochNs = 0;
    chip.dacCwPhaseBase = 0;
    chip.dacCwNextNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    // Os valores de reset do rtc_io_reg.h, os mesmos do QEMU (hw/misc/esp32_rtcio.c): ele so' manda o que muda.
    chip.rtcIoRegs.fill(0);
    chip.rtcIoRegs[0x84 / 4] = 0x80000000u; // PAD_DAC1
    chip.rtcIoRegs[0x88 / 4] = 0x80000000u; // PAD_DAC2
    chip.rtcIoRegs[0x8C / 4] = 0x84100010u; // XTAL_32K_PAD
    chip.rtcIoRegs[0x90 / 4] = 0x66000000u; // TOUCH_CFG
    static constexpr uint32_t kTouchPadReset[10] = {0x52000000u, 0x4a000000u, 0x52000000u, 0x4a000000u, 0x52000000u,
                                                    0x52000000u, 0x4a000000u, 0x42000000u, 0x02000000u, 0x02000000u};
    for (size_t i = 0; i < 10; ++i) chip.rtcIoRegs[(0x94 + 4 * i) / 4] = kTouchPadReset[i];
    dacUpdate(chip);
}

void rtcIoWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    Esp32SharedState& chip = *reinterpret_cast<RtcIoModuleState*>(module)->chip;
    const uint64_t offset = address - kRtcIoStart;
    if (offset == kRtcIoDacSample) { // a amostra para daqui a value >> 18 ns
        const uint64_t at = addDelayNs(nowNs, value >> 18);
        if (!chip.dacSamples.empty() && at < chip.dacSamples.back().first) chip.dacSamples.clear(); // o fluxo recomecou
        chip.dacSamples.emplace_back(at, static_cast<uint32_t>(value & 0x3FFFFu));
        dacApplySamples(chip, nowNs);
        return;
    }
    if (offset == kRtcIoDacCut) { // o que viria a partir de value ns nao sai mais
        const uint64_t at = addDelayNs(nowNs, value);
        while (!chip.dacSamples.empty() && chip.dacSamples.back().first >= at) chip.dacSamples.pop_back();
        return;
    }
    if (offset == kRtcIoDacDigital) {
        dacApplySamples(chip, nowNs);
        chip.dacDigital = (value & 1u) != 0;
        if (!chip.dacDigital) chip.dacSamples.clear();
        dacUpdate(chip, nowNs);
        dacCwRearm(chip, nowNs);
        return;
    }
    if (offset == kRtcIoDacCwConfig) {
        const bool control2 = (value & (1u << 31)) != 0;
        const uint32_t next = static_cast<uint32_t>(value) & 0x7FFFFFFFu;
        const bool wasRunning = dacCwRunning(chip);
        if (control2) {
            chip.dacCwCtrl2 = next;
        } else {
            const uint32_t oldTone = chip.dacCwCtrl1 & kDacCwPhaseReset;
            const uint32_t oldStep = chip.dacCwCtrl1 & 0xFFFFu;
            if (oldTone && oldStep && (next & kDacCwPhaseReset) && (next & 0xFFFFu) != oldStep) {
                chip.dacCwPhaseBase = dacCwPhaseAt(chip, nowNs);
                chip.dacCwEpochNs = nowNs;
            } else if (!oldTone && (next & kDacCwPhaseReset)) {
                chip.dacCwPhaseBase = 0;
                chip.dacCwEpochNs = nowNs;
            }
            chip.dacCwCtrl1 = next & 0x1FFFFu;
        }
        const bool running = dacCwRunning(chip);
        if (!wasRunning && running) { chip.dacCwPhaseBase = 0; chip.dacCwEpochNs = nowNs; }
        dacUpdate(chip, nowNs);
        dacCwRearm(chip, nowNs);
        return;
    }
    if (offset / 4u < chip.rtcIoRegs.size()) chip.rtcIoRegs[offset / 4u] = static_cast<uint32_t>(value);
    chip.gpioInputRouted.fill(false); // um pad que mudou de dominio volta a ter o nivel do pad nas entradas
    dacUpdate(chip, nowNs);
}

void rtcIoWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    rtcIoWriteRegisterAt(module, address, value, 0);
}

uint64_t rtcIoReadRegister(LsdnQemuModule* module, uint64_t address) {
    const Esp32SharedState& chip = *reinterpret_cast<RtcIoModuleState*>(module)->chip;
    const uint64_t offset = address - kRtcIoStart;
    return offset / 4u < chip.rtcIoRegs.size() ? chip.rtcIoRegs[offset / 4u] : 0;
}

void rtcIoDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<RtcIoModuleState*>(module);
}

uint64_t rtcIoNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    const Esp32SharedState& chip = *reinterpret_cast<RtcIoModuleState*>(module)->chip;
    const uint64_t sample = chip.dacSamples.empty() ? LSDN_QEMU_MODULE_NO_WAKEUP : chip.dacSamples.front().first;
    return delayUntilNs(std::min(sample, chip.dacCwNextNs), nowNs);
}

void rtcIoOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    Esp32SharedState& chip = *reinterpret_cast<RtcIoModuleState*>(module)->chip;
    dacApplySamples(chip, nowNs);
    if (chip.dacCwNextNs != LSDN_QEMU_MODULE_NO_WAKEUP && chip.dacCwNextNs <= nowNs) {
        dacUpdate(chip, nowNs);
        dacCwRearm(chip, nowNs);
    }
}

const LsdnQemuModuleVTable kRtcIoModuleVTable = {
    &rtcIoReset, &rtcIoWriteRegister, &rtcIoReadRegister, nullptr, nullptr, nullptr, &rtcIoDestroy,
    nullptr, &rtcIoOnWakeup, &rtcIoWriteRegisterAt, nullptr, &rtcIoNextWakeupAt,
};

/* DPORT_PERIP_RST_EN: um periferico fica em reset enquanto o seu bit esta' em 1. O ESP-IDF pulsa o bit em
 * periph_module_reset() (RMT, UART1/2, TWAI ao instalar), o esp_restart() pulsa TIMERS/SPI01/UARTs e o boot
 * segura os nao usados ate' o periph_module_enable(). O QEMU (hw/misc/esp32_dport.c) repassa cada escrita
 * que muda o registrador e reinicia os seus dispositivos nas duas bordas; aqui, do mesmo jeito, os motores
 * que o Core modela nos pinos. Depois de liberado, o periferico esta' no estado de reset. */
constexpr uint64_t kDportPeripRstEn = 0x3FF000C4;

struct DportModuleState {
    Esp32SharedState* chip;
};

// Os perifericos que contam em APB_CLK guardam o valor de agora; um reset deles nao muda o clock.
void apbApplyFields(Esp32SharedState& chip) {
    chip.ledc.apbHz = chip.apbHz;
    chip.rmt.apbHz = chip.apbHz;
    chip.pcnt.apbHz = chip.apbHz;
    for (McpwmUnit& u : chip.mcpwm) u.apbHz = chip.apbHz;
    chip.twai.e.apbHz = chip.apbHz;
    for (I2cState& i2c : chip.i2cs) i2c.apbHz = chip.apbHz;
}

void dportPeripheralReset(Esp32SharedState& chip, uint32_t bit) {
    switch (bit) {
        case 2: usartPeripheralReset(chip.usarts[0]); break;
        case 5: usartPeripheralReset(chip.usarts[1]); break;
        case 23: usartPeripheralReset(chip.usarts[2]); break;
        case 7: chip.i2cs[0] = {}; break;
        case 18: chip.i2cs[1] = {}; break;
        case 6: chip.spis[0] = {}; break;  // SPI2 (HSPI)
        case 16: chip.spis[1] = {}; break; // SPI3 (VSPI)
        case 9: chip.rmt = RmtState{}; break;
        case 10: chip.pcnt = PcntState{}; break;
        case 11: chip.ledc = LedcState{}; break;
        case 17: chip.mcpwm[0] = McpwmUnit{}; break;
        case 20: chip.mcpwm[1] = McpwmUnit{}; break;
        case 19: twaiHwReset(chip.twai); break;
        default: return;
    }
    apbApplyFields(chip);
    chip.gpioInputRouted.fill(false); // as entradas do periferico voltam a ter o nivel dos pads (usartReset())
}

void dportReset(LsdnQemuModule* module) {
    reinterpret_cast<DportModuleState*>(module)->chip->dportPeripRstEn = 0;
}

void dportWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t) {
    Esp32SharedState& chip = *reinterpret_cast<DportModuleState*>(module)->chip;
    if (address != kDportPeripRstEn) return;
    const uint32_t changed = static_cast<uint32_t>(value) ^ chip.dportPeripRstEn;
    chip.dportPeripRstEn = static_cast<uint32_t>(value);
    for (uint32_t bit = 0; bit < 32; ++bit)
        if (changed & (1u << bit)) dportPeripheralReset(chip, bit);
}

void dportWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    dportWriteRegisterAt(module, address, value, 0);
}

uint64_t dportReadRegister(LsdnQemuModule* module, uint64_t address) {
    return address == kDportPeripRstEn ? reinterpret_cast<DportModuleState*>(module)->chip->dportPeripRstEn : 0;
}

void dportDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<DportModuleState*>(module);
}

const LsdnQemuModuleVTable kDportModuleVTable = {
    &dportReset, &dportWriteRegister, &dportReadRegister, nullptr, nullptr, nullptr, &dportDestroy,
    nullptr, nullptr, &dportWriteRegisterAt,
};

/* Reset do digital (a escrita do QEMU em 0x3FF48FFC: esp_restart() nao, mas um reset de sistema por
 * software, um watchdog, a volta do deep sleep): os motores digitais voltam ao reset -- GPIO, IO_MUX, matriz,
 * UART, I2C, SPI, LEDC, RMT, PCNT, MCPWM, TWAI, DPORT_PERIP_RST_EN --, como faz o reset de cada modulo. O
 * dominio do RTC fica como esta' (o MUX dos pads de RTC, a medicao de toque, o SENS), e as tensoes dos pads
 * sao do circuito. Antes o Core reiniciava todo modulo e o RTC_IO perdia os pads. */
constexpr uint64_t kSocDigitalReset = 0x3FF48FFC;
constexpr uint64_t kSocApbHz = 0x3FF48FF8; // APB_CLK em Hz, a cada troca do clock (QEMU esp32_clk_update)
constexpr uint64_t kSocSleepClock = 0x3FF48FF4; // bit 0 gate digital, bit 1 RTC8M retained

struct SocModuleState {
    Esp32SharedState* chip;
};

void socDigitalReset(Esp32SharedState& chip) {
    chip.gpioOut = 0;
    chip.gpioEnable = 0;
    chip.gpioOut1 = 0;
    chip.gpioEnable1 = 0;
    chip.gpioInputs.fill(false);
    chip.gpioInputRouted.fill(false);
    chip.gpioPinRegs.fill(0);
    chip.matrixInRegs.fill(0);
    chip.matrixOutRegs.fill(0);
    chip.ioMuxRegs.fill(0);
    for (UsartState& usart : chip.usarts) usartPeripheralReset(usart);
    chip.i2cs = {};
    chip.spis = {};
    chip.ledc = LedcState{};
    chip.rmt = RmtState{};
    chip.pcnt = PcntState{};
    chip.mcpwm = {};
    chip.twai = TwaiState{};
    chip.twai.e.events = &chip.twai.events;
    chip.dportPeripRstEn = 0;
    chip.dacSamples.clear(); // o I2S e' digital: o que estava na FIFO dele nao sai; o DAC fica no ultimo codigo
    chip.i2sAdc = I2sAdcSampler{};
    apbApplyFields(chip); // o clock nao e' do digital: segue o que o QEMU informou
}

void socReset(LsdnQemuModule* module) {
    Esp32SharedState& chip = *reinterpret_cast<SocModuleState*>(module)->chip;
    chip.apbHz = 40'000'000; // o SoC sai do reset no XTAL
    apbApplyFields(chip);
}

/* APB_CLK mudou (o QEMU, esp32_clk_update): o que conta nele segue no ritmo novo de onde estava. */
void apbChanged(Esp32SharedState& chip, uint64_t hz, uint64_t nowNs) {
    if (hz == 0 || hz == chip.apbHz) return;
    chip.apbHz = hz;
    LedcState& ledc = chip.ledc;
    ledc.apbHz = hz;
    for (uint32_t timer = 0; timer < ledc.timers.size(); ++timer) {
        LedcTimer& t = ledc.timers[timer];
        const long double tick = ledcTickNs(ledc, timer, t.config);
        if (tick <= 0 || tick == t.tickNs) continue;
        if (t.tickNs > 0 && nowNs > t.epochNs && !t.paused) {
            const long double ticks = static_cast<long double>(nowNs - t.epochNs) / t.tickNs; // a contagem fica
            const long double back = ticks * tick;
            t.epochNs = back < static_cast<long double>(nowNs) ? nowNs - static_cast<uint64_t>(back) : 0;
        }
        t.tickNs = tick;
        ledcEvaluateTimerChannels(ledc, timer, nowNs);
    }
    chip.pcnt.apbHz = hz;
    chip.rmt.apbHz = hz;
    for (McpwmUnit& u : chip.mcpwm) {
        u.capEpochValue = mcpwmCapValue(u, nowNs); // o contador de captura continua de onde estava
        u.capEpochNs = nowNs;
        u.apbHz = hz;
    }
    chip.twai.e.apbHz = hz;
    twaiTiming(chip.twai.e);
    for (I2cState& i2c : chip.i2cs) {
        i2c.apbHz = hz;
        if (i2c.sclCycles) i2c.halfPeriodNs = std::max<uint64_t>(1, (i2c.sclCycles * 1'000'000'000ull / hz) / 2u);
    }
    for (UsartState& usart : chip.usarts) {
        if (!usart.useApb || !usart.clkdivRaw) continue;
        const uint32_t baud = static_cast<uint32_t>((static_cast<uint32_t>(hz) << 4) / usart.clkdivRaw);
        if (baud) usart.bitPeriodNs = static_cast<uint32_t>(1e9 / baud);
    }
}

void socWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    Esp32SharedState& chip = *reinterpret_cast<SocModuleState*>(module)->chip;
    if (address == kSocDigitalReset) socDigitalReset(chip);
    if (address == kSocApbHz) apbChanged(chip, value, nowNs);
    if (address == kSocSleepClock) {
        const bool gate = (value & 1u) != 0;
        if (gate == chip.digitalClockGated) return;
        if (gate) {
            chip.sleepStartedNs = nowNs;
            chip.rtc8mKeptInSleep = (value & 2u) != 0;
            chip.digitalClockGated = true;
            // LEDC low-speed timers sourced from RTC8M continue only while IDF kept that oscillator on.
            for (uint32_t timer = 0; timer < chip.ledc.timers.size(); ++timer) {
                LedcTimer& t = chip.ledc.timers[timer];
                const bool rtc8m = timer >= 4 && (chip.ledc.confReg & 1u) == 0;
                if (!rtc8m || !chip.rtc8mKeptInSleep) {
                    t.paused = true;
                    t.pausedAtNs = nowNs;
                    ledcEvaluateTimerChannels(chip.ledc, timer, nowNs);
                }
            }
            return;
        }
        const uint64_t elapsed = nowNs >= chip.sleepStartedNs ? nowNs - chip.sleepStartedNs : 0;
        chip.digitalClockGated = false;
        for (uint32_t timer = 0; timer < chip.ledc.timers.size(); ++timer) {
            LedcTimer& t = chip.ledc.timers[timer];
            if (!t.paused) continue;
            t.epochNs += elapsed;
            t.paused = false;
            t.pausedAtNs = 0;
            ledcEvaluateTimerChannels(chip.ledc, timer, nowNs);
        }
        for (UsartState& u : chip.usarts) { if (u.txDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) u.txDueNs += elapsed; if (u.rxDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) u.rxDueNs += elapsed; }
        for (I2cState& i : chip.i2cs) { if (i.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP) i.dueNs += elapsed; if (i.sSdaDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) i.sSdaDueNs += elapsed; }
        for (SpiState& i : chip.spis) if (i.dueNs != LSDN_QEMU_MODULE_NO_WAKEUP) i.dueNs += elapsed;
        for (RmtChannel& c : chip.rmt.channels) { if (c.secondDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) c.secondDueNs += elapsed; if (c.carrierNextNs != LSDN_QEMU_MODULE_NO_WAKEUP) c.carrierNextNs += elapsed; c.segmentStartNs += elapsed; }
        for (RmtRx& r : chip.rmt.rx) { if (r.pendingEdgeNs) r.pendingEdgeNs += elapsed; if (r.confirmDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) r.confirmDueNs += elapsed; if (r.idleDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) r.idleDueNs += elapsed; r.levelStartNs += elapsed; }
        for (PcntUnit& u : chip.pcnt.units) for (PcntInput& i : u.inputs) if (i.commitDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) i.commitDueNs += elapsed;
        for (McpwmUnit& u : chip.mcpwm) {
            for (McpwmTimer& t : u.timers) { t.epochNs += elapsed; if (t.nextNs != LSDN_QEMU_MODULE_NO_WAKEUP) t.nextNs += elapsed; }
            u.capEpochNs += elapsed;
            for (McpwmOperator& o : u.ops) { if (o.redDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) o.redDueNs += elapsed; if (o.fedDueNs != LSDN_QEMU_MODULE_NO_WAKEUP) o.fedDueNs += elapsed; }
        }
        chip.twai.e.bitStartPs += elapsed * 1000u; chip.twai.e.sampleAtPs += elapsed * 1000u; chip.twai.e.bitEndPs += elapsed * 1000u;
        for (uint64_t& at : chip.twai.e.rxChangePs) at += elapsed * 1000u;
        for (TwaiPlanPoint& p : chip.twai.plan) p.atPs += elapsed * 1000u;
        chip.twai.replan = true;
    }
}

void socWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    socWriteRegisterAt(module, address, value, 0);
}

uint64_t socReadRegister(LsdnQemuModule*, uint64_t) {
    return 0;
}

void socDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<SocModuleState*>(module);
}

const LsdnQemuModuleVTable kSocModuleVTable = {
    &socReset, &socWriteRegister, &socReadRegister, nullptr, nullptr, nullptr, &socDestroy,
    nullptr, nullptr, &socWriteRegisterAt,
};

const LsdnMemoryRegion kMemoryRegions[] = {
    {kUart0Start, kUart0End, LSDN_MODULE_USART, 0},
    {kGpioStart, kGpioEnd, LSDN_MODULE_GPIO, 0},
    {kAdcStart, kAdcEnd, LSDN_MODULE_ADC, 0},
    {kIoMuxStart, kIoMuxEnd, LSDN_MODULE_IOMUX, 0},
    {kUart1Start, kUart1End, LSDN_MODULE_USART, 1},
    {kLedcStart, kLedcEnd, LSDN_MODULE_PWM, 0},
    {kRmtStart, kRmtEnd, LSDN_MODULE_PWM, 1},
    {kPcntStart, kPcntEnd, LSDN_MODULE_TIMER, 0},
    {kMcpwm0Start, kMcpwm0Start + 0x2FF, LSDN_MODULE_PWM, 2}, // registradores ate' 0x127, privados 0x200..0x2FF
    {kMcpwm1Start, kMcpwm1Start + 0x2FF, LSDN_MODULE_PWM, 3},
    {kTwaiStart, kTwaiEnd, LSDN_MODULE_TIMER, 1}, // registradores ate' 0x7F, privados 0x200..0x2FF
    {kI2c0Start, kI2c0End, LSDN_MODULE_I2C, 0},
    {kSpi0Start, kSpi0End, LSDN_MODULE_SPI, 0},
    {kSpi1Start, kSpi1End, LSDN_MODULE_SPI, 1},
    {kI2c1Start, kI2c1End, LSDN_MODULE_I2C, 1},
    {kUart2Start, kUart2End, LSDN_MODULE_USART, 2},
    {kDportPeripRstEn, kDportPeripRstEn + 3, LSDN_MODULE_TIMER, 2}, // DPORT_PERIP_RST_EN (sem pinos)
    {kRtcIoStart, kRtcIoEnd, LSDN_MODULE_TIMER, 3},                  // RTC_IO: o MUX dos pads de RTC
    {kSocSleepClock, kSocDigitalReset + 3, LSDN_MODULE_TIMER, 4},  // sleep, APB_CLK e reset do digital (QEMU)
};

/** Caminho ABSOLUTO do próprio módulo (.dll/.so) carregado, ou vazio se a resolução falhar. Usa a
 * API nativa de cada SO (nunca `argv[0]`/CWD do processo host, que aqui é o Core, um executável
 * DIFERENTE deste plugin). */
std::string resolveOwnModuleDirectory() {
#if defined(_WIN32)
    HMODULE module = nullptr;
    if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCSTR>(&resolveOwnModuleDirectory), &module)) {
        return {};
    }
    char buffer[MAX_PATH] = {};
    const DWORD length = GetModuleFileNameA(module, buffer, MAX_PATH);
    if (length == 0 || length == MAX_PATH) return {};
    return std::filesystem::path(buffer).parent_path().string();
#else
    Dl_info info{};
    if (!dladdr(reinterpret_cast<void*>(&resolveOwnModuleDirectory), &info) || !info.dli_fname) return {};
    return std::filesystem::path(info.dli_fname).parent_path().string();
#endif
}

/** ROM do QEMU (`-L`, ver `buildLaunchArgs` abaixo) mora em `devices/qemu-esp32/bin/esp32/rom/bin`,
 * SEMPRE irmão de `mcu-adapters/` -- tanto no repo de desenvolvimento quanto dentro de `bundled/` no
 * pacote instalado (`scripts/package-release.js::stageBundledAssets` copia os dois como irmãos sob a
 * mesma raiz). Esse adaptador (.dll/.so) é sempre buildado/copiado em
 * `mcu-adapters/espressif-esp32/build/<plataforma>/adapter.{dll,so}`
 * (`scripts/build-mcu-adapters.js`) -- 4 níveis acima da raiz comum, de onde desce de volta pra
 * `devices/qemu-esp32/bin/esp32/rom/bin`.
 *
 * Bug real corrigido aqui: o valor antigo era um caminho relativo FIXO
 * (`"devices/qemu-esp32/bin/esp32/rom/bin"`), relativo ao diretório de trabalho do processo do
 * CORE (não deste plugin) -- que é `dirname` do executável do Core
 * (`CoreProcess.ts::spawnOpts.cwd`), nunca a pasta de instalação real. Calculado a partir do
 * caminho REAL do próprio módulo carregado em vez disso. Cai pro caminho relativo antigo só se a
 * resolução do próprio módulo falhar (nunca pior que o comportamento de antes). */
std::string resolveDefaultRomDir() {
    const std::string ownDir = resolveOwnModuleDirectory();
    if (ownDir.empty()) return "devices/qemu-esp32/bin/esp32/rom/bin";
    const std::filesystem::path romPath = std::filesystem::path(ownDir) / ".." / ".." / ".." / ".."
        / "devices" / "qemu-esp32" / "bin" / "esp32" / "rom" / "bin";
    return romPath.lexically_normal().string();
}

struct Esp32AdapterState {
    void* hostCtx = nullptr;
    const LsdnMcuHostApi* api = nullptr;
    Esp32SharedState chip;
    std::vector<std::string> pinIdStorage;
    std::vector<LsdnPinMapping> pinMapStorage;
    std::vector<std::string> launchArgStorage;
    std::vector<const char*> launchArgs;
    std::string romDir = resolveDefaultRomDir();
};

void buildPinMap(Esp32AdapterState* state) {
    state->pinIdStorage.clear();
    state->pinMapStorage.clear();
    state->pinIdStorage.reserve(kPinMapCount);
    state->pinMapStorage.reserve(kPinMapCount);

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinIdStorage.push_back("GPIO" + std::to_string(gpio));
    }
    state->pinIdStorage.push_back("UART0_RX");
    state->pinIdStorage.push_back("UART0_TX");
    state->pinIdStorage.push_back("RST"); // EN do ESP32 real -- reset de hardware, não GPIO comum

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinMapStorage.push_back(
            LsdnPinMapping{state->pinIdStorage[gpio].c_str(), LSDN_MODULE_GPIO, 0, gpio});
    }
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[40].c_str(), LSDN_MODULE_USART, 0, kUartRxLine});
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[41].c_str(), LSDN_MODULE_USART, 0, kUartTxLine});
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[42].c_str(), LSDN_MODULE_RESET, 0, 0});
}

LsdnMcuAdapter* create(void* hostCtx, const LsdnMcuHostApi* api) {
    auto* state = new Esp32AdapterState();
    state->hostCtx = hostCtx;
    state->api = api;
    configureIoMux(state->chip);
    buildPinMap(state);
    return reinterpret_cast<LsdnMcuAdapter*>(state);
}

LsdnQemuLaunchSpec buildLaunchArgs(LsdnMcuAdapter* adapter, const char* firmwarePath) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    state->launchArgStorage = {
        "qemu-system-xtensa",
        "-M",
        "esp32-simul",
        "-display",
        "none",
        "-L",
        state->romDir,
        // snapshot=on: the guest can now genuinely write flash (NVS, Wi-Fi PHY
        // calibration, esp_wifi_init), so run the firmware image copy-on-write in
        // a discarded temporary overlay. Writes succeed and are visible to the
        // guest for the session, but the user's firmware .bin is never modified.
        "-drive",
        "file=" + std::string(firmwarePath ? firmwarePath : "") +
            ",if=mtd,format=raw,snapshot=on",
    };
    // Relógio contado por instrução, base do lockstep com o Core: o tempo do guest só anda com as
    // instruções que ele executa, nunca com o relógio do PC. O modo MTTCG (uma thread TCG por vCPU,
    // relógio do guest preso ao do host) foi retirado em 2026-10-30: nele o SPI de hardware, a UART
    // no pino e a duração de um fade saíam errados por natureza (docs/35-bug-bordas-*.md).
    state->launchArgStorage.push_back("-accel");
    state->launchArgStorage.push_back("tcg,thread=single");
    state->launchArgStorage.push_back("-icount");
    state->launchArgStorage.push_back(
        "shift=" + std::to_string(configuredIcountShift()) + ",align=off,sleep=off");
    state->launchArgs.clear();
    state->launchArgs.reserve(state->launchArgStorage.size());
    for (const std::string& arg : state->launchArgStorage) state->launchArgs.push_back(arg.c_str());

    return LsdnQemuLaunchSpec{"qemu-system-xtensa", state->launchArgs.data(),
                              static_cast<uint32_t>(state->launchArgs.size())};
}

uint32_t getMemoryRegions(LsdnMcuAdapter*, LsdnMemoryRegion* out, uint32_t cap) {
    const uint32_t count = sizeof(kMemoryRegions) / sizeof(kMemoryRegions[0]);
    if (out && cap >= count) std::memcpy(out, kMemoryRegions, sizeof(kMemoryRegions));
    return count;
}

uint32_t getPinMap(LsdnMcuAdapter* adapter, LsdnPinMapping* out, uint32_t cap) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    const uint32_t count = static_cast<uint32_t>(state->pinMapStorage.size());
    if (out && cap >= count) {
        for (uint32_t i = 0; i < count; ++i) out[i] = state->pinMapStorage[i];
    }
    return count;
}

uint32_t createModules(LsdnMcuAdapter* adapter, LsdnQemuModuleHandle* out, uint32_t cap) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    constexpr uint32_t kCount = 19;
    if (!out || cap < kCount) return kCount;

    out[0] = LsdnQemuModuleHandle{
        LSDN_MODULE_GPIO, 0, reinterpret_cast<LsdnQemuModule*>(new GpioModuleState{&state->chip}), &kGpioModuleVTable,
    };
    out[1] = LsdnQemuModuleHandle{
        LSDN_MODULE_IOMUX, 0, reinterpret_cast<LsdnQemuModule*>(new IoMuxModuleState{&state->chip}), &kIoMuxModuleVTable,
    };
    out[2] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 0, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 0}), &kUsartModuleVTable,
    };
    out[3] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 1, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 1}), &kUsartModuleVTable,
    };
    out[4] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 2, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 2}), &kUsartModuleVTable,
    };
    out[5] = LsdnQemuModuleHandle{
        LSDN_MODULE_I2C, 0, reinterpret_cast<LsdnQemuModule*>(new I2cModuleState{&state->chip, 0}), &kI2cModuleVTable,
    };
    out[6] = LsdnQemuModuleHandle{
        LSDN_MODULE_I2C, 1, reinterpret_cast<LsdnQemuModule*>(new I2cModuleState{&state->chip, 1}), &kI2cModuleVTable,
    };
    out[7] = LsdnQemuModuleHandle{
        LSDN_MODULE_SPI, 0, reinterpret_cast<LsdnQemuModule*>(new SpiModuleState{&state->chip, 0}), &kSpiModuleVTable,
    };
    out[8] = LsdnQemuModuleHandle{
        LSDN_MODULE_SPI, 1, reinterpret_cast<LsdnQemuModule*>(new SpiModuleState{&state->chip, 1}), &kSpiModuleVTable,
    };
    out[9] = LsdnQemuModuleHandle{
        LSDN_MODULE_ADC, 0, reinterpret_cast<LsdnQemuModule*>(new AdcModuleState{&state->chip}), &kAdcModuleVTable,
    };
    out[10] = LsdnQemuModuleHandle{
        LSDN_MODULE_PWM, 0, reinterpret_cast<LsdnQemuModule*>(new LedcModuleState{&state->chip}), &kLedcModuleVTable,
    };
    out[11] = LsdnQemuModuleHandle{
        LSDN_MODULE_PWM, 1, reinterpret_cast<LsdnQemuModule*>(new RmtModuleState{&state->chip}), &kRmtModuleVTable,
    };
    out[12] = LsdnQemuModuleHandle{
        LSDN_MODULE_TIMER, 0, reinterpret_cast<LsdnQemuModule*>(new PcntModuleState{&state->chip}), &kPcntModuleVTable,
    };
    for (uint32_t unit = 0; unit < 2; ++unit) {
        out[13 + unit] = LsdnQemuModuleHandle{
            LSDN_MODULE_PWM, 2 + unit, reinterpret_cast<LsdnQemuModule*>(new McpwmModuleState{&state->chip, unit}),
            &kMcpwmModuleVTable,
        };
    }
    out[15] = LsdnQemuModuleHandle{
        LSDN_MODULE_TIMER, 1, reinterpret_cast<LsdnQemuModule*>(new TwaiModuleState{&state->chip}), &kTwaiModuleVTable,
    };
    out[16] = LsdnQemuModuleHandle{
        LSDN_MODULE_TIMER, 2, reinterpret_cast<LsdnQemuModule*>(new DportModuleState{&state->chip}), &kDportModuleVTable,
    };
    out[17] = LsdnQemuModuleHandle{
        LSDN_MODULE_TIMER, 3, reinterpret_cast<LsdnQemuModule*>(new RtcIoModuleState{&state->chip}), &kRtcIoModuleVTable,
    };
    out[18] = LsdnQemuModuleHandle{
        LSDN_MODULE_TIMER, 4, reinterpret_cast<LsdnQemuModule*>(new SocModuleState{&state->chip}), &kSocModuleVTable,
    };
    return kCount;
}

void destroy(LsdnMcuAdapter* adapter) {
    delete reinterpret_cast<Esp32AdapterState*>(adapter);
}

// Fast path de transferencia I2C (ver mcu_abi.h ABI 3, docs/39-i2c-mttcg-throughput-ceiling-*.md
// secao 9): dado o barramento I2C (0 ou 1) e SDA/SCL, devolve qual pino fisico (0-39) a GPIO
// matrix tem roteado pra' aquele sinal AGORA. Varredura linear de 40 pinos -- barata (chamada por
// burst, nao por bit; nada perto do custo de milhares de callbacks por byte que o fast path existe
// pra evitar), reaproveita a MESMA resolucao (`selectedPinOutputSignal`) que gpioIsOutputEnabled()/
// gpioOutputLevel() ja usam pra decidir quem dirige eletricamente cada GPIO -- sem logica nova de
// roteamento, so' o sentido inverso da mesma tabela.
int32_t resolveI2cPin(LsdnMcuAdapter* adapter, uint32_t bus, uint8_t sda, uint32_t* out_pin) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    if (!out_pin) return 0;
    const SignalKind wanted = sda ? SignalKind::I2cSda : SignalKind::I2cScl;
    for (uint32_t pin = 0; pin < 40; ++pin) {
        const SignalDesc signal = selectedPinOutputSignal(state->chip, pin);
        if (signal.kind == wanted && signal.index == bus) {
            *out_pin = pin;
            return 1;
        }
    }
    return 0;
}

void setPinTransitionsObserved(LsdnMcuAdapter* adapter, uint32_t pin, int32_t observed) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    if (pin < state->chip.pinTransitionsObserved.size()) state->chip.pinTransitionsObserved[pin] = observed != 0;
}

void setSpiBytePairs(LsdnMcuAdapter* adapter, const uint32_t* clockPins, const uint32_t* dataPins, uint32_t count) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    state->chip.spiBytePairs.clear();
    for (uint32_t i = 0; clockPins && dataPins && i < count; ++i)
        state->chip.spiBytePairs.push_back(SpiBytePairPins{clockPins[i], dataPins[i], UINT32_MAX});
}

void setSpiBytePairsMiso(LsdnMcuAdapter* adapter, const uint32_t* clockPins, const uint32_t* dataPins,
                         const uint32_t* misoPins, uint32_t count) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    state->chip.spiBytePairs.clear();
    for (uint32_t i = 0; clockPins && dataPins && misoPins && i < count; ++i)
        state->chip.spiBytePairs.push_back(SpiBytePairPins{clockPins[i], dataPins[i], misoPins[i]});
}

const LsdnMcuVTable kVTable = {
    &create, &buildLaunchArgs, &getMemoryRegions, &getPinMap, &createModules, &destroy, &resolveI2cPin,
    &setPinTransitionsObserved, &setSpiBytePairs, &setSpiBytePairsMiso,
};

} // namespace

extern "C" LSDN_EXPORT const LsdnMcuVTable* lsdn_get_mcu_vtable(uint32_t* abiMajor, uint32_t* abiMinor) {
    *abiMajor = LSDN_MCU_ABI_VERSION_MAJOR;
    *abiMinor = LSDN_MCU_ABI_VERSION_MINOR;
    return &kVTable;
}
