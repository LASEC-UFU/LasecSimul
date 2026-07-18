/*
 * ABI publica de adaptadores de MCU nativos do LasecSimul (DLL/SO).
 * Mesma familia/regras do device_abi.h — fronteira 100% C.
 *
 * Mecanismo validado contra o SimulIDE real, codigo lido diretamente (nao suposicao) --
 * C:\SourceCode\simulide_2\src\microsim\cores\qemu\{qemudevice,qemumodule,esp32\esp32gpio}.{h,cpp}
 * e o protocolo do fork QEMU em C:\SourceCode\qemu_simulide (system/simuliface.{h,c}):
 *
 * O QEMU manda registrador BRUTO (endereco + valor, ver qemu_arena_abi.h SIM_READ/SIM_WRITE) --
 * ele NAO decodifica nada antes de mandar (confirmado lendo hw/gpio/esp32_gpio.c: escreve
 * writeReg(GPIO_OFFSET+0x04, valor) direto, sem nenhuma logica de IOMUX/pin-matrix do lado QEMU).
 * Quem decodifica e' o MODULO (LsdnQemuModuleVTable, ex: GPIO do ESP32) dono daquela faixa de
 * endereco -- isso e' CHIP-ESPECIFICO de proposito, nao da pra ser generico (registrador de
 * GPIO/IOMUX varia por chip e familia). Nao existe "modulo generico do Core" nenhum: o adaptador
 * declara as faixas (get_memory_regions/get_pin_map) E os modulos concretos que decodificam cada
 * uma (create_modules) -- tudo do lado do plugin.
 *
 * Neutralidade obrigatoria (isso sim nunca muda por chip): Scheduler/Netlist/IPC/UI e o proprio
 * `McuComponent` (que implementa IComponentModel pra entrar no circuito com pinos reais via
 * pinMap()) -- ele so repassa registrador pro LsdnQemuModuleHandle certo, nunca interpreta nada.
 *
 * Ver .spec/lasecsimul.spec, secao 8, e .spec/lasecsimul-native-devices.spec, secao 8.1 e 20.
 */
#ifndef LASECSIMUL_MCU_ABI_H
#define LASECSIMUL_MCU_ABI_H

#include <stdint.h>
#include "device_abi.h" /* reaproveita LSDN_EXPORT */

