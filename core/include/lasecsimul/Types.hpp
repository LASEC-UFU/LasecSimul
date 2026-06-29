#pragma once

#include <cstdint>
#include <optional>
#include <string>
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

struct ComponentMeta {
    std::string typeId;
    std::vector<Pin> pins;
    std::vector<PropertySchema> propertySchema;
    /** `limits.stepTimeoutMs` do `device.json` -- 0 == sem watchdog (chamada roda sem limite de
     * tempo, comportamento de hoje). Ver .spec/lasecsimul-native-devices.spec, seção 13. */
    uint32_t stepTimeoutMs = 0;
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
