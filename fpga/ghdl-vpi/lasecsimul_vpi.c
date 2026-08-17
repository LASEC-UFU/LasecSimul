/*
 * lasecsimul_vpi -- ponte VPI entre um processo GHDL (`ghdl -r ... --vpi=lasecsimul_vpi.dll/.so`)
 * e o Core do LasecSimul, via a arena de memória compartilhada `fpga_arena_abi.h`. Ver Step 4 do
 * plano FPGA (`.claude/plans/golden-puzzling-quasar.md`) -- este arquivo é a implementação real,
 * construída em cima do que o Spike 0 provou empiricamente contra um GHDL real (6.0.0, backend
 * mcode, build winget ucrt64):
 *
 *   - descoberta de portas: `vpi_iterate(vpiPort, topModule)` funciona, ordem de retorno é
 *     determinística (bate com a ordem de declaração da entity nos testes).
 *   - escrita de entrada / leitura de saída: `vpi_put_value`/`vpi_get_value` com formato
 *     `vpiBinStrVal` funcionam para 0/1. Achado importante: DEPOSITAR estados não-0/1 (U/X/Z/W/L/
 *     H/-) via VPI NÃO teve efeito neste build do GHDL (silenciosamente ignorado em BinStrVal;
 *     `vpi_put_value: vpiNet, vpiScalarVal` reportado como não-implementado em stderr pra
 *     ScalarVal) -- mas LER esses estados funciona perfeitamente (um port não-conectado relatou
 *     'U' corretamente). Por isso: entradas deste módulo pro GHDL só carregam 0/1 de fato (o que
 *     já é tudo que o modelo elétrico do LasecSimul consegue produzir de qualquer forma -- ver
 *     LogicValue.hpp), mas saídas do GHDL pro Core preservam os 9 estados reais.
 *   - controle de tempo: `cbAfterDelay` se rearmando FUNCIONA como mecanismo de lockstep -- GHDL
 *     não faz mais nada enquanto o callback não retorna (execução single-thread por construção),
 *     então basta registrar um callback pro instante exato que o Core pediu (`ADVANCE_TO`) e
 *     devolver o controle pro kernel do GHDL até lá.
 *
 * Modo de operação, escolhido via variável de ambiente `LASECSIMUL_FPGA_MODE` (setada pelo
 * GhdlProcessManager antes de spawnar o processo -- GHDL não repassa argv extra pro módulo VPI):
 *
 *   "discover": só descobre as portas da entity e imprime em stdout (capturado pelo pipe de log
 *   do GhdlProcessManager, sem precisar de arena nenhuma -- resolve o problema de "preciso saber
 *   quantos bits de entrada/saída existem ANTES de poder dimensionar a arena"), depois
 *   `vpi_control(vpiFinish)`. Dobra como o mecanismo de "LasecSimul: Analyze VHDL" -- reusa 100%
 *   da infraestrutura de processo/VPI, sem parser VHDL própria via regex.
 *
 *   "run": anexa na arena já criada pelo Core (nome em `LASECSIMUL_FPGA_ARENA_NAME`) e entra no
 *   loop de comando/resposta real.
 */
#include "vpi_user.h"
#include "lasecsimul/fpga_arena_abi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define LSDN_VPI_MAX_PORTS 256
#define LSDN_VPI_MAX_WIDTH 256

typedef struct PortInfo {
    char name[128];
    int direction; /* vpiInput/vpiOutput/vpiInout */
    int width;
    int leftIndex;
    int rightIndex;
    vpiHandle handle;
    /* Último valor (BinStr) reportado ao Core -- usado só pra portas de saída, pra computar o
     * diff que vira o batch de OUTPUT_CHANGE (ver flushChangedOutputs()). Achado real (Step 4):
     * `cbValueChange` registrado no objeto retornado por `vpi_iterate(vpiPort,...)` NUNCA dispara
     * nesta build do GHDL (registro "funciona" sem erro, mas o callback simplesmente não é
     * invocado quando o sinal muda) -- diff por leitura direta é o mecanismo que realmente
     * funciona, então esta é a única fonte de verdade pra saber o que mudou. */
    char lastValue[LSDN_VPI_MAX_WIDTH + 1];
    int hasLastValue;
} PortInfo;

static PortInfo g_ports[LSDN_VPI_MAX_PORTS];
static int g_portCount = 0;