#ifdef __cplusplus
extern "C" {
#endif

#define LSDN_MCU_ABI_VERSION_MAJOR 2
#define LSDN_MCU_ABI_VERSION_MINOR 5
/* Major 2 (2026-06-28): entrou LsdnQemuModuleVTable/LsdnQemuModuleHandle e
 * LsdnMcuVTable::create_modules -- antes desta versao um plugin de MCU so conseguia DECLARAR faixas
 * de endereco/pinos (get_memory_regions/get_pin_map), nunca decodificar registrador de verdade (o
 * Core nao tinha como chamar codigo do plugin pra isso) -- um adaptador de MCU via plugin ficava
 * eletricamente inerte (escritas de registrador descartadas, pinos sempre flutuantes). Com
 * create_modules, um plugin declara o mesmo QemuModule (chip-especifico) que um adaptador built-in
 * ja usava -- mesmo custo de chamada (ponteiro de funcao C, mesmo processo, sem IPC) que qualquer
 * outra funcao desta ABI. Ver docs/17-pendencias-pos-sessao-qemu-abi.md secao 3.4 (pendencia
 * original) e docs/18-guia-dispositivo-abi-e-mcu-qemu.md secao 2 (que esta correcao tornou
 * desatualizada -- atualizar junto).
 * Minor 4 (2026-06-29): entrou LSDN_MODULE_RESET -- pino de controle de hardware (EN do ESP32),
 * tratado especialmente por McuComponent::stamp() (nunca tem LsdnQemuModule proprio, nao ha
 * registrador por tras). Ver .spec/lasecsimul-native-devices.spec secao 8.1. */

typedef struct LsdnMcuAdapter LsdnMcuAdapter; /* opaco */

typedef enum LsdnModuleKind {
    LSDN_MODULE_GPIO = 0,
    LSDN_MODULE_IOMUX = 1,
    LSDN_MODULE_I2C = 2,
    LSDN_MODULE_SPI = 3,
    LSDN_MODULE_USART = 4,
    LSDN_MODULE_TIMER = 5,
    LSDN_MODULE_RESET = 6,
    LSDN_MODULE_ADC = 7,
    LSDN_MODULE_PWM = 8
} LsdnModuleKind;

/* Uma faixa de endereco MMIO do chip e o periferico generico do Core que deve trata-la.
 * Equivalente a m_memStart/m_memEnd de QemuModule no SimulIDE. */
typedef struct LsdnMemoryRegion {
    uint64_t start;
    uint64_t end;
    LsdnModuleKind moduleKind;
    uint32_t moduleIndex; /* qual instancia do periferico, ex: I2C0 vs I2C1 */
} LsdnMemoryRegion;

/* Um bit/linha de um periferico (tipicamente GPIO) mapeado para um pino fisico do circuito. */
typedef struct LsdnPinMapping {
    const char* pinId;   /* ex: "GPIO2" */
    LsdnModuleKind moduleKind;
    uint32_t moduleIndex;
    uint32_t bitOrLine;
} LsdnPinMapping;

typedef struct LsdnQemuLaunchSpec {
    const char* binary;        /* ex: "qemu-system-xtensa" */
    const char* const* args;   /* argv, terminado por NULL no ultimo elemento */
    uint32_t arg_count;
} LsdnQemuLaunchSpec;

typedef struct LsdnMcuHostApi {
    void     (*log)(void* host_ctx, int32_t level, const char* msg);
    uint64_t (*now_ns)(void* host_ctx);
} LsdnMcuHostApi;

/* Opaco: estado de UM modulo concreto (ex: GPIO do chip X) -- equivalente, do lado da ABI C, ao
 * QemuModule C++ (core/include/lasecsimul/QemuModule.hpp). Cada plugin de MCU que queira de fato
 * decodificar registrador (nao so declarar faixa de endereco) cria um destes por periferico. */
typedef struct LsdnQemuModule LsdnQemuModule;

#define LSDN_QEMU_MODULE_NO_WAKEUP UINT64_MAX

/* As funcoes de UM modulo concreto -- mesmo papel dos metodos virtuais de QemuModule, so que como
 * ponteiro de funcao C pra cruzar a fronteira ABI. `is_output_enabled`/`output_level` devolvem
 * int32_t (0/1) por ser C; `set_input_level` recebe int32_t pela mesma razao.
 * `write_register`/`read_register` sao OBRIGATORIAS (mesma exigencia de QemuModule::writeRegister/
 * readRegister, virtuais puras no lado C++) -- e' o minimo pra um modulo existir. `reset`/
 * `is_output_enabled`/`output_level`/`set_input_level`/`destroy` sao opcionais (NULL e' tratado como
 * no-op/"sempre nao-driver", mesmo default de QemuModule em C++) -- um modulo que nao e GPIO-like
 * (ex: timer puro) deixa os tres do meio como NULL. */
typedef struct LsdnQemuModuleVTable {
    void     (*reset)(LsdnQemuModule* module);
    void     (*write_register)(LsdnQemuModule* module, uint64_t address, uint64_t value);
    uint64_t (*read_register)(LsdnQemuModule* module, uint64_t address);
    int32_t  (*is_output_enabled)(LsdnQemuModule* module, uint32_t bit_or_line);
    int32_t  (*output_level)(LsdnQemuModule* module, uint32_t bit_or_line);
    void     (*set_input_level)(LsdnQemuModule* module, uint32_t bit_or_line, int32_t level);
    void     (*destroy)(LsdnQemuModule* module);
    uint64_t (*next_wakeup_delay_ns)(LsdnQemuModule* module);
    void     (*on_wakeup)(LsdnQemuModule* module, uint64_t now_ns);
    void     (*write_register_at)(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t now_ns);
    void     (*set_input_level_at)(LsdnQemuModule* module, uint32_t bit_or_line, int32_t level, uint64_t now_ns);
    uint64_t (*next_wakeup_delay_ns_at)(LsdnQemuModule* module, uint64_t now_ns);
    /* Minor 5: tensao eletrica real do pad. O callback antigo HIGH/LOW continua presente para
     * plugins digitais; adaptadores com ADC podem receber a amostra em volts sem quantizacao. */
    void     (*set_input_voltage_at)(LsdnQemuModule* module, uint32_t bit_or_line,
                                     double voltage, uint64_t now_ns);
} LsdnQemuModuleVTable;

/* Um modulo concreto devolvido por create_modules(): estado opaco + vtable + identidade
 * (moduleKind/moduleIndex, mesma identidade ja usada em LsdnMemoryRegion/LsdnPinMapping) -- e assim
 * que o Core acha qual handle corresponde a qual faixa de endereco/pino. */
typedef struct LsdnQemuModuleHandle {
    LsdnModuleKind moduleKind;
    uint32_t moduleIndex;
    LsdnQemuModule* module;
    const LsdnQemuModuleVTable* vtable;
} LsdnQemuModuleHandle;

typedef struct LsdnMcuVTable {
    LsdnMcuAdapter*    (*create)(void* host_ctx, const LsdnMcuHostApi* host_api);
    LsdnQemuLaunchSpec (*build_launch_args)(LsdnMcuAdapter* adapter, const char* firmware_path);

    /* Declarativo — chamado uma vez no load, nao por evento. */
    uint32_t (*get_memory_regions)(LsdnMcuAdapter* adapter, LsdnMemoryRegion* out, uint32_t cap);
    uint32_t (*get_pin_map)(LsdnMcuAdapter* adapter, LsdnPinMapping* out, uint32_t cap);

    /* NOVO na major 2. Mesmo protocolo de duas chamadas que get_memory_regions/get_pin_map ja usam
     * (cap=0 so' pra contar, depois de novo com buffer do tamanho certo). Pode devolver 0 (plugin
     * só declarativo, sem nenhum periférico que decodifique registrador de verdade) -- o Core trata
     * isso exatamente como antes da major 2 (pino sempre flutuante), nao e' erro. Cada
     * LsdnQemuModuleHandle devolvido aqui passa a ser dono (`module`) pra sempre, ate' o Core chamar
     * vtable->destroy(module) -- mesma regra de ownership do resto da ABI. */
    uint32_t (*create_modules)(LsdnMcuAdapter* adapter, LsdnQemuModuleHandle* out, uint32_t cap);

    void (*destroy)(LsdnMcuAdapter* adapter);
} LsdnMcuVTable;

/* Simbolo exportado por um plugin de adaptador de MCU — distinto de lsdn_get_vtable (dispositivos)
 * para que o PluginLoader nunca resolva o tipo errado de vtable a partir do mesmo binario. */
typedef const LsdnMcuVTable* (*LsdnGetMcuVTableFn)(uint32_t* abi_major, uint32_t* abi_minor);

#ifdef __cplusplus
}
#endif

#endif /* LASECSIMUL_MCU_ABI_H */
