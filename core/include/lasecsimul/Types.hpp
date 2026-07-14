#pragma once

#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace lasecsimul {

struct Pin {
    std::string id;
    double x = 0.0;
    double y = 0.0;
};

struct PropertyPoint {
    double x = 0.0;
    double y = 0.0;
};

/** Valor de uma propriedade editável de componente — compartilhado entre `ComponentParams`
 * (criação) e `PropertyDescriptor` (edição em runtime, ver IComponentModel.hpp), pra não ter dois
 * tipos de valor de propriedade no projeto. */
using PropertyValue = std::variant<double, std::string, bool, PropertyPoint>;

enum class PropertyValueKind : uint32_t { Number = 0, String = 1, Bool = 2, Point = 3 };

struct PropertyOption {
    std::string value;
    std::string label;
};

enum PropertySchemaFlags : uint32_t {
    PropertySchemaNone = 0,
    PropertySchemaHidden = 1u << 0,
    PropertySchemaReadOnly = 1u << 1,
    PropertySchemaNoCopy = 1u << 2,
    PropertySchemaAffectsTopology = 1u << 3,
    PropertySchemaRequiresRestart = 1u << 4,
    PropertySchemaShowOnSymbol = 1u << 5,
    /** Editar esta propriedade muda o NÚMERO de pinos do componente (não só a fiação) -- ver
     * `ComponentPinSpec`/`resolveDynamicPins` abaixo. Implica `AffectsTopology` na prática
     * (`SimulationSession::setProperty` trata os dois como o mesmo evento de rebuild), mas é um bit
     * separado porque só ESTE dispara `Netlist::reregisterComponentPins` -- uma propriedade com só
     * `AffectsTopology` (ex: `poles` de um switch) nunca muda a contagem, só a fiação entre pinos
     * que já existem. */
    PropertySchemaAffectsPinCount = 1u << 6,
};

struct PropertySchema {
    std::string id;
    std::string label;
    std::string group;
    std::string unit;
    PropertyValueKind valueKind = PropertyValueKind::String;
    std::string editor = "text";
    PropertyValue defaultValue = std::string{};
    std::optional<double> minValue;
    std::optional<double> maxValue;
    std::optional<double> step;
    std::vector<PropertyOption> options;
    uint32_t flags = PropertySchemaNone;
};

/** Como o NÚMERO de pinos de um grupo dinâmico é derivado do valor bruto de uma propriedade --
 * `Value` é a leitura direta (ex: `rows` -> N linhas); `Log2Ceil` é pra dispositivos cuja contagem
 * de endereço cresce logaritmicamente com a contagem de itens (ex: `active.analog_mux`: N canais
 * precisa de ceil(log2(N)) linhas de endereço, ver `mux_analog.cpp` real do SimulIDE). Vocabulário
 * fechado de propósito -- adicionar um modo novo é preferível a um device calcular a própria
 * contagem fora deste mecanismo (ver `ComponentPinSpec`). */
enum class DynamicPinCountFn : uint32_t { Value = 0, Log2Ceil = 1 };

/** Um grupo de N pinos cuja contagem vem de UMA propriedade numérica da instância -- equivalente,
 * do lado Core/elétrico, ao `PackageDynamicPinGroup` que a Extension já usa pro desenho
 * (`ui/webview/model.ts`). Os dois são formatos INDEPENDENTES (Core nunca lê `package`/JSON de
 * desenho, ver `.skill/lasecsimul.skill`) que devem chegar ao MESMO conjunto de ids pro mesmo
 * device -- combinação verificada por teste, não pelo tipo. */
struct DynamicPinGroupSpec {
    std::string idPrefix = "pin-";
    std::string countProperty;
    DynamicPinCountFn countFn = DynamicPinCountFn::Value;
};

/** Declaração completa de como o `pins()` de um componente é derivado das propriedades da
 * instância -- dado, não código: nenhum device (built-in ou plugin) escreve uma fórmula própria,
 * só declara `fixedPinIds` (sempre presentes, nesta ordem) + `dynamicGroups` (anexados depois, na
 * ordem declarada, ids sequenciais cruzando todos os grupos). Ver `resolveDynamicPins`. */
struct ComponentPinSpec {
    std::vector<std::string> fixedPinIds;
    std::vector<DynamicPinGroupSpec> dynamicGroups;
};

/** Único intérprete de `ComponentPinSpec` do projeto inteiro -- usado por `SimulidePassiveState`
 * (built-ins) e pelo bridge de plugin nativo (`NativeDeviceProxy`/`PluginRuntime`), nunca
 * duplicado. `properties` ausente/sem a chave de um grupo conta como 0 (grupo vazio, não erro --
 * mesmo comportamento default-seguro do lado Extension em `materializePinGroup`). */
