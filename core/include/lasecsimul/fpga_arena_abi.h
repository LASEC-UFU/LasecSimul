/*
 * FpgaArena ABI v1 -- transporte de memória compartilhada entre o Core e o processo GHDL (via
 * `lasecsimul_vpi`), independente da ABI do QEMU (`qemu_arena_abi.h`) de propósito -- GHDL não é
 * um participante assíncrono como o QEMU (que roda livre e precisa ser "puxado" de volta pelo
 * Scheduler via `AdvanceLimitFn`/pacing), é um participante COMANDADO: o Core manda
 * `ADVANCE_TO(targetNs)`, GHDL resolve todo evento/delta cycle até lá e só então responde
 * `TIME_REACHED(targetNs)` -- ver Spike 0 (`.claude/plans/golden-puzzling-quasar.md`), que provou
 * empiricamente contra um GHDL real que isso funciona via `cbAfterDelay` se rearmando dentro do
 * próprio callback VPI (GHDL não faz mais nada enquanto o callback não retorna -- é single-thread
 * por construção, não precisa de mutex/condvar cruzando o processo). Por isso este protocolo é
 * request/reply simples (commandSeq/replySeq), não uma fila circular de "dispara e esquece" como
 * a do QEMU.
 *
 * Diferença deliberada de `qemu_arena_abi.h`: a fila de 32 entradas do QEMU foi dimensionada pro
 * padrão de tráfego de registrador do QEMU (um write por vez); um FPGA pode legitimamente reportar
 * uma mudança de OUTPUT_CHANGE por BIT de saída que mudou num único ADVANCE_TO (ex.: um contador de
 * 32 bits virando todos os bits de uma vez) -- um burst muito maior. Por isso os arrays de mudança
 * de entrada/saída NÃO são uma fila circular de tamanho fixo: são arrays de tamanho dinâmico
 * (`inputChangeCapacity`/`outputChangeCapacity`, no fim do mapeamento, DEPOIS de
 * `LsdnFpgaArenaTransport`), dimensionados pelo Core no `open()` a partir da contagem real de bits
 * do componente (`FpgaPortMapper`) -- nunca um número arbitrário copiado do QEMU. Se GHDL tentar
 * reportar mais mudanças do que a capacidade permite numa rodada, `outputOverflow` é setado e a
 * rodada inteira é tratada como falha pelo Core (nunca aceitar dados truncados em silêncio).
 *
 * A fila de LOG/ASSERT/ERROR continua uma fila circular pequena e de tamanho FIXO
 * (`LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH`) -- mensagens são raras (não um burst por bit), então o
 * padrão do QEMU (índices sempre crescentes, nunca resetam) se aplica sem ressalva aqui.
 */
#ifndef LASECSIMUL_FPGA_ARENA_ABI_H
#define LASECSIMUL_FPGA_ARENA_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LSDN_FPGA_ARENA_ABI_MAGIC UINT64_C(0x4c53444e46415231) /* "LSDNFAR1" */
#define LSDN_FPGA_ARENA_ABI_MAJOR 1
#define LSDN_FPGA_ARENA_ABI_MINOR 0

#define LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH 8
#define LSDN_FPGA_ARENA_LOG_MESSAGE_MAX 256

#define LSDN_FPGA_ARENA_CAP_LOCKSTEP     (UINT64_C(1) << 0)
#define LSDN_FPGA_ARENA_CAP_OUTPUT_BATCH (UINT64_C(1) << 1)
#define LSDN_FPGA_ARENA_CAPABILITIES (LSDN_FPGA_ARENA_CAP_LOCKSTEP | LSDN_FPGA_ARENA_CAP_OUTPUT_BATCH)
#define LSDN_FPGA_ARENA_REQUIRED_CAPABILITIES LSDN_FPGA_ARENA_CAPABILITIES

/* Estado do lado GHDL, espelhado em `LsdnFpgaArenaTransport::state`. */
typedef enum LsdnFpgaState {
    LSDN_FPGA_STATE_NOT_STARTED = 0,
    LSDN_FPGA_STATE_READY = 1,
    LSDN_FPGA_STATE_RUNNING = 2,
    LSDN_FPGA_STATE_STOPPED = 3,
    LSDN_FPGA_STATE_FAULTED = 4,
} LsdnFpgaState;

/* Comando publicado pelo Core em `LsdnFpgaArenaTransport::command`. */
typedef enum LsdnFpgaCommand {
    LSDN_FPGA_CMD_NONE = 0,
    LSDN_FPGA_CMD_ADVANCE_TO = 1,
    LSDN_FPGA_CMD_RESET = 2,
    LSDN_FPGA_CMD_STOP = 3,
} LsdnFpgaCommand;

