/*
 * QemuArena ABI v5 — mantém o descritor negociado introduzido na v4 e amplia o payload v3 com
 * o mailbox de burst I2C. O transporte legado até `ps_per_inst` permanece binariamente idêntico;
 * o mailbox foi anexado ao fim do payload e exige recompilação coordenada de Core e QEMU. O mapa é
 * precedido por `LsdnQemuArenaDescriptor`: magic, versão, tamanhos, profundidade da fila,
 * capacidades e handshake Core/QEMU. Isso rejeita um executável incompatível antes de consumir
 * eventos. `LASECSIMUL_QEMU_ARENA_VERSION=3` preserva o mapping v3 puro como rollback.
 *
 * A ABI v3 tem a mesma origem de v2 (espelho de `qemuArena_t` em
 * C:\SourceCode\qemu_lasecSimul\softmmu\simuliface.h, fork QEMU real,
 * github.com/Arcachofo/qemu_simulide), agora estendida com uma fila circular de escritas
 * (PERF-13, docs/33-plano-revisao-arquitetural-core.md, seção 5.3, Alternativa A).
 *
 * v2 usava um único slot pra TODA ação (leitura ou escrita): cada writeReg()/heartbeat do QEMU
 * esperava o Core confirmar a ação anterior antes de publicar a próxima -- um ping-pong completo
 * por acesso a registrador, mesmo pra escritas "dispara e esquece" que não precisavam de resposta
 * nenhuma (medido ao vivo nesta investigação: QEMU 27% ocioso esperando o Core, Core nunca visto
 * esperando o QEMU). v3 desacopla os dois casos:
 *
 *   ESCRITA/HEARTBEAT (SIM_WRITE/SIM_EVENT — "dispara e esquece", nunca esperam valor de volta):
 *   agora publicadas numa fila circular de `LSDN_QEMU_ARENA_QUEUE_DEPTH` entradas. `writeReg()`/
 *   o heartbeat do QEMU só bloqueiam se a fila estiver CHEIA (backpressure natural e explícito,
 *   não mais em toda chamada) -- ver `queueWriteIndex`/`queueReadIndex` abaixo.
 *
 *   LEITURA (SIM_READ): continua EXATAMENTE como v2 -- síncrona, um slot só
 *   (`simuTime`/`regAddr`/`regData`/`qemuAction`), porque uma leitura inerentemente precisa
 *   esperar um valor de volta. A ÚNICA mudança: antes de emitir a leitura, o QEMU agora também
 *   espera a fila de escritas estar COMPLETAMENTE VAZIA (`queueReadIndex == queueWriteIndex`) --
 *   preserva a ordem leitura-depois-de-escrita sem colocar a própria leitura na fila.
 *
 * `queueWriteIndex` (escrito só pelo QEMU) e `queueReadIndex` (escrito só pelo Core) são
 * contadores SEMPRE CRESCENTES, nunca resetam nem dão a volta -- o slot real é
 * `indice % LSDN_QEMU_ARENA_QUEUE_DEPTH`. Fila vazia quando os dois são iguais; cheia quando
 * `queueWriteIndex - queueReadIndex == LSDN_QEMU_ARENA_QUEUE_DEPTH`. Essa escolha (contador
 * crescente, não índice que dá a volta) evita a ambiguidade clássica de fila circular "cheio
 * parece vazio" sem precisar de um campo de contagem à parte.
 *
 * Cada entrada da fila é publicada pelo QEMU escrevendo `regAddr`/`regData`/`simuAction`/
 * `simuTime` da entrada e só DEPOIS incrementando `queueWriteIndex` -- o incremento é o que torna
 * a entrada visível pro Core (mesmo princípio de "confirma por último" que `simuTime != 0` já
 * usava em v2, só que agora por entrada da fila em vez de um campo global). O Core, ao consumir
 * uma entrada (`QemuArenaBridge::acknowledgeWrite()`), só incrementa `queueReadIndex` -- nunca
 * escreve nos campos da entrada.
 *
 * `irqNumber`/`irqLevel`/`qemuTime`/`loop_timeout_ns`/`ps_per_inst`/`running`/`qemuAction`
 * continuam como estado GLOBAL do chip (não por-entrada da fila) -- mesmo papel de v2, campos
 * inalterados.
 *
 * Diferente de v2, ESTA mudança de layout FOI acompanhada de uma recompilação coordenada dos dois
 * lados (o binário vendorizado em devices/qemu-esp32/bin/qemu-system-xtensa.exe é, a partir desta
 * revisão, compilado do fork local C:\SourceCode\qemu_lasecSimul -- não mais uma distribuição
 * oficial externa intocável) -- por isso uma mudança de layout binário foi possível aqui. Mudar de
 * novo exige o mesmo processo: editar simuliface.h no fork, recompilar
 * (build_libqemu-esp32.sh/scripts equivalentes), substituir o binário vendorizado, e só então
 * mudar este header em conjunto.
 */