inline std::vector<Pin> resolveDynamicPins(const ComponentPinSpec& spec,
                                           const std::unordered_map<std::string, PropertyValue>& properties) {
    std::vector<Pin> pins;
    pins.reserve(spec.fixedPinIds.size());
    for (const std::string& id : spec.fixedPinIds) pins.push_back(Pin{id, 0.0, 0.0});

    const auto propertyNumber = [&properties](const std::string& name) -> double {
        const auto it = properties.find(name);
        if (it == properties.end()) return 0.0;
        if (const double* value = std::get_if<double>(&it->second)) return *value;
        return 0.0;
    };

    for (const DynamicPinGroupSpec& group : spec.dynamicGroups) {
        const double raw = propertyNumber(group.countProperty);
        size_t count = 0;
        if (group.countFn == DynamicPinCountFn::Log2Ceil) {
            count = raw > 1.0 ? static_cast<size_t>(std::ceil(std::log2(raw))) : 0;
        } else {
            count = raw > 0.0 ? static_cast<size_t>(raw) : 0;
        }
        for (size_t i = 0; i < count; ++i) {
            pins.push_back(Pin{group.idPrefix + std::to_string(pins.size() + 1), 0.0, 0.0});
        }
    }
    return pins;
}

/** Como a UI deve interpretar os bytes de leitura de um componente (`getComponentState`/instrumento)
 * sem precisar conhecer o typeId -- ABI v2, ver .spec/lasecsimul-native-devices.spec. Declarado pelo
 * device (built-in: método estático; plugin/DLL: chave `"readout"` opcional em `.lsdevice`), nunca
 * inferido por typeId em nenhum lado (Core ou Extension). Ausência (`std::optional` em
 * `ComponentMetadata`) é uma declaração válida de "sem leitura estruturada" -- a maioria dos
 * componentes (resistores, fios, etc.) não tem mostrador, isso não é um estado "não migrado". */
enum class ReadoutKind : uint32_t {
    Scalar = 0,         // 1 double (ex: amperímetro, frequencímetro, sonda) -- `unit` descreve a grandeza
    ChannelHistory = 1, // N séries temporais independentes de double, channel-major (ex: osciloscópio:
                        // canal 0 inteiro, depois canal 1, ...) -- `channels` = N
    BitmaskHistory = 2, // 1 série temporal de {timestamp, bitmask uint32}, cada amostra captura todos
                        // os canais digitais de uma vez (ex: analisador lógico) -- `channels` = nº de
                        // bits válidos do bitmask
    VectorHistory = 3,
};

struct ReadoutFormat {
    ReadoutKind kind = ReadoutKind::Scalar;
    std::string unit;       // usado quando kind == Scalar (ex: "V", "A", "Hz")
    uint32_t channels = 0;  // usado quando kind == ChannelHistory ou BitmaskHistory
};

/** Como a UI deve tratar a interação de clique/arrasto com o componente, sem precisar checar typeId
 * (ex: push é momentâneo -- solta ao soltar o botão -- enquanto switch/relay são toggle). Mesma
 * convenção de declaração de `ReadoutFormat` acima -- ABI v2. */
enum class InteractionKind : uint32_t { None = 0, Momentary = 1, Toggle = 2 };

enum class BusRole { Master, Slave };

/** Saúde operacional de uma instância de componente (watchdog/crash-guard de plugin nativo) -- só
 * plugins têm motivo real de reportar algo diferente de `Ok`; built-ins nunca falham nem atrasam
 * por natureza, então a interface devolve `Ok` por default. Ver
 * .spec/lasecsimul-native-devices.spec, seção 13. */
enum class PluginHealthStatus { Ok, Lagging, Faulted };

/** Periférico genérico do Core que interpreta uma faixa de endereço MMIO de um MCU emulado.
 * Categoria do periférico que uma faixa MMIO/PinMapping pertence -- usado só pra achar qual
 * `QemuModule` concreto (ex: Esp32GpioModule) é dono de um endereço; NÃO implica que exista um
 * único "GpioModule genérico" universal -- cada chip tem sua própria subclasse com seu próprio
 * mapa de registradores (ver QemuModule.hpp/IMcuAdapter.hpp). */
/** `Reset` é tratado especialmente por `McuComponent::stamp()` -- nunca tem `QemuModule` próprio
 * (não existe registrador por trás, é uma linha de controle de hardware: ESP32 chama de EN). Ver
 * .spec/lasecsimul-native-devices.spec seção 8.1. */
enum class ModuleKind { Gpio, IoMux, I2c, Spi, Usart, Timer, Reset };

