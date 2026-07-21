/*
 * QemuArena ABI v3 — mesma origem de v2 (espelho de `qemuArena_t` em
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
} LsdnQemuArena;

#ifdef __cplusplus
}
#endif

#endif /* LASECSIMUL_QEMU_ARENA_ABI_H */