#ifndef LASECSIMUL_QEMU_ARENA_ABI_H
#define LASECSIMUL_QEMU_ARENA_ABI_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Espelha `enum simuAction` de qemudevice.h/simuliface.h -- SIM_READ/SIM_WRITE são as ações
 * "normais" de acesso a registrador (endereço bruto, decodificado pelo módulo do Core
 * responsável pela faixa de memória -- ver IMcuAdapter::memoryRegions()). SIM_I2C/SPI/USART/TIMER/
 * GPIO_IN existem no header real mas não têm uso confirmado nesta revisão do protocolo (ficam
 * aqui só pra bater 1:1 com o C original -- não inventar valor que o QEMU real não declara). */
typedef enum LsdnSimAction {
    LSDN_SIM_NONE = 0,
    LSDN_SIM_READ = 1,
    LSDN_SIM_WRITE = 2,
    LSDN_SIM_FREQ = 3,
    LSDN_SIM_INTERRUPT = 4,
    LSDN_SIM_I2C = 10,
    LSDN_SIM_SPI = 11,
    LSDN_SIM_USART = 12,
    LSDN_SIM_TIMER = 13,
    LSDN_SIM_GPIO_IN = 14,
    LSDN_SIM_EVENT = 1 << 7
} LsdnSimAction;

/* Ver comentário de topo -- tamanho inicial escolhido dentro da faixa 16-64 sugerida pela
 * revisão arquitetural (docs/33-*.md, seção 5.3); "precisa ser validado por benchmark" antes de
 * considerar definitivo, não é um número medido. */
#define LSDN_QEMU_ARENA_QUEUE_DEPTH 32
#define LSDN_QEMU_ARENA_ABI_MAGIC UINT64_C(0x4c53444e51415235) /* "LSDNQAR5" */
#define LSDN_QEMU_ARENA_ABI_MAJOR 5
/* D2 STAGE 1 (2026-08-29, causal-progress-aware host-health backstop, SHADOW/OBSERVATION ONLY --
 * see coreProgressNs below): minor bump documents the addition. Compatibility is actually
 * enforced by the existing strict descriptorSize/arenaSize/transportSize equality checks (both
 * sides already reject any size mismatch, regardless of how the version number reads), so this
 * bump is self-documentation, not itself the compatibility mechanism. */
#define LSDN_QEMU_ARENA_ABI_MINOR 1

#define LSDN_QEMU_ARENA_CAP_WRITE_QUEUE           (UINT64_C(1) << 0)
#define LSDN_QEMU_ARENA_CAP_ORDERED_EVENTS        (UINT64_C(1) << 1)
#define LSDN_QEMU_ARENA_CAP_SYNC_READ             (UINT64_C(1) << 2)
#define LSDN_QEMU_ARENA_CAP_MTTCG_MPSC_SERIALIZED (UINT64_C(1) << 3)
#define LSDN_QEMU_ARENA_CAP_I2C_BURST              (UINT64_C(1) << 4)
/* D2 STAGE 1: documents that coreProgressNs is present in this build's layout. NOT added to
 * LSDN_QEMU_ARENA_REQUIRED_CAPABILITIES -- Stage 1 is shadow-only, nothing may depend on this bit
 * being negotiated, and gating on it would be a functional (not observational) protocol change. */
#define LSDN_QEMU_ARENA_CAP_CORE_PROGRESS          (UINT64_C(1) << 5)
#define LSDN_QEMU_ARENA_CAPABILITIES                                          \
    (LSDN_QEMU_ARENA_CAP_WRITE_QUEUE | LSDN_QEMU_ARENA_CAP_ORDERED_EVENTS |   \
     LSDN_QEMU_ARENA_CAP_SYNC_READ |                                           \
     LSDN_QEMU_ARENA_CAP_MTTCG_MPSC_SERIALIZED | LSDN_QEMU_ARENA_CAP_I2C_BURST | \
     LSDN_QEMU_ARENA_CAP_CORE_PROGRESS)
#define LSDN_QEMU_ARENA_REQUIRED_CAPABILITIES                                 \
    (LSDN_QEMU_ARENA_CAP_WRITE_QUEUE | LSDN_QEMU_ARENA_CAP_ORDERED_EVENTS |   \
     LSDN_QEMU_ARENA_CAP_SYNC_READ |                                           \
     LSDN_QEMU_ARENA_CAP_MTTCG_MPSC_SERIALIZED | LSDN_QEMU_ARENA_CAP_I2C_BURST)

/* Layout EXATO de qemuQueueEntry_t (simuliface.h) -- não reordenar, não inserir campo. */
typedef struct LsdnQemuQueueEntry {
    uint64_t regAddr;
    uint64_t regData;
    uint64_t simuAction; /* LsdnSimAction -- só SIM_WRITE/SIM_EVENT usados nesta revisão */
    uint64_t simuTime;   /* ps -- timestamp virtual de quando o QEMU publicou esta entrada */
} LsdnQemuQueueEntry;