typedef struct ArenaHandle {
#if defined(_WIN32)
    HANDLE mapping;
#else
    int fd;
#endif
    void* base;
    size_t size;
    LsdnFpgaArenaDescriptor* descriptor;
    LsdnFpgaArenaTransport* transport;
    LsdnFpgaChangeEntry* inputChanges;
    LsdnFpgaChangeEntry* outputChanges;
} ArenaHandle;

static ArenaHandle g_arena;
static int g_arenaAttached = 0;

static int descriptorCompatible(const LsdnFpgaArenaDescriptor* descriptor) {
    if (descriptor->magic != LSDN_FPGA_ARENA_ABI_MAGIC ||
        descriptor->abiMajor != LSDN_FPGA_ARENA_ABI_MAJOR ||
        descriptor->descriptorSize != sizeof(LsdnFpgaArenaDescriptor) ||
        descriptor->transportSize != sizeof(LsdnFpgaArenaTransport) ||
        descriptor->changeEntrySize != sizeof(LsdnFpgaChangeEntry) ||
        descriptor->logQueueDepth != LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH) return 0;
    if ((descriptor->coreCapabilities & LSDN_FPGA_ARENA_REQUIRED_CAPABILITIES) !=
        LSDN_FPGA_ARENA_REQUIRED_CAPABILITIES) return 0;
    if (descriptor->inputChangeCapacity > (1u << 20) ||
        descriptor->outputChangeCapacity > (1u << 20)) return 0;
    return 1;
}

/* ---------------------------------------------------------------------------------------------
 * Anexo na arena (só ANEXA, nunca cria -- o Core sempre cria a arena antes de spawnar o processo
 * GHDL, mesma disciplina de McuController/QemuArenaBridge). Descobre as capacidades reais em duas
 * fases no Windows (mapeia só o descriptor primeiro, depois remapeia o tamanho completo agora
 * conhecido); no POSIX, `fstat` no fd já revela o tamanho real do segmento numa passada só -- ver
 * o mesmo raciocínio em GhdlArenaBridge.cpp (Core, C++), aqui reimplementado em C puro porque o
 * módulo VPI não tem acesso a essa classe C++.
 * ------------------------------------------------------------------------------------------- */
static int arenaAttach(ArenaHandle* out, const char* name) {
    memset(out, 0, sizeof(*out));
#if defined(_WIN32)
    out->mapping = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name);
    if (!out->mapping) return 0;
    void* probe = MapViewOfFile(out->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(LsdnFpgaArenaDescriptor));
    if (!probe) {
        CloseHandle(out->mapping);
        return 0;
    }
    LsdnFpgaArenaDescriptor* probeDescriptor = (LsdnFpgaArenaDescriptor*)probe;
    if (!descriptorCompatible(probeDescriptor)) {
        UnmapViewOfFile(probe);
        CloseHandle(out->mapping);
        return 0;
    }
    const uint64_t inputCap = probeDescriptor->inputChangeCapacity;
    const uint64_t outputCap = probeDescriptor->outputChangeCapacity;
    const size_t fullSize = sizeof(LsdnFpgaArenaDescriptor) + sizeof(LsdnFpgaArenaTransport) +
                            (size_t)(inputCap + outputCap) * sizeof(LsdnFpgaChangeEntry);
    UnmapViewOfFile(probe);
    out->base = MapViewOfFile(out->mapping, FILE_MAP_ALL_ACCESS, 0, 0, fullSize);
    if (!out->base) {
        CloseHandle(out->mapping);
        return 0;
    }
    out->size = fullSize;
#else
    char shmName[300];
    if (name[0] == '/')
        snprintf(shmName, sizeof(shmName), "%s", name);
    else
        snprintf(shmName, sizeof(shmName), "/%s", name);
    out->fd = shm_open(shmName, O_RDWR, 0600);
    if (out->fd < 0) return 0;
    struct stat st;
    if (fstat(out->fd, &st) != 0) {
        close(out->fd);
        return 0;
    }
    out->size = (size_t)st.st_size;
    out->base = mmap(NULL, out->size, PROT_READ | PROT_WRITE, MAP_SHARED, out->fd, 0);
    if (out->base == MAP_FAILED) {
        close(out->fd);
        return 0;
    }
