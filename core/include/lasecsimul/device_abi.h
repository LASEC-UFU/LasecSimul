/*
 * ABI publica de dispositivos nativos do LasecSimul (DLL/SO).
 * Fronteira 100% C: extern "C", calling convention da plataforma, structs só com tipos POD de
 * tamanho fixo. Nenhum tipo C++ (STL, excecoes, RTTI) pode cruzar esta fronteira.
 *
 * Regras de ownership e thread-affinity (obrigatorias, valem para toda funcao desta ABI):
 *  - Buffers de saida (get_state) sao SEMPRE pre-alocados por quem le; quem escreve nunca realoca
 *    nem libera o buffer do chamador.
 *  - Ponteiros recebidos como parametro (const char*, const uint8_t*) só sao validos durante a
 *    chamada — copie antes de retornar se precisar retê-los depois.
 *  - Strings retornadas por valor (ex: em LsdnQemuLaunchSpec) devem apontar para memoria estatica
 *    ou de vida igual a instancia — nunca para um buffer de pilha que ja saiu de escopo.
 *  - Toda funcao de LsdnHostApi só pode ser chamada de dentro de uma chamada da vtable que o
 *    HOST iniciou (stamp/post_step/on_event/...), na mesma thread em que o host fez essa chamada.
 *    Trabalho em background usa submit_task — nunca chame LsdnHostApi de uma thread propria do
 *    plugin concorrentemente com uma chamada do host para a mesma instancia.
 *
 * Por que esta ABI NAO usa o protocolo de ping-pong por memoria compartilhada de qemu_arena_abi.h:
 * aquele existe pra evitar syscall ENTRE PROCESSOS. Plugin roda no mesmo processo do Core —
 * vtable->stamp() ja e' uma chamada de funcao direta, mais barata que qualquer espera ativa em
 * memoria compartilhada, sem fronteira de processo a economizar. Avaliado e descartado
 * deliberadamente, nao esquecido — ver .spec/lasecsimul.spec, secao 8.1.
 *
 * Ver .spec/lasecsimul-native-devices.spec, secoes 4-9, para a especificacao completa.
 */
#ifndef LASECSIMUL_DEVICE_ABI_H
#define LASECSIMUL_DEVICE_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LSDN_ABI_VERSION_MAJOR 3
#define LSDN_ABI_VERSION_MINOR 0
/* O PluginLoader só checa MAJOR (minor é só informativo) -- sem plugin de terceiro nem
 * preocupação de compat aqui, todo device deste repo recompila a cada mudança de ABI via `npm run
 * build:devices`. Bump major sempre que mudar layout/semântica de algo em LsdnHostApi/
 * LsdnMatrixView/LsdnEventTag; nunca manter duas formas de fazer a mesma coisa (ver
 * .spec/lasecsimul-native-devices.spec, seção 4 e 8 -- histórico de major 1/2 removido daqui,
 * git log é o changelog). Major 3: `pin_write`/`pin_write_analog`/`pin_read`/`now_ns`/
 * `schedule_event` deixaram de ser stubs vazios; `pin_watch` saiu (redundante -- todo pino já
 * recebe LSDN_EVT_PIN_CHANGE automaticamente, sem precisar de registro prévio); entrou `pin_name`. */

#if defined(_WIN32)
  #define LSDN_EXPORT __declspec(dllexport)
#else
  #define LSDN_EXPORT __attribute__((visibility("default")))
#endif

/* Opaco: só o plugin sabe o que existe dentro de uma instancia. */
typedef struct LsdnDevice LsdnDevice;

typedef enum LsdnPinKind {
    LSDN_PIN_DIGITAL_IN = 0,
    LSDN_PIN_DIGITAL_OUT = 1,
    LSDN_PIN_DIGITAL_BIDIR = 2,
    LSDN_PIN_ANALOG_IN = 3,
    LSDN_PIN_ANALOG_OUT = 4,
    LSDN_PIN_PWM_OUT = 5,
    LSDN_PIN_POWER = 6
} LsdnPinKind;

typedef enum LsdnEventTag {
    LSDN_EVT_PIN_CHANGE = 1, /* a=índice local do pino, b=novo nível (0/1), c=ns desde a última borda NESTE pino */
    LSDN_EVT_TIMER = 2
} LsdnEventTag;

typedef struct LsdnEvent {
    uint32_t tag; /* LsdnEventTag */
    uint32_t a;
    uint32_t b;
    uint32_t c;
} LsdnEvent;

typedef enum LsdnPropertyKind {
    LSDN_PROPERTY_NUMBER = 0,
    LSDN_PROPERTY_STRING = 1,
    LSDN_PROPERTY_BOOL = 2,
    LSDN_PROPERTY_POINT = 3
} LsdnPropertyKind;

typedef struct LsdnPropertyPoint {
    double x;
    double y;
} LsdnPropertyPoint;

typedef struct LsdnPropertyValue {
    uint32_t kind; /* LsdnPropertyKind */
    double number_value;
    int32_t bool_value;
    const char* string_value;
    LsdnPropertyPoint point_value;
} LsdnPropertyValue;