typedef enum LsdnFpgaLogSeverity {
    LSDN_FPGA_LOG_INFO = 0,
    LSDN_FPGA_LOG_WARNING = 1,
    LSDN_FPGA_LOG_ERROR = 2,
    LSDN_FPGA_LOG_ASSERT_FAILURE = 3,
} LsdnFpgaLogSeverity;

/* Codificação numérica de estado lógico usada em `LsdnFpgaChangeEntry::value` -- espelha
 * EXATAMENTE a ordem de `enum class lasecsimul::fpga::LogicValue` (LogicValue.hpp), que por sua
 * vez casa com a ordem canônica VHDL ('U','X','0','1','Z','W','L','H','-'). Definida AQUI (não em
 * LogicValue.hpp) porque este header é C puro e é a ÚNICA coisa que o módulo VPI (lasecsimul_vpi.c,
 * compilado por gcc/MinGW, sem acesso a headers C++) enxerga -- LogicValue.hpp delega pra estas
 * funções em vez de duplicar a tabela (duas tabelas independentes seriam um risco real de
 * divergência silenciosa entre o lado Core e o lado VPI). */
#define LSDN_FPGA_LOGIC_U 0
#define LSDN_FPGA_LOGIC_X 1
#define LSDN_FPGA_LOGIC_ZERO 2
#define LSDN_FPGA_LOGIC_ONE 3
#define LSDN_FPGA_LOGIC_Z 4
#define LSDN_FPGA_LOGIC_W 5
#define LSDN_FPGA_LOGIC_L 6
#define LSDN_FPGA_LOGIC_H 7
#define LSDN_FPGA_LOGIC_DONT_CARE 8

static inline char lsdnFpgaLogicValueToChar(uint8_t value) {
    switch (value) {
        case LSDN_FPGA_LOGIC_U: return 'U';
        case LSDN_FPGA_LOGIC_X: return 'X';
        case LSDN_FPGA_LOGIC_ZERO: return '0';
        case LSDN_FPGA_LOGIC_ONE: return '1';
        case LSDN_FPGA_LOGIC_Z: return 'Z';
        case LSDN_FPGA_LOGIC_W: return 'W';
        case LSDN_FPGA_LOGIC_L: return 'L';
        case LSDN_FPGA_LOGIC_H: return 'H';
        case LSDN_FPGA_LOGIC_DONT_CARE: return '-';
        default: return 'X';
    }
}

/* Aceita maiúsculo OU minúsculo (GHDL observado emitindo maiúsculo no Spike 0; vpiBinStrVal
 * padrão do VPI usa minúsculo pra x/z) -- caractere não reconhecido cai em X (fallback seguro,
 * nunca UB), mesma postura de LogicValue::fromChar(). */
static inline uint8_t lsdnFpgaCharToLogicValue(char c) {
    switch (c) {
        case 'U': case 'u': return LSDN_FPGA_LOGIC_U;
        case 'X': case 'x': return LSDN_FPGA_LOGIC_X;
        case '0': return LSDN_FPGA_LOGIC_ZERO;
        case '1': return LSDN_FPGA_LOGIC_ONE;
        case 'Z': case 'z': return LSDN_FPGA_LOGIC_Z;
        case 'W': case 'w': return LSDN_FPGA_LOGIC_W;
        case 'L': case 'l': return LSDN_FPGA_LOGIC_L;
        case 'H': case 'h': return LSDN_FPGA_LOGIC_H;
        case '-': return LSDN_FPGA_LOGIC_DONT_CARE;
        default: return LSDN_FPGA_LOGIC_X;
    }
}

/* `portIndex`/`bitIndex` identificam um bit dentro de um port declarado (bitIndex=0 pra port
 * escalar) -- ver FpgaPortMapper. `value` é a codificação numérica acima (não o caractere VHDL
 * diretamente, embora as duas convertam 1:1 via `lsdnFpgaLogicValueToChar`/
 * `lsdnFpgaCharToLogicValue`). */
typedef struct LsdnFpgaChangeEntry {
    uint32_t portIndex;
    uint32_t bitIndex;
    uint8_t value;
    uint8_t _reserved[3];
} LsdnFpgaChangeEntry;

typedef struct LsdnFpgaLogEntry {
    uint32_t severity; /* LsdnFpgaLogSeverity */
    uint32_t _reserved;
    uint64_t timeNs;
    char message[LSDN_FPGA_ARENA_LOG_MESSAGE_MAX];
} LsdnFpgaLogEntry;

/* Parte de tamanho FIXO do transporte -- os arrays de mudança de entrada/saída vêm DEPOIS deste
 * struct no mapeamento (ver comentário de topo), tamanho dado por
 * `LsdnFpgaArenaDescriptor::inputChangeCapacity`/`outputChangeCapacity`. */