#endif
    LsdnFpgaArenaDescriptor* descriptor = (LsdnFpgaArenaDescriptor*)out->base;
    if (!descriptorCompatible(descriptor)) {
#if defined(_WIN32)
        UnmapViewOfFile(out->base);
        CloseHandle(out->mapping);
#else
        munmap(out->base, out->size);
        close(out->fd);
#endif
        memset(out, 0, sizeof(*out));
        return 0;
    }
    const size_t expectedSize = sizeof(LsdnFpgaArenaDescriptor) + sizeof(LsdnFpgaArenaTransport) +
        (size_t)(descriptor->inputChangeCapacity + descriptor->outputChangeCapacity) * sizeof(LsdnFpgaChangeEntry);
    if (out->size < expectedSize) {
#if defined(_WIN32)
        UnmapViewOfFile(out->base);
        CloseHandle(out->mapping);
#else
        munmap(out->base, out->size);
        close(out->fd);
#endif
        memset(out, 0, sizeof(*out));
        return 0;
    }
    out->descriptor = (LsdnFpgaArenaDescriptor*)out->base;
    out->transport = (LsdnFpgaArenaTransport*)((unsigned char*)out->base + sizeof(LsdnFpgaArenaDescriptor));
    out->inputChanges = lsdnFpgaArenaInputChanges(out->transport);
    out->outputChanges = lsdnFpgaArenaOutputChanges(out->transport, out->descriptor->inputChangeCapacity);
    return 1;
}

/* ---------------------------------------------------------------------------------------------
 * Tempo: convenção deste protocolo é nanossegundos em TODO o transporte (mesmo domínio do
 * Scheduler do Core), não uma unidade interna mais fina -- decisão do Step 4, ver comentário de
 * topo do plano FPGA sobre "pode não precisar de uma unidade separada". GHDL precisa então ser
 * invocado com `--time-resolution=ns` (responsabilidade de GhdlBackend, não deste módulo) pra essa
 * convenção bater exatamente com o que `vpi_get_time`/`s_vpi_time` retornam.
 * ------------------------------------------------------------------------------------------- */
static uint64_t vpiTimeToNs(const s_vpi_time* t) { return ((uint64_t)t->high << 32) | (uint64_t)t->low; }

static void nsToVpiTime(uint64_t ns, s_vpi_time* t) {
    t->type = vpiSimTime;
    t->high = (PLI_UINT32)(ns >> 32);
    t->low = (PLI_UINT32)(ns & 0xffffffffu);
}

static uint64_t currentSimTimeNs(void) {
    s_vpi_time t;
    t.type = vpiSimTime;
    vpi_get_time(NULL, &t);
    return vpiTimeToNs(&t);
}

#if defined(_WIN32)
static void sleepBriefly(void) { Sleep(1); }
#else
static void sleepBriefly(void) { usleep(500); }
#endif

/* ---------------------------------------------------------------------------------------------
 * Descoberta de portas -- compartilhada entre os dois modos (discover imprime; run usa pra saber
 * quais handles ler/escrever). Confia na ordem de retorno de `vpi_iterate(vpiPort, top)` ser
 * estável/determinística (bateu com a ordem de declaração da entity nos testes do Spike 0) --
 * FpgaPortMapper (Step 5, lado Core) é quem traduz esse `portIndex`/`bitIndex` canônico pros
 * nomes/índices `downto`/`to` reais que o usuário declarou em VHDL.
 * ------------------------------------------------------------------------------------------- */
static vpiHandle findTopModule(void) {
    vpiHandle iterator = vpi_iterate(vpiModule, NULL);
    if (!iterator) return NULL;
    return vpi_scan(iterator);
}

static const char* directionName(int direction);

static int rangeIndex(vpiHandle port, int relation, int fallback) {
    vpiHandle range = vpi_handle(relation, port);
    if (!range) return fallback;
    s_vpi_value value;
    value.format = vpiIntVal;
    vpi_get_value(range, &value);
    return value.value.integer;
}