/** Faixa de endereco MMIO do chip -> qual QemuModule concreto deve trata-la.
 * Declarado pelo IMcuAdapter; nunca calculado pelo Core. */
struct MemoryRegion {
    uint64_t start = 0;
    uint64_t end = 0;
    ModuleKind moduleKind;
    uint32_t moduleIndex = 0;
};

/** Um bit/linha de um periférico (tipicamente GPIO) mapeado para um pino físico do circuito. */
struct PinMapping {
    std::string pinId;
    ModuleKind moduleKind;
    uint32_t moduleIndex = 0;
    uint32_t bitOrLine = 0;
};

struct QemuLaunchSpec {
    std::string binary;
    std::vector<std::string> args;
};

struct McuDebugOptions {
    uint16_t gdbPort = 0;
    bool startPaused = true;
    bool enabled() const { return gdbPort != 0; }
};

struct ComponentMeta {
    std::string typeId;
    std::vector<Pin> pins;
    std::vector<PropertySchema> propertySchema;
    /** `limits.stepTimeoutMs` do `.lsdevice` -- 0 == sem watchdog (chamada roda sem limite de
     * tempo, comportamento de hoje). Ver .spec/lasecsimul-native-devices.spec, seção 13. */
    uint32_t stepTimeoutMs = 0;
    /** `pinSpec` opcional do `.lsdevice` -- caminho declarativo pra pino dinâmico de plugin, SEM
     * escrever `pin_declare` na unha em C. Quando presente, `PluginRuntime::createDeviceInstance`
     * usa `resolveDynamicPins` (não `pins` acima, que vira só fallback pra manifesto sem `pinSpec`)
     * pra semear `declaredPins`, e `NativeDeviceProxy` recomputa a cada propriedade
     * `AffectsPinCount` editada -- mesmo mecanismo/vocabulário dos built-ins (`switches.keypad` e
     * companhia, `CoreApplication.cpp`), nunca duplicado. Um plugin ainda PODE chamar `pin_declare`
     * na mão (escotilha de escape pra formas que não cabem no vocabulário `ComponentPinSpec`) --
     * os dois caminhos escrevem no mesmo `declaredPins`, nunca coexistem simultaneamente pro mesmo
     * device (`pinSpec` presente = plugin não deveria chamar `pin_declare`, mas nada TÉCNICO
     * impede; a última escrita vence, como qualquer outra mutação). */
    std::optional<ComponentPinSpec> pinSpec;
};

struct ComponentEvent {
    uint32_t tag = 0;
    uint32_t a = 0;
    uint32_t b = 0;
    uint32_t c = 0;
};

/** Tag de evento "pino digital mudou de nível" — `a` = índice local do pino (posição em
 * `IComponentModel::pins()`/ordem de declaração, igual ao índice usado pela ABI de plugins), `b` =
 * novo nível (0/1), `c` = ns desde a última transição NESTE nó (saturado em UINT32_MAX, suficiente
 * pra qualquer protocolo de timing por largura de pulso, ex: WS2812). É a ÚNICA forma pela qual o
 * Core notifica um componente (built-in ou plugin) de que um pino seu mudou de nível — ver
 * `SimulationSession::settleStep()`. Valor fixado em 1 pra bater com `LSDN_EVT_PIN_CHANGE` em
 * device_abi.h (`ComponentEvent` não inclui esse header de propósito: é usado por built-ins
 * também, que não cruzam a fronteira de ABI C). */
inline constexpr uint32_t kPinChangeEventTag = 1;

/** Tag de evento "timer agendado disparou" -- `a` = event_id pedido em `schedule_event` (ver
 * device_abi.h LsdnHostApi/PluginRuntime.cpp hostScheduleEvent). Valor fixado em 2 pra bater com
 * `LSDN_EVT_TIMER`, mesmo motivo de kPinChangeEventTag não incluir device_abi.h. */
inline constexpr uint32_t kTimerEventTag = 2;

/** Limiar de tensão pra decidir nível lógico (alto/baixo) em qualquer ponto do Core que precise
 * disso pra fins de protocolo/evento -- detecção de borda (SimulationSession::settleStep()),
 * `pin_read` de plugin (NativeDeviceProxy/PluginRuntime hostPinRead). MESMO valor em todo lugar de
 * propósito: nunca dois limiares diferentes pro mesmo conceito de "nível digital" (não confundir
 * com o threshold CONFIGURÁVEL por instância do LogicAnalyzer, que é uma leitura de instrumento,
 * não uma decisão estrutural do engine). */
inline constexpr double kDigitalLevelThreshold = 2.5;

} // namespace lasecsimul