typedef struct LsdnFpgaArenaTransport {
    /* --- Core -> GHDL --- */
    uint64_t commandSeq;       /* Core incrementa a cada novo comando publicado; nunca reseta */
    uint64_t command;          /* LsdnFpgaCommand */
    uint64_t requestedTimeNs;  /* alvo do ADVANCE_TO, no domínio ns do Scheduler (não fs/ps --
                                   ver comentário de topo: o request/reply já é síncrono, uma
                                   unidade interna mais fina não compra nada aqui) */
    uint64_t inputChangeCount; /* quantas entradas de inputChanges[] valem nesta rodada */

    /* --- GHDL -> Core --- */
    uint64_t replySeq;          /* GHDL iguala a commandSeq quando termina de processar o comando
                                    -- Core só considera a rodada pronta quando replySeq==commandSeq */
    uint64_t state;             /* LsdnFpgaState */
    uint64_t reachedTimeNs;     /* TIME_REACHED -- só válido quando replySeq==commandSeq e o
                                    comando era ADVANCE_TO */
    uint64_t outputChangeCount; /* quantas entradas de outputChanges[] valem nesta rodada */
    uint64_t outputOverflow;    /* != 0: GHDL tentou reportar MAIS mudanças do que
                                    outputChangeCapacity permite -- rodada inválida por
                                    construção, Core NUNCA aceita outputChanges[] parcial quando
                                    isto está setado */

    /* --- fila de log/assert/erro (ver comentário de topo) --- */
    uint64_t logWriteIndex; /* GHDL escreve; nunca reseta */
    uint64_t logReadIndex;  /* Core escreve; nunca reseta */
    LsdnFpgaLogEntry logQueue[LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH];
} LsdnFpgaArenaTransport;

typedef struct LsdnFpgaArenaDescriptor {
    uint64_t magic;
    uint32_t abiMajor;
    uint32_t abiMinor;
    uint64_t descriptorSize;
    uint64_t transportSize;
    uint64_t changeEntrySize;
    uint64_t inputChangeCapacity;  /* nº de bits de entrada do componente -- fixado no open() a
                                       partir de FpgaPortMapper, nunca um valor arbitrário */
    uint64_t outputChangeCapacity; /* idem, nº de bits de saída */
    uint64_t logQueueDepth;
    uint64_t coreCapabilities;
    uint64_t ghdlCapabilities;
    uint64_t negotiatedCapabilities;
    uint64_t coreReady;
    uint64_t ghdlReady;
} LsdnFpgaArenaDescriptor;

/* Aritmética de ponteiro pros arrays de tamanho dinâmico logo depois de `LsdnFpgaArenaTransport`
 * no mapeamento (ver comentário de topo) -- `static inline` de propósito, pra ser a ÚNICA fonte
 * de verdade tanto do lado Core (GhdlArenaBridge.cpp, C++) quanto do módulo VPI (lasecsimul_vpi.c,
 * C puro), sem duplicar o cálculo em dois lugares que podiam divergir. `inputCapacity` é o mesmo
 * valor de `LsdnFpgaArenaDescriptor::inputChangeCapacity` desta arena. */
static inline LsdnFpgaChangeEntry* lsdnFpgaArenaInputChanges(LsdnFpgaArenaTransport* transport) {
    return (LsdnFpgaChangeEntry*)((unsigned char*)transport + sizeof(LsdnFpgaArenaTransport));
}

static inline LsdnFpgaChangeEntry* lsdnFpgaArenaOutputChanges(LsdnFpgaArenaTransport* transport,
                                                              uint64_t inputCapacity) {
    return lsdnFpgaArenaInputChanges(transport) + inputCapacity;
}

/* Valores abaixo verificados por compilação real (sizeof direto, não de cabeça) contra gcc/MinGW
 * (mesmo compilador do módulo VPI) durante o Step 2 do plano FPGA -- ver
 * `.claude/plans/golden-puzzling-quasar.md`. */
#if defined(__cplusplus)
static_assert(sizeof(LsdnFpgaChangeEntry) == 12, "FPGA arena change entry ABI changed");
static_assert(sizeof(LsdnFpgaLogEntry) == 272, "FPGA arena log entry ABI changed");
static_assert(sizeof(LsdnFpgaArenaTransport) == 2264, "FPGA arena transport ABI changed");
static_assert(sizeof(LsdnFpgaArenaDescriptor) == 104, "FPGA arena descriptor ABI changed");
#else
_Static_assert(sizeof(LsdnFpgaChangeEntry) == 12, "FPGA arena change entry ABI changed");
_Static_assert(sizeof(LsdnFpgaLogEntry) == 272, "FPGA arena log entry ABI changed");
_Static_assert(sizeof(LsdnFpgaArenaTransport) == 2264, "FPGA arena transport ABI changed");
_Static_assert(sizeof(LsdnFpgaArenaDescriptor) == 104, "FPGA arena descriptor ABI changed");
#endif

#ifdef __cplusplus
}
#endif

#endif /* LASECSIMUL_FPGA_ARENA_ABI_H */