static int buildPortTable(vpiHandle top) {
    g_portCount = 0;
    vpiHandle portIterator = vpi_iterate(vpiPort, top);
    vpiHandle port;
    while (portIterator && (port = vpi_scan(portIterator)) != NULL) {
        if (g_portCount >= LSDN_VPI_MAX_PORTS) {
            vpi_printf("LSDN_FPGA_ERROR mais de %d portas; limite excedido\n", LSDN_VPI_MAX_PORTS);
            return 0;
        }
        PortInfo* info = &g_ports[g_portCount];
        const char* name = vpi_get_str(vpiName, port);
        snprintf(info->name, sizeof(info->name), "%s", name ? name : "?");
        info->direction = vpi_get(vpiDirection, port);
        info->width = vpi_get(vpiSize, port);
        if (info->width <= 0) info->width = 1;
        if (info->width > LSDN_VPI_MAX_WIDTH) {
            vpi_printf("LSDN_FPGA_ERROR port '%s' com %d bits excede o maximo suportado (%d)\n",
                      info->name, info->width, LSDN_VPI_MAX_WIDTH);
            return 0;
        }
        if (info->direction != vpiInput && info->direction != vpiOutput) {
            vpi_printf("LSDN_FPGA_ERROR port '%s' usa direcao nao suportada: %s\n",
                       info->name, directionName(info->direction));
            return 0;
        }
        info->leftIndex = rangeIndex(port, vpiLeftRange, info->width - 1);
        info->rightIndex = rangeIndex(port, vpiRightRange, 0);
        // Achado real (Step 4, confirmado contra GHDL real): `vpiPort` (o que `vpi_iterate`
        // devolve) é um objeto de CONEXÃO (IEEE 1364 vpiLowConn/vpiHighConn), não o sinal em si --
        // `vpi_put_value` nele parece funcionar sem erro, mas `cbValueChange` registrado ali NUNCA
        // dispara. `vpiLowConn` também retorna NULL pra ports de entity top-level nesta build
        // (sem instância pai que preencha essa relação). O mecanismo que efetivamente funciona
        // (leitura/escrita/mudança de valor visível) é resolver o sinal pelo NOME HIERÁRQUICO
        // COMPLETO com escopo NULL -- `vpi_handle_by_name("top.nome", NULL)`, não a forma relativa
        // `vpi_handle_by_name("nome", top)` (que parece resolver pro mesmo pseudo-objeto de
        // conexão do port). Usa ESSE handle pra tudo (leitura/escrita/diff de saída), não só
        // descoberta.
        char fullyQualifiedName[256];
        const char* topFullName = vpi_get_str(vpiFullName, top);
        snprintf(fullyQualifiedName, sizeof(fullyQualifiedName), "%s.%s", topFullName ? topFullName : "", info->name);
        vpiHandle signalHandle = vpi_handle_by_name((PLI_BYTE8*)fullyQualifiedName, NULL);
        info->handle = signalHandle ? signalHandle : port;
        info->hasLastValue = 0;
        info->lastValue[0] = '\0';
        g_portCount++;
    }
    return 1;
}

static const char* directionName(int direction) {
    if (direction == vpiInput) return "in";
    if (direction == vpiOutput) return "out";
    if (direction == vpiInout) return "inout";
    return "unknown";
}

/* ---------------------------------------------------------------------------------------------
 * Modo "discover" -- ver comentário de topo. Formato de linha simples e prefixado (não JSON: sem
 * dependência nova só pra isto), parseado por GhdlBackend (Core) no fluxo "Analyze VHDL".
 * ------------------------------------------------------------------------------------------- */
static void runDiscoverMode(vpiHandle top) {
    if (!buildPortTable(top)) {
        vpi_control(vpiFinish, 1);
        return;
    }
    vpi_printf("LSDN_FPGA_TOP %s\n", vpi_get_str(vpiFullName, top));
    for (int i = 0; i < g_portCount; ++i) {
        vpi_printf("LSDN_FPGA_PORT name=%s direction=%s width=%d left=%d right=%d\n", g_ports[i].name,
                  directionName(g_ports[i].direction), g_ports[i].width,
                  g_ports[i].leftIndex, g_ports[i].rightIndex);
    }
    vpi_printf("LSDN_FPGA_PORTS_DONE\n");
    // `vpi_flush()` existe no header padrao mas nao e exportado por libghdlvpi nesta build do
    // GHDL (achado empirico -- linkagem falha com "undefined reference to __imp_vpi_flush").
    // Dispensavel aqui: `vpi_control(vpiFinish)` termina o processo logo em seguida, e a saida
    // padrao ja e flushada na saida normal do processo.
    vpi_control(vpiFinish, 0);
}

/* ---------------------------------------------------------------------------------------------
 * Modo "run" -- loop de comando/resposta real.
 * ------------------------------------------------------------------------------------------- */