/* Layout EXATO de qemuArena_t -- não reordenar, não inserir campo, não mudar tipo de campo. */
typedef struct LsdnQemuArena {
    uint64_t queueWriteIndex;                          /* QEMU escreve; nunca reseta */
    uint64_t queueReadIndex;                           /* Core escreve; nunca reseta */
    LsdnQemuQueueEntry queue[LSDN_QEMU_ARENA_QUEUE_DEPTH];

    uint64_t simuTime;        /* ps -- só SIM_READ agora (ver comentário de topo) */
    uint64_t qemuTime;        /* ps — escrito pelo QEMU */
    uint64_t regData;         /* Core->QEMU em leitura */
    uint64_t regAddr;         /* endereço do registrador lido */
    uint64_t irqNumber;       /* != 0: Core quer que o QEMU injete esta IRQ */
    uint64_t irqLevel;        /* nível da IRQ acima (0/1) */
    uint64_t simuAction;      /* QEMU->Core: sempre LSDN_SIM_READ agora */
    uint64_t qemuAction;      /* Core->QEMU: confirmação de SIM_READ concluído */
    uint64_t running;         /* QEMU seta 1 quando o processo terminou de inicializar */
    int64_t  loop_timeout_ns; /* ajustado pelo Core conforme a frequência de clock do chip */
    double   ps_per_inst;

    /* ABI 5: mailbox I2C de um produtor/um consumidor. O QEMU publica todos os campos e por
     * último i2cRequestSeq; o Core responde e por último publica i2cResponseSeq. */
    uint64_t i2cRequestSeq;
    uint64_t i2cResponseSeq;
    uint64_t i2cTimePs;
    uint32_t i2cBus;
    uint32_t i2cFlags;       /* bit0 START, bit1 STOP, bit2 READ */
    uint64_t i2cPeriodNs;
    uint32_t i2cTxLen;
    uint32_t i2cRxLen;
    uint8_t  i2cTx[64];   /* tx[0] = endereço+RW; suporta metadado + FIFO ESP32 de 32 bytes */
    uint8_t  i2cRx[32];
    uint32_t i2cStatus;      /* bit0 handled, bit1 address ACK */
    uint32_t i2cFirstNack;   /* UINT32_MAX quando todos os payloads deram ACK */
    uint64_t i2cStretchNs;

    /* D2 STAGE 1 (2026-08-29, SHADOW/OBSERVATION ONLY -- does not affect
     * waitForSynch()'s real 3000ms host-health timeout decision in this stage). Formal semantic:
     * the latest Scheduler::nowNs() value Core has observed and published, in nanoseconds.
     * Producer = Core (release store); consumer = QEMU (acquire load). Zeroed unconditionally by
     * the EXISTING QemuArenaBridge::open() memset() on every fresh execution (no new reset logic
     * needed) -- 0 means "no valid publication observed yet this execution" and must not be
     * treated as a real causal position; Core publishes max(nowNs, 1) specifically so a
     * legitimately-near-zero Scheduler position is never confused with the sentinel. Published
     * from McuComponent::pollStepLocked()'s already-existing arena-observation point -- no new
     * timer, no new thread, no per-Scheduler-iteration write. */
    uint64_t coreProgressNs;
} LsdnQemuArena;

typedef struct LsdnQemuArenaDescriptor {
    uint64_t magic;
    uint32_t abiMajor;
    uint32_t abiMinor;
    uint64_t descriptorSize;
    uint64_t arenaSize;
    uint64_t transportSize;
    uint64_t queueDepth;
    uint64_t coreCapabilities;
    uint64_t qemuCapabilities;
    uint64_t negotiatedCapabilities;
    uint64_t coreReady;
    uint64_t qemuReady;
} LsdnQemuArenaDescriptor;

typedef struct LsdnQemuArenaV5Mapping {
    LsdnQemuArenaDescriptor descriptor;
    LsdnQemuArena transport;
} LsdnQemuArenaV5Mapping;

#if defined(__cplusplus)
static_assert(sizeof(LsdnQemuQueueEntry) == 32,
              "QEMU arena queue entry ABI changed");
static_assert(sizeof(LsdnQemuArena) == 1296,
              "QEMU arena v5 payload ABI changed");
static_assert(sizeof(LsdnQemuArenaDescriptor) == 88,
              "QEMU arena descriptor ABI changed");
static_assert(sizeof(LsdnQemuArenaV5Mapping) == 1384,
              "QEMU arena v5 mapping ABI changed");
#else
_Static_assert(sizeof(LsdnQemuQueueEntry) == 32,
               "QEMU arena queue entry ABI changed");
_Static_assert(sizeof(LsdnQemuArena) == 1296,
               "QEMU arena v5 payload ABI changed");
_Static_assert(sizeof(LsdnQemuArenaDescriptor) == 88,
               "QEMU arena descriptor ABI changed");
_Static_assert(sizeof(LsdnQemuArenaV5Mapping) == 1384,
               "QEMU arena v5 mapping ABI changed");
#endif

#ifdef __cplusplus
}
#endif

#endif /* LASECSIMUL_QEMU_ARENA_ABI_H */