/* Visao direta da matriz MNA do Core — sem copia, sem fila.
 *
 * `add_conductance_to_ground`/`add_current_to_ground`: fonte de 1 terminal referenciada à terra
 * global do circuito (sem precisar de um segundo pino do próprio device) -- equivalente direto de
 * `IComponentModel::addConductanceToGround`/`addCurrentToGround` do lado C++. */
typedef struct LsdnMatrixView {
    void* opaque;
    void (*add_conductance)(void* opaque, uint32_t pinA, uint32_t pinB, double siemens);
    void (*add_voltage_source)(void* opaque, uint32_t pinA, uint32_t pinB, double volts);
    double (*get_node_voltage)(void* opaque, uint32_t pin);
    void (*add_conductance_to_ground)(void* opaque, uint32_t pin, double siemens);
    void (*add_current_to_ground)(void* opaque, uint32_t pin, double amperes);
} LsdnMatrixView;

/* Funcoes que o Core oferece ao dispositivo. Nao e uma fronteira de seguranca (ver spec, secao 6) —
 * o binario do plugin tem os mesmos privilegios do processo Core.
 *
 * `pin_write`/`pin_write_analog`: jeito ERGONÔMICO de dirigir o próprio pino sem montar a stamp na
 * mão -- o host aplica isso na matriz como uma fonte de baixa impedância (conductance_to_ground +
 * current_to_ground) na PRÓXIMA stamp() deste device, current() somam com o que o device também
 * stampar direto via LsdnMatrixView. Pra open-drain/ACK/tri-state real (só puxar quando quiser, e
 * NÃO contribuir nada quando não quiser -- deixando outro driver/pull-up decidir o nó) continua
 * sendo stamp() direto via LsdnMatrixView, igual sempre foi -- pin_write é só o caso comum "eu sou
 * o único dono deste pino".
 * `pin_read`: tensão do próprio pino na ÚLTIMA stamp() (cache, nunca dispara solve novo), como
 * nível digital (0/1) -- pra ler fora de stamp() (post_step/on_event).
 * `now_ns`/`schedule_event`: tempo de simulação e timer (LSDN_EVT_TIMER) independente de borda de
 * pino -- mesmo papel do `Scheduler::scheduleEvent` que Clock/WaveGen built-in já usam.
 * `pin_name`: nome do pino (mesma ordem/index de `.lsdevice` `pins[]`) -- pra device validar a
 * própria ordem esperada no init() em vez de confiar em índice hardcoded silenciosamente.
 *
 * ATENÇÃO de sequenciamento: `pin_write`/`pin_write_analog`/`schedule_event`/`now_ns` exigem o
 * componentIndex do device, que só é conhecido DEPOIS de init() retornar (o host liga isso entre
 * init() e a primeira stamp()) -- chamar qualquer uma destas 4 de dentro de init() é NO-OP
 * silencioso. Se o device precisa se auto-agendar (ex: piscar), faça isso na PRIMEIRA stamp() (com
 * uma flag "já agendei" no estado do device), nunca em init() -- ver
 * devices/example-blinker/src/lib.c. */
typedef struct LsdnHostApi {
    uint32_t    (*pin_declare)(void* host_ctx, uint32_t index, LsdnPinKind kind, const char* name);
    void        (*pin_write)(void* host_ctx, uint32_t pin, int32_t level);
    void        (*pin_write_analog)(void* host_ctx, uint32_t pin, float volts);
    int32_t     (*pin_read)(void* host_ctx, uint32_t pin);
    const char* (*pin_name)(void* host_ctx, uint32_t index);

    void     (*schedule_event)(void* host_ctx, uint64_t delay_ns, uint32_t event_id);
    uint32_t (*config_get)(void* host_ctx, const char* name, LsdnPropertyValue* out_value);
    uint64_t (*now_ns)(void* host_ctx);
    void     (*log)(void* host_ctx, int32_t level, const char* msg);

    /* Plugins bem-comportados submetem trabalho aqui em vez de criar threads nao supervisionadas. */
    void     (*submit_task)(void* host_ctx, void (*fn)(void* arg), void* arg);
} LsdnHostApi;

/* As 8 funcoes obrigatorias do dispositivo — nenhuma outra e necessaria (ver spec, secao 5). */
typedef struct LsdnDeviceVTable {
    LsdnDevice* (*create)(void* host_ctx, const LsdnHostApi* host_api);
    void        (*init)(LsdnDevice* dev);
    void        (*stamp)(LsdnDevice* dev, LsdnMatrixView* matrix);
    void        (*post_step)(LsdnDevice* dev, uint64_t time_ns);
    void        (*on_event)(LsdnDevice* dev, const LsdnEvent* ev);
    uint32_t    (*get_property)(LsdnDevice* dev, const char* name, LsdnPropertyValue* out_value);
    uint32_t    (*set_property)(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value);
    uint32_t    (*get_state)(LsdnDevice* dev, uint8_t* out, uint32_t cap);
    void        (*set_state)(LsdnDevice* dev, const uint8_t* in, uint32_t len);
    void        (*destroy)(LsdnDevice* dev);
} LsdnDeviceVTable;

/* Unico simbolo exportado por um plugin de dispositivo. */
typedef const LsdnDeviceVTable* (*LsdnGetVTableFn)(uint32_t* abi_major, uint32_t* abi_minor);

#ifdef __cplusplus
}
#endif

#endif /* LASECSIMUL_DEVICE_ABI_H */