static void logToArena(LsdnFpgaLogSeverity severity, const char* message) {
    if (!g_arenaAttached) return;
    LsdnFpgaArenaTransport* transport = g_arena.transport;
    const uint64_t writeIndex = transport->logWriteIndex;
    const uint64_t readIndex = __atomic_load_n(&transport->logReadIndex, __ATOMIC_ACQUIRE);
    if (writeIndex - readIndex >= LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH) {
        static uint64_t dropped = 0;
        dropped++;
        if (dropped == 1 || (dropped & (dropped - 1)) == 0)
            vpi_printf("[lasecsimul_vpi] log queue cheia; mensagens descartadas=%llu\n",
                       (unsigned long long)dropped);
        return;
    }
    const uint64_t slot = writeIndex % LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH;
    LsdnFpgaLogEntry* entry = &transport->logQueue[slot];
    entry->severity = (uint32_t)severity;
    entry->timeNs = currentSimTimeNs();
    snprintf(entry->message, LSDN_FPGA_ARENA_LOG_MESSAGE_MAX, "%s", message);
    __atomic_store_n(&transport->logWriteIndex, writeIndex + 1, __ATOMIC_RELEASE);
}

/** Aplica as entradas de `inputChanges[0..inputChangeCount)` publicadas pelo Core -- agrupa por
 * port (lê o BinStr atual, muta as posições tocadas, escreve de volta uma vez), não bit a bit,
 * pra minimizar chamadas VPI. Só 0/1 têm efeito real neste build do GHDL (ver comentário de
 * topo) -- os demais valores são convertidos e enviados mesmo assim (inofensivo: o GHDL
 * simplesmente ignora, mesmo comportamento observado no Spike 0), não são filtrados aqui porque
 * filtrar seria assumir uma limitação de UM build específico como contrato permanente do
 * protocolo. */
static void applyInputChanges(void) {
    LsdnFpgaArenaTransport* transport = g_arena.transport;
    const uint64_t count = transport->inputChangeCount;
    static int touched[LSDN_VPI_MAX_PORTS];
    memset(touched, 0, sizeof(int) * (size_t)g_portCount);

    /* Passo 1: só marca quais ports foram tocados nesta rodada -- a mutação real acontece no
     * passo 2, um port de cada vez, pra não precisar de um buffer de string por port. */
    for (uint64_t i = 0; i < count; ++i) {
        const LsdnFpgaChangeEntry* entry = &g_arena.inputChanges[i];
        if (entry->portIndex >= (uint32_t)g_portCount) continue; // corrompido/versão incompatível -- ignora, não crasha
        const PortInfo* port = &g_ports[entry->portIndex];
        if (port->direction != vpiInput && port->direction != vpiInout) continue;
        if (entry->bitIndex >= (uint32_t)port->width) continue;
        touched[entry->portIndex] = 1;
    }

    /* Passo 2: pra cada port tocado, lê o BinStr atual, aplica TODAS as entradas desta rodada que
     * caem nele, escreve de volta numa única chamada VPI. bitIndex 0 = caractere mais à esquerda
     * do BinStr (convenção deste módulo -- ver comentário de LsdnFpgaChangeEntry em
     * fpga_arena_abi.h; FpgaPortMapper, Step 5, traduz isso pros índices `downto`/`to` reais da
     * entity). */
    for (int p = 0; p < g_portCount; ++p) {
        if (!touched[p]) continue;
        s_vpi_value current;
        current.format = vpiBinStrVal;
        vpi_get_value(g_ports[p].handle, &current);

        char finalStr[LSDN_VPI_MAX_WIDTH + 1];
        snprintf(finalStr, sizeof(finalStr), "%s", current.value.str ? current.value.str : "");
        const size_t currentLen = strlen(finalStr);
        // BinStr do GHDL tem exatamente `width` caracteres pra um port vetor (visto no Spike 0);
        // se por algum motivo vier menor, preenche o resto com '0' pra não deixar lixo.
        for (size_t pad = currentLen; pad < (size_t)g_ports[p].width; ++pad) finalStr[pad] = '0';
        finalStr[g_ports[p].width] = '\0';

        for (uint64_t i = 0; i < count; ++i) {
            const LsdnFpgaChangeEntry* entry = &g_arena.inputChanges[i];
            if (entry->portIndex != (uint32_t)p) continue;
            if (entry->bitIndex >= (uint32_t)g_ports[p].width) continue;
            finalStr[entry->bitIndex] = lsdnFpgaLogicValueToChar(entry->value);
        }

        // vpiNoDelay (mesma técnica do Spike 0) -- o valor só fica visível pra outros
        // processos/portas depois que ESTE callback retornar e o kernel processar o delta cycle
        // resultante (ver onAdvanceTargetReached/replyAndWaitForNextCommand sobre o porquê disso
        // exigir um `cbAfterDelay` com delay > 0, nunca 0, pra observar o resultado depois).
        s_vpi_value newValue;
        newValue.format = vpiBinStrVal;
        newValue.value.str = finalStr;
        vpi_put_value(g_ports[p].handle, &newValue, NULL, vpiNoDelay);
    }
}

/** Empacota TODOS os bits de cada port de saída cujo valor DIFERE do último reportado
 * (`PortInfo::lastValue`) no array de tamanho dinâmico `outputChanges[]`, e atualiza
 * `lastValue` pro valor atual. Diff por leitura direta, não por `cbValueChange` -- ver comentário
 * de `PortInfo::lastValue` sobre por que esse callback não é confiável nesta build do GHDL.
 * Detecta overflow explicitamente (ver fpga_arena_abi.h) em vez de truncar em silêncio. */
static void flushChangedOutputs(void) {
    LsdnFpgaArenaTransport* transport = g_arena.transport;
    const uint64_t capacity = g_arena.descriptor->outputChangeCapacity;
    uint64_t count = 0;
    int overflow = 0;

    for (int p = 0; p < g_portCount && !overflow; ++p) {
        if (g_ports[p].direction != vpiOutput) continue;
        s_vpi_value value;
        value.format = vpiBinStrVal;
        vpi_get_value(g_ports[p].handle, &value);
        const char* text = value.value.str ? value.value.str : "";
        const size_t width = (size_t)g_ports[p].width;

        for (size_t bit = 0; bit < width; ++bit) {
            const char ch = bit < strlen(text) ? text[bit] : '0';
            const char previousCh = g_ports[p].hasLastValue && bit < strlen(g_ports[p].lastValue)
                                        ? g_ports[p].lastValue[bit]
                                        : '\0'; // sentinela: primeira rodada sempre reporta tudo
            if (ch == previousCh) continue;
            if (count >= capacity) {
                overflow = 1;
                break;
            }
            LsdnFpgaChangeEntry* entry = &g_arena.outputChanges[count];
            entry->portIndex = (uint32_t)p;
            entry->bitIndex = (uint32_t)bit;
            entry->value = lsdnFpgaCharToLogicValue(ch);
            count++;
        }

        snprintf(g_ports[p].lastValue, sizeof(g_ports[p].lastValue), "%s", text);
        g_ports[p].hasLastValue = 1;
    }

    if (overflow) {
        transport->outputChangeCount = 0;
        transport->outputOverflow = 1;
        logToArena(LSDN_FPGA_LOG_ERROR, "OUTPUT_CHANGE overflow -- mais bits mudaram do que a capacidade negociada");
    } else {
        transport->outputChangeCount = count;
        transport->outputOverflow = 0;
    }
}

static uint64_t g_pendingCommandSeq = 0;

static void replyAndWaitForNextCommand(void); // fwd decl

/** Disparado pelo `cbAfterDelay` agendado em `replyAndWaitForNextCommand()` -- só chega aqui
 * quando o kernel do GHDL já resolveu todo evento/delta cycle até o instante pedido. Achado real
 * (Step 4, confirmado empiricamente contra GHDL real): um `cbAfterDelay` com delay ZERO nunca
 * deixa o kernel processar o delta cycle disparado pela entrada que acabamos de depositar --
 * `led0` permanecia lendo 'U' mesmo depois de centenas de hops de delay zero encadeados, mas
 * estabilizava corretamente (`led0=1`) já no PRIMEIRO hop assim que um delay REALMENTE positivo
 * (ex.: 100ns) era usado. Por isso `replyAndWaitForNextCommand` nunca agenda delay zero (ver
 * `kMinAdvanceDelayNs` ali) -- não existe um settle-loop aqui porque não é necessário: um único
 * hop com delay >= 1 já resolve de verdade, delay zero nunca resolve nem com quantos hops forem
 * encadeados (não é uma questão de "quantidade de tentativas", é uma questão de a simulação
 * genuinamente não avançar em delay zero neste build do GHDL). */
static PLI_INT32 onAdvanceTargetReached(p_cb_data cb) {
    (void)cb;
    flushChangedOutputs();
    g_arena.transport->reachedTimeNs = currentSimTimeNs();
    __atomic_store_n(&g_arena.transport->state, LSDN_FPGA_STATE_RUNNING, __ATOMIC_RELAXED);
    // TIME_REACHED: publica a resposta só DEPOIS de reachedTimeNs/outputChange* estarem prontos
    // -- mesmo princípio de "confirma por último" de QemuArenaBridge.
    __atomic_store_n(&g_arena.transport->replySeq, g_pendingCommandSeq, __ATOMIC_RELEASE);
    replyAndWaitForNextCommand();
    return 0;
}

/** Loop de comando: busy-poll (com sleep curto) até `commandSeq` avançar -- seguro porque, dentro
 * de um callback VPI, o kernel do GHDL não faz mais nada até este retornar (mesma premissa
 * validada no Spike 0). Ao ver ADVANCE_TO: aplica as entradas, calcula o delta até o instante
 * pedido e agenda `onAdvanceTargetReached` -- e RETORNA (devolve o controle pro kernel avançar de
 * verdade). Ao ver RESET/STOP: termina a simulação. Nunca recursivo através de ciclos "espera então
 * avança" -- cada ciclo é uma invocação de callback nova vinda do kernel do GHDL, não uma chamada
 * de função aninhada, então a pilha não cresce ao longo de uma sessão longa. */
static void replyAndWaitForNextCommand(void) {
    uint64_t lastSeenCommandSeq = g_pendingCommandSeq;
    for (;;) {
        const uint64_t commandSeq = __atomic_load_n(&g_arena.transport->commandSeq, __ATOMIC_ACQUIRE);
        if (commandSeq == lastSeenCommandSeq) {
            sleepBriefly();
            continue;
        }
        g_pendingCommandSeq = commandSeq;
        const uint64_t command = g_arena.transport->command;

        if (command == LSDN_FPGA_CMD_RESET || command == LSDN_FPGA_CMD_STOP) {
            __atomic_store_n(&g_arena.transport->state, LSDN_FPGA_STATE_STOPPED, __ATOMIC_RELEASE);
            __atomic_store_n(&g_arena.transport->replySeq, commandSeq, __ATOMIC_RELEASE);
            vpi_control(vpiFinish, 0);
            return;
        }

        if (command == LSDN_FPGA_CMD_ADVANCE_TO) {
            applyInputChanges();
            const uint64_t targetNs = g_arena.transport->requestedTimeNs;
            const uint64_t nowNs = currentSimTimeNs();
            // Achado real, confirmado empiricamente contra GHDL real (Step 4): um `cbAfterDelay`
            // com delay ZERO nunca deixa o kernel processar o delta cycle disparado pela entrada
            // que acabamos de depositar -- nem encadeando centenas de hops de delay zero (testado
            // e descartado). Um ÚNICO hop com delay >= 1 já resolve corretamente. Por isso este
            // protocolo exige `targetNs > nowNs` sempre -- nunca pedir ADVANCE_TO pro instante em
            // que o GHDL já está (FpgaComponent, Core, deve sempre pedir pelo menos +1ns quando
            // precisar observar reação a uma entrada nova, mesmo em t=0 pra amostragem inicial).
            // `kMinAdvanceDeltaNs` é a rede de segurança caso o Core viole essa premissa -- nunca
            // trava esperando um delay zero que nunca resolve, mas o `reachedTimeNs` reportado
            // então DIFERE do `targetNs` pedido (documentar isso na integração real, Step 5, não
            // silenciar).
            static const uint64_t kMinAdvanceDeltaNs = 1;
            uint64_t deltaNs = targetNs > nowNs ? targetNs - nowNs : 0;
            if (deltaNs == 0) {
                deltaNs = kMinAdvanceDeltaNs;
                logToArena(LSDN_FPGA_LOG_WARNING,
                          "ADVANCE_TO pediu o instante atual (delay zero nunca resolve delta cycles neste "
                          "GHDL) -- avancando +1ns internamente, reachedTimeNs vai diferir do pedido");
            }

            s_cb_data cbData;
            s_vpi_time delay;
            nsToVpiTime(deltaNs, &delay);
            memset(&cbData, 0, sizeof(cbData));
            cbData.reason = cbAfterDelay;
            cbData.cb_rtn = onAdvanceTargetReached;
            cbData.time = &delay;
            vpi_register_cb(&cbData);
            return; // devolve o controle pro kernel do GHDL avancar ate o instante agendado
        }

        // comando desconhecido (versão futura do Core?) -- loga e ignora, não trava o loop.
        logToArena(LSDN_FPGA_LOG_WARNING, "comando desconhecido recebido, ignorado");
        __atomic_store_n(&g_arena.transport->replySeq, commandSeq, __ATOMIC_RELEASE);
        lastSeenCommandSeq = commandSeq;
    }
}

static PLI_INT32 onStartOfSimulation(p_cb_data cb) {
    (void)cb;
    vpiHandle top = findTopModule();
    if (!top) {
        vpi_printf("[lasecsimul_vpi] ERRO: nenhum modulo top encontrado via vpi_iterate(vpiModule,NULL)\n");
        vpi_control(vpiFinish, 1);
        return 0;
    }

    const char* mode = getenv("LASECSIMUL_FPGA_MODE");
    if (!mode || strcmp(mode, "discover") == 0) {
        runDiscoverMode(top);
        return 0;
    }

    if (strcmp(mode, "run") != 0) {
        vpi_printf("[lasecsimul_vpi] ERRO: LASECSIMUL_FPGA_MODE invalido: %s\n", mode);
        vpi_control(vpiFinish, 1);
        return 0;
    }

    const char* arenaName = getenv("LASECSIMUL_FPGA_ARENA_NAME");
    if (!arenaName || !arenaName[0]) {
        vpi_printf("[lasecsimul_vpi] ERRO: LASECSIMUL_FPGA_ARENA_NAME nao definido no modo run\n");
        vpi_control(vpiFinish, 1);
        return 0;
    }

    if (!buildPortTable(top)) {
        vpi_control(vpiFinish, 1);
        return 0;
    }

    if (!arenaAttach(&g_arena, arenaName)) {
        vpi_printf("[lasecsimul_vpi] ERRO: nao foi possivel anexar na arena '%s'\n", arenaName);
        vpi_control(vpiFinish, 1);
        return 0;
    }
    g_arenaAttached = 1;

    g_arena.descriptor->ghdlCapabilities = LSDN_FPGA_ARENA_CAPABILITIES;
    const uint64_t negotiated = g_arena.descriptor->coreCapabilities & LSDN_FPGA_ARENA_CAPABILITIES;
    g_arena.descriptor->negotiatedCapabilities = negotiated;
    __atomic_store_n(&g_arena.transport->state, LSDN_FPGA_STATE_READY, __ATOMIC_RELAXED);
    __atomic_store_n(&g_arena.descriptor->ghdlReady, 1, __ATOMIC_RELEASE);

    if ((negotiated & LSDN_FPGA_ARENA_REQUIRED_CAPABILITIES) != LSDN_FPGA_ARENA_REQUIRED_CAPABILITIES) {
        logToArena(LSDN_FPGA_LOG_ERROR, "negociacao de capacidades falhou");
        __atomic_store_n(&g_arena.transport->state, LSDN_FPGA_STATE_FAULTED, __ATOMIC_RELEASE);
        vpi_control(vpiFinish, 1);
        return 0;
    }

    replyAndWaitForNextCommand();
    return 0;
}

static PLI_INT32 onEndOfSimulation(p_cb_data cb) {
    (void)cb;
    if (g_arenaAttached) {
        __atomic_store_n(&g_arena.transport->state, LSDN_FPGA_STATE_STOPPED, __ATOMIC_RELEASE);
    }
    return 0;
}

static void lasecsimulVpiRegister(void) {
    s_cb_data startCb;
    memset(&startCb, 0, sizeof(startCb));
    startCb.reason = cbStartOfSimulation;
    startCb.cb_rtn = onStartOfSimulation;
    vpi_register_cb(&startCb);

    s_cb_data endCb;
    memset(&endCb, 0, sizeof(endCb));
    endCb.reason = cbEndOfSimulation;
    endCb.cb_rtn = onEndOfSimulation;
    vpi_register_cb(&endCb);
}

void (*vlog_startup_routines[])(void) = {
    lasecsimulVpiRegister,
    0
};
