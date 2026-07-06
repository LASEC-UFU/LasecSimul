#include "CoreApplication.hpp"
#include "../ipc/IpcServer.hpp"
#include "../ipc/Protocol.hpp"
#include "../plugins/GlobalPluginCache.hpp"
#include "../registry/SubcircuitRegistry.hpp"
#include "../session/SimulationSession.hpp"
#include "../components/SimulideBuiltins.hpp"
#include "../components/active/Diode.hpp"
#include "../components/meters/Ampmeter.hpp"
#include "../components/meters/Voltmeter.hpp"
#include "../components/meters/FreqMeter.hpp"
#include "../components/meters/LogicAnalyzer.hpp"
#include "../components/meters/Oscope.hpp"
#include "../components/meters/Probe.hpp"
#include "../components/sources/Battery.hpp"
#include "../components/sources/Clock.hpp"
#include "../components/sources/Csource.hpp"
#include "../components/sources/CurrSource.hpp"
#include "../components/sources/FixedVolt.hpp"
#include "../components/sources/Rail.hpp"
#include "../components/sources/VoltSource.hpp"
#include "../components/sources/WaveGen.hpp"
#include "../components/connectors/Tunnel.hpp"
#include "../components/connectors/Junction.hpp"
#include "../components/logic/Button.hpp"
#include "../components/other/Ground.hpp"
#include "../components/passive/Capacitor.hpp"
#include "../components/passive/Inductor.hpp"
#include "../components/passive/Resistor.hpp"
#include "../components/sources/DcVoltageSource.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <unordered_set>

namespace lasecsimul::app {

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;
using namespace lasecsimul::ipc;

// ── impl ───────────────────────────────────────────────────────────────────────

struct CoreApplication::Impl {
    CoreConfig config;
    GlobalPluginCache pluginCache;
    SimulationSession session;
    IpcServer ipcServer;

    explicit Impl(CoreConfig cfg)
        : config(std::move(cfg))
        , session(pluginCache)
        , ipcServer(config.pipeName) {}
};

// ── componentes built-in ───────────────────────────────────────────────────────

namespace {

/** Registra a factory (`reg`) E a metadata estática (`metadata` — `ComponentMetadataRegistry`, a
 * mesma usada por plugins via `loadDeviceLibraryFile`) de um typeId num só lugar, pra nunca ficar
 * uma sem a outra. `pins` vazio é seguro pra built-in: nenhum handler IPC lê `ComponentMetadata::pins`
 * hoje, só a Webview decide layout de pino (`componentSymbols.ts`). */
Pin makePinOr(const Pin& source, const char* fallbackId) {
    Pin pin = source;
    if (pin.id.empty()) pin.id = fallbackId;
    return pin;
}

std::array<Pin, 2> makePins2(const ComponentParams& p, const char* a = "pin-1", const char* b = "pin-2") {
    const auto pos = p.pins<2>();
    return {makePinOr(pos[0], a), makePinOr(pos[1], b)};
}

std::array<Pin, 3> makePins3(const ComponentParams& p, const char* a = "pin-1", const char* b = "pin-2",
                             const char* c = "pin-3") {
    const auto pos = p.pins<3>();
    return {makePinOr(pos[0], a), makePinOr(pos[1], b), makePinOr(pos[2], c)};
}

std::vector<Pin> makePinVector(const ComponentParams& p, size_t count) {
    std::vector<Pin> pins;
    pins.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        Pin pin = i < p.pinList.size() ? p.pinList[i] : Pin{};
        if (pin.id.empty()) pin.id = "pin-" + std::to_string(i + 1);
        pins.push_back(std::move(pin));
    }
    return pins;
}

void registerBuiltinComponents(ComponentRegistry& reg, registry::ComponentMetadataRegistry& metadata,
                                simulation::Scheduler& scheduler) {
    const auto registerBuiltinMetadata =
        [&metadata](std::string typeId,
                    std::string displayName,
                    std::vector<PropertySchema> propertySchema,
                    std::string translationsJson,
                    std::optional<ReadoutFormat> readoutFormat = std::nullopt,
                    std::optional<InteractionKind> interactionKind = std::nullopt) {
            registry::ComponentMetadata meta;
            meta.typeId = std::move(typeId);
            meta.displayName = std::move(displayName);
            meta.propertySchema = std::move(propertySchema);
            meta.language = "pt-BR";
            meta.translationsJson = std::move(translationsJson);
            meta.readoutFormat = std::move(readoutFormat);
            meta.interactionKind = std::move(interactionKind);
            metadata.registerMetadata(std::move(meta));
        };
    reg.registerFactory("passive.resistor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("resistance", 1000.0));
    });
    registerBuiltinMetadata(
        "passive.resistor",
        "Resistor",
        components::Resistor::propertySchema(),
        R"json({"en":{"name":"Resistor","properties":{"resistance":{"label":"Resistance","group":"Electrical"}}}})json");

    reg.registerFactory("passive.capacitor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Capacitor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("capacitance", 1e-6));
    });
    registerBuiltinMetadata(
        "passive.capacitor",
        "Capacitor",
        components::Capacitor::propertySchema(),
        R"json({"en":{"name":"Capacitor","properties":{"capacitance":{"label":"Capacitance","group":"Electrical"}}}})json");

    reg.registerFactory("passive.inductor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Inductor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("inductance", 1e-3));
    });
    registerBuiltinMetadata(
        "passive.inductor",
        "Indutor",
        components::Inductor::propertySchema(),
        R"json({"en":{"name":"Inductor","properties":{"inductance":{"label":"Inductance","group":"Electrical"}}}})json");

    reg.registerFactory("connectors.tunnel", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Tunnel>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    registerBuiltinMetadata(
        "connectors.tunnel",
        "Túnel",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Tunnel"}})json");

    reg.registerFactory("connectors.junction", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Junction>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    registerBuiltinMetadata(
        "connectors.junction",
        "Junção",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Junction"}})json");

    reg.registerFactory("connectors.bus", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Junction>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    registerBuiltinMetadata(
        "connectors.bus",
        "Barramento",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Bus"}})json");

    reg.registerFactory("connectors.socket", [](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("connectors.socket", makePinVector(p, 8),
                                                                  std::vector<PropertySchema>{});
    });
    registerBuiltinMetadata(
        "connectors.socket",
        "Soquete",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Socket"}})json");

    reg.registerFactory("connectors.header", [](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("connectors.header", makePinVector(p, 8),
                                                                  std::vector<PropertySchema>{});
    });
    registerBuiltinMetadata(
        "connectors.header",
        "Cabecalho",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Header"}})json");

    reg.registerFactory("other.ground", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Ground>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    registerBuiltinMetadata(
        "other.ground",
        "Terra (0 V)",
        std::vector<PropertySchema>{},
        R"json({"en":{"name":"Ground (0 V)"}})json");

    reg.registerFactory("sources.dc_voltage", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::DcVoltageSource>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("voltage", 5.0));
    });
    registerBuiltinMetadata(
        "sources.dc_voltage",
        "Fonte de Tensão",
        components::DcVoltageSource::propertySchema(),
        R"json({"en":{"name":"DC Voltage Source","properties":{"voltage":{"label":"Voltage","group":"Electrical"}}}})json");

    reg.registerFactory("active.diode", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Diode>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "anode" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "cathode" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("saturationCurrent", 1e-12));
    });
    registerBuiltinMetadata(
        "active.diode",
        "Diodo",
        components::Diode::propertySchema(),
        R"json({"en":{"name":"Diode","properties":{"saturationCurrent":{"label":"Saturation Current","group":"Electrical"}}}})json");

    reg.registerFactory("logic.button", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Button>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("pressed", false));
    });
    registerBuiltinMetadata(
        "logic.button",
        "Botão",
        components::Button::propertySchema(),
        R"json({"en":{"name":"Push Button","properties":{"pressed":{"label":"Pressed","group":"Electrical"}}}})json");

    const auto englishName = [](const std::string& label) { return R"json({"en":{"name":")json" + label + R"json("}})json"; };

    const auto registerResistorLike = [&](const std::string& typeId, const std::string& label, double defaultOhm) {
        std::vector<PropertySchema> schema{
            components::detail::numberSchema("resistance", "Resistencia", "ohm", defaultOhm, 1e-9, 1.0,
                                             PropertySchemaShowOnSymbol)};
        reg.registerFactory(typeId, [&, typeId, schema, defaultOhm](const ComponentParams& p) {
            return std::make_unique<components::SimulideTwoPinResistor>(typeId, makePins2(p),
                                                                        p.property("resistance", defaultOhm), schema);
        });
        registerBuiltinMetadata(typeId, label, schema, englishName(label));
    };
    registerResistorLike("passive.variable_resistor", "Variable Resistor", 10000.0);
    registerResistorLike("passive.resistor_dip", "ResistorDip", 1000.0);
    registerResistorLike("passive.ldr", "LDR", 1000.0);
    registerResistorLike("passive.thermistor", "Thermistor", 10000.0);
    registerResistorLike("passive.rtd", "RTD", 100.0);
    registerResistorLike("passive.force_strain_gauge", "Force Strain Gauge", 350.0);

    reg.registerFactory("passive.potentiometer", [&](const ComponentParams& p) {
        return std::make_unique<components::SimulidePotentiometer>(
            "passive.potentiometer", makePins3(p), p.property("resistance", 10000.0), p.property("position", 0.5));
    });
    registerBuiltinMetadata("passive.potentiometer", "Potentiometer", components::SimulidePotentiometer::propertySchema(),
                            englishName("Potentiometer"));

    reg.registerFactory("passive.electrolytic_capacitor", [&](const ComponentParams& p) {
        return std::make_unique<components::Capacitor>(makePins2(p), p.property("capacitance", 1e-6));
    });
    registerBuiltinMetadata("passive.electrolytic_capacitor", "Electrolytic Capacitor",
                            components::Capacitor::propertySchema(), englishName("Electrolytic Capacitor"));
    reg.registerFactory("passive.variable_capacitor", [&](const ComponentParams& p) {
        return std::make_unique<components::Capacitor>(makePins2(p), p.property("capacitance", 1e-6));
    });
    registerBuiltinMetadata("passive.variable_capacitor", "Variable Capacitor", components::Capacitor::propertySchema(),
                            englishName("Variable Capacitor"));
    reg.registerFactory("passive.variable_inductor", [&](const ComponentParams& p) {
        return std::make_unique<components::Inductor>(makePins2(p), p.property("inductance", 1e-3));
    });
    registerBuiltinMetadata("passive.variable_inductor", "Variable Inductor", components::Inductor::propertySchema(),
                            englishName("Variable Inductor"));

    std::vector<PropertySchema> transformerSchema{
        components::detail::numberSchema("coupling", "Coeficiente de Acoplamento", "", 0.99, 0.0, 0.01),
        components::detail::numberSchema("baseInductance", "Indutancia Base", "H", 1.0, 1e-9, 0.1)};
    transformerSchema[0].maxValue = 1.0;
    reg.registerFactory("passive.transformer", [&, transformerSchema](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("passive.transformer", makePinVector(p, 4), transformerSchema);
    });
    registerBuiltinMetadata("passive.transformer", "Transformer", transformerSchema, englishName("Transformer"));

    const auto registerSwitchLike = [&](const std::string& typeId, const std::string& label, size_t pinCount) {
        reg.registerFactory(typeId, [&, typeId, pinCount](const ComponentParams& p) {
            std::string key;
            if (const auto it = p.properties.find("key"); it != p.properties.end()) {
                if (const std::string* value = std::get_if<std::string>(&it->second)) key = *value;
            }
            return std::make_unique<components::SimulideSwitch>(
                typeId, makePinVector(p, pinCount), p.property("closed", false), p.property("normallyClosed", false),
                p.property("doubleThrow", false), p.property("poles", 1.0), std::move(key));
        });
        registerBuiltinMetadata(typeId, label, components::SimulideSwitch::propertySchemaFor(typeId),
                                englishName(label), std::nullopt,
                                components::SimulideSwitch::interactionKindFor(typeId));
    };
    registerSwitchLike("switches.push", "Push", 2);
    registerSwitchLike("switches.switch", "Switch (all)", 2);
    registerSwitchLike("switches.switch_dip", "Switch Dip", 16);

    reg.registerFactory("switches.relay", [&](const ComponentParams& p) {
        return std::make_unique<components::SimulideRelay>(makePinVector(p, 4), p.property("iOn", 15.0),
                                                           p.property("iOff", 5.0),
                                                           p.property("normallyClosed", false));
    });
    registerBuiltinMetadata("switches.relay", "Relay (all)", components::SimulideRelay::propertySchema(),
                            englishName("Relay (all)"));

    std::vector<PropertySchema> keypadSchema{
        components::detail::boolSchema("diodes", "Diodos", false),
        components::detail::boolSchema("diodesDirection", "Direcao dos Diodos", false),
        components::detail::numberSchema("rows", "Linhas", "", 4.0, 1.0, 1.0, PropertySchemaAffectsTopology),
        components::detail::numberSchema("columns", "Colunas", "", 4.0, 1.0, 1.0, PropertySchemaAffectsTopology),
        components::detail::textSchema("keyLabels", "Rotulos", "123A456B789C*0#D")};
    // keypad.cpp real: addPropGroup({tr("Main"), {diodes, direction, rows, cols, keyLabels}, 0}) --
    // as 5 propriedades ficam no MESMO grupo/aba. numberSchema/boolSchema/textSchema tem grupo
    // default diferente cada (Eletrica/Eletrica/Geral) porque isso é o correto pra maioria dos
    // devices -- aqui precisa sobrescrever igual `pushPropertySchema()` faz, senão "Rotulos das
    // teclas" cai numa aba/seção separada de "Linhas"/"Colunas" na Webview (bug relatado: usuário
    // via os campos numéricos mas achava que faltava o campo de rótulos).
    for (PropertySchema& schema : keypadSchema) schema.group = "Principal";
    reg.registerFactory("switches.keypad", [&, keypadSchema](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("switches.keypad", makePinVector(p, 8), keypadSchema);
    });
    registerBuiltinMetadata("switches.keypad", "KeyPad", keypadSchema, englishName("KeyPad"));

    const auto registerDiodeLike = [&](const std::string& typeId, const std::string& label, double threshold) {
        reg.registerFactory(typeId, [&, typeId, threshold](const ComponentParams& p) {
            return std::make_unique<components::SimulideDiodeLike>(
                typeId, makePins2(p), p.property("threshold", threshold), p.property("resistance", 1.0));
        });
        registerBuiltinMetadata(typeId, label, components::SimulideDiodeLike::propertySchema(threshold, 1.0),
                                englishName(label));
    };
    registerDiodeLike("active.zener", "Zener Diode", 5.1);
    registerDiodeLike("active.diac", "Diac", 30.0);
    registerDiodeLike("active.scr", "SCR", 0.8);
    registerDiodeLike("active.triac", "Triac", 0.8);

    const auto registerTransistorLike = [&](const std::string& typeId, const std::string& label, bool pnp) {
        reg.registerFactory(typeId, [&, typeId, pnp](const ComponentParams& p) {
            return std::make_unique<components::SimulideTransistorLike>(typeId, makePins3(p), p.property("beta", 100.0), pnp);
        });
        registerBuiltinMetadata(typeId, label, components::SimulideTransistorLike::propertySchema(), englishName(label));
    };
    registerTransistorLike("active.bjt", "BJT", false);
    registerTransistorLike("active.mosfet", "Mosfet", false);
    registerTransistorLike("active.jfet", "Jfet", false);

    std::vector<PropertySchema> opAmpSchema{components::detail::numberSchema("gain", "Ganho", "", 100000.0, 1.0, 1000.0)};
    reg.registerFactory("active.opamp", [&, opAmpSchema](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("active.opamp", makePinVector(p, 5), opAmpSchema);
    });
    registerBuiltinMetadata("active.opamp", "OpAmp", opAmpSchema, englishName("OpAmp"));
    reg.registerFactory("active.comparator", [&, opAmpSchema](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("active.comparator", makePinVector(p, 5), opAmpSchema);
    });
    registerBuiltinMetadata("active.comparator", "Comparator", opAmpSchema, englishName("Comparator"));

    std::vector<PropertySchema> muxAnalogSchema{
        components::detail::numberSchema("channels", "Canais", "", 3.0, 1.0, 1.0, PropertySchemaAffectsTopology)};
    reg.registerFactory("active.analog_mux", [&, muxAnalogSchema](const ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("active.analog_mux", makePinVector(p, 5), muxAnalogSchema);
    });
    registerBuiltinMetadata("active.analog_mux", "Analog Mux", muxAnalogSchema, englishName("Analog Mux"));

    reg.registerFactory("active.volt_regulator", [&](const ComponentParams& p) {
        return std::make_unique<components::SimulideVoltageRegulator>(makePins3(p), p.property("voltage", 5.0));
    });
    registerBuiltinMetadata("active.volt_regulator", "Volt. Regulator",
                            components::SimulideVoltageRegulator::propertySchema(), englishName("Volt. Regulator"));

    const auto registerOutputState = [&](const std::string& typeId, const std::string& label, size_t pinCount,
                                         std::vector<PropertySchema> schema) {
        reg.registerFactory(typeId, [&, typeId, pinCount, schema](const ComponentParams& p) {
            return std::make_unique<components::SimulidePassiveState>(typeId, makePinVector(p, pinCount), schema);
        });
        registerBuiltinMetadata(typeId, label, schema, englishName(label));
    };
    registerDiodeLike("outputs.led", "Led", 2.0);
    registerOutputState("outputs.led_rgb", "Led Rgb", 4,
                        {components::detail::numberSchema("threshold", "Tensao Direta", "V", 2.0, 0.0, 0.01)});
    registerOutputState("outputs.led_bar", "Led Bar", 16,
                        {components::detail::numberSchema("size", "Tamanho", "Leds", 8.0, 1.0, 1.0, PropertySchemaAffectsTopology)});
    registerOutputState("outputs.led_matrix", "LedMatrix", 16,
                        {components::detail::numberSchema("rows", "Linhas", "Leds", 8.0, 1.0, 1.0, PropertySchemaAffectsTopology),
                         components::detail::numberSchema("columns", "Colunas", "Leds", 8.0, 1.0, 1.0, PropertySchemaAffectsTopology)});
    registerOutputState("outputs.max72xx_matrix", "Max72xx matrix", 5,
                        {components::detail::numberSchema("rows", "Linhas", "Leds", 8.0, 1.0, 1.0),
                         components::detail::numberSchema("columns", "Colunas", "Leds", 8.0, 1.0, 1.0)});
    registerOutputState("outputs.ws2812", "WS2812 Led", 3,
                        {components::detail::numberSchema("rows", "Linhas", "Leds", 1.0, 1.0, 1.0),
                         components::detail::numberSchema("columns", "Colunas", "Leds", 1.0, 1.0, 1.0)});
    registerOutputState("outputs.seven_segment", "7 Segment", 10,
                        {components::detail::numberSchema("size", "Tamanho", "Leds", 8.0, 1.0, 1.0)});
    registerOutputState("outputs.hd44780", "Hd44780", 16, {});
    registerOutputState("outputs.aip31068_i2c", "Aip31068 I2C", 4, {});
    registerOutputState("outputs.pcd8544", "Pcd8544", 8, {});
    registerOutputState("outputs.ks0108", "KS0108", 20, {});
    registerOutputState("outputs.ssd1306", "SSD1306", 4, {});
    registerOutputState("outputs.sh1107", "Sh1107", 4, {});
    registerOutputState("outputs.st7735", "St7735", 8, {});
    registerOutputState("outputs.st7789", "St7789", 8, {});
    registerOutputState("outputs.ili9341", "Ili9341", 8, {});
    registerOutputState("outputs.gc9a01a", "GC9A01A", 8, {});
    registerOutputState("outputs.pcf8833", "Pcf8833", 8, {});
    registerOutputState("outputs.dc_motor", "Dc Motor", 2,
                        {components::detail::numberSchema("resistance", "Resistencia", "ohm", 10.0, 1e-9, 1.0)});
    registerOutputState("outputs.stepper", "Stepper", 4,
                        {components::detail::numberSchema("resistance", "Resistencia", "ohm", 10.0, 1e-9, 1.0)});
    registerOutputState("outputs.servo", "Servo Motor", 3,
                        {components::detail::numberSchema("minPulse", "Pulso Minimo", "us", 1000.0, 1.0, 10.0),
                         components::detail::numberSchema("maxPulse", "Pulso Maximo", "us", 2000.0, 1.0, 10.0)});
    registerOutputState("outputs.audio_out", "Audio Out", 1, {});
    registerOutputState("outputs.incandescent_lamp", "Incandescent lamp", 2,
                        {components::detail::numberSchema("resistance", "Resistencia", "ohm", 100.0, 1e-9, 1.0)});

    // ── Fontes (pasta "Sources" do SimulIDE) ────────────────────────────────────
    reg.registerFactory("sources.battery", [](const ComponentParams& p) {
        return std::make_unique<components::Battery>(makePins2(p, "p1", "p2"), p.property("voltage", 5.0),
                                                      p.property("resistance", 1e-3));
    });
    registerBuiltinMetadata("sources.battery", "Bateria", components::Battery::propertySchema(), englishName("Battery"));

    reg.registerFactory("sources.rail", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Rail>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                   p.property("voltage", 5.0));
    });
    registerBuiltinMetadata("sources.rail", "Trilho (Rail)", components::Rail::propertySchema(), englishName("Rail"));

    reg.registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::FixedVolt>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                        p.property("voltage", 5.0), p.property("out", true));
    });
    registerBuiltinMetadata("sources.fixed_volt", "Tensão Fixa", components::FixedVolt::propertySchema(),
                            englishName("Fixed Voltage"));

    reg.registerFactory("sources.voltage_source", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::VoltSource>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                         p.property("value", 5.0), p.property("minValue", 0.0),
                                                         p.property("maxValue", 5.0));
    });
    registerBuiltinMetadata("sources.voltage_source", "Fonte de Tensão Variável", components::VoltSource::propertySchema(),
                            englishName("Voltage Source"));

    reg.registerFactory("sources.current_source", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::CurrSource>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                         p.property("value", 1.0), p.property("minValue", 0.0),
                                                         p.property("maxValue", 1.0));
    });
    registerBuiltinMetadata("sources.current_source", "Fonte de Corrente", components::CurrSource::propertySchema(),
                            englishName("Current Source"));

    reg.registerFactory("sources.controlled_source", [](const ComponentParams& p) {
        const auto pos = makePinVector(p, 4);
        return std::make_unique<components::Csource>(
            std::array<Pin, 4>{pos[0], pos[1], pos[2], pos[3]}, p.property("controlPins", true),
            p.property("currSource", true), p.property("currControl", false), p.property("gain", 1.0),
            p.property("voltage", 5.0), p.property("current", 1.0));
    });
    registerBuiltinMetadata("sources.controlled_source", "Fonte Controlada", components::Csource::propertySchema(),
                            englishName("Controlled Source"));

    reg.registerFactory("sources.clock", [&scheduler](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Clock>(scheduler, Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                    p.property("voltage", 5.0), p.property("freqHz", 1000.0),
                                                    p.property("alwaysOn", false));
    });
    registerBuiltinMetadata("sources.clock", "Clock", components::Clock::propertySchema(), englishName("Clock"));

    reg.registerFactory("sources.wave_gen", [&scheduler](const ComponentParams& p) {
        return std::make_unique<components::WaveGen>(scheduler, makePins2(p, "out", "gnd"), p.property("freqHz", 1000.0));
    });
    registerBuiltinMetadata("sources.wave_gen", "Gerador de Onda", components::WaveGen::propertySchema(),
                            englishName("Wave Generator"));

    // ── Medidores (pasta "Meters" do SimulIDE) ──────────────────────────────────
    reg.registerFactory("meters.probe", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Probe>(Pin{pos[0].id.empty() ? "in" : pos[0].id, pos[0].x, pos[0].y},
                                                    p.property("threshold", 2.5));
    });
    registerBuiltinMetadata("meters.probe", "Sonda (Probe)", components::Probe::propertySchema(), englishName("Probe"),
                            components::Probe::readoutFormat());

    reg.registerFactory("meters.ampmeter", [](const ComponentParams& p) {
        const auto pos = makePinVector(p, 3);
        return std::make_unique<components::Ampmeter>(std::array<Pin, 3>{pos[0], pos[1], pos[2]},
                                                       p.property("resistance", 1e-6));
    });
    registerBuiltinMetadata("meters.ampmeter", "Amperímetro", components::Ampmeter::propertySchema(),
                            englishName("Ampmeter"), components::Ampmeter::readoutFormat());

    reg.registerFactory("meters.freqmeter", [&scheduler](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::FreqMeter>(
            scheduler, Pin{pos[0].id.empty() ? "in" : pos[0].id, pos[0].x, pos[0].y}, p.property("filter", 0.1));
    });
    registerBuiltinMetadata("meters.freqmeter", "Frequencímetro", components::FreqMeter::propertySchema(),
                            englishName("Frequency Meter"), components::FreqMeter::readoutFormat());

    reg.registerFactory("meters.oscope", [&scheduler](const ComponentParams& p) {
        const auto pos = makePinVector(p, components::Oscope::kChannelCount);
        return std::make_unique<components::Oscope>(
            scheduler, std::array<Pin, components::Oscope::kChannelCount>{pos[0], pos[1], pos[2], pos[3]});
    });
    registerBuiltinMetadata("meters.oscope", "Osciloscópio", components::Oscope::propertySchema(),
                            englishName("Oscilloscope"), components::Oscope::readoutFormat());

    reg.registerFactory("meters.logic_analyzer", [&scheduler](const ComponentParams& p) {
        const auto pos = makePinVector(p, components::LogicAnalyzer::kChannelCount);
        std::array<Pin, components::LogicAnalyzer::kChannelCount> pins{};
        for (size_t i = 0; i < components::LogicAnalyzer::kChannelCount; ++i) pins[i] = pos[i];
        return std::make_unique<components::LogicAnalyzer>(scheduler, pins, p.property("thresholdRising", 2.5), p.property("thresholdFalling", 2.5));
    });
    registerBuiltinMetadata("meters.logic_analyzer", "Analisador Lógico", components::LogicAnalyzer::propertySchema(),
                            englishName("Logic Analyzer"), components::LogicAnalyzer::readoutFormat());

    reg.registerFactory("instruments.voltmeter", [](const ComponentParams& p) {
        const auto pos = makePinVector(p, 3);
        return std::make_unique<components::Voltmeter>(std::array<Pin, 3>{pos[0], pos[1], pos[2]});
    });
    registerBuiltinMetadata("instruments.voltmeter", "Voltímetro", components::Voltmeter::propertySchema(),
                            englishName("Voltmeter"), components::Voltmeter::readoutFormat());
}

} // namespace

// ── dispatch de mensagens IPC ──────────────────────────────────────────────────

namespace {

PropertyValue jsonToPropertyValue(const nlohmann::json& value) {
    if (value.is_boolean()) return value.get<bool>();
    if (value.is_string()) return value.get<std::string>();
    if (value.is_object() && value.contains("x") && value.contains("y")) {
        return PropertyPoint{value.value("x", 0.0), value.value("y", 0.0)};
    }
    return value.get<double>();
}

std::string optionValueToString(const nlohmann::json& value) {
    if (value.is_string()) return value.get<std::string>();
    if (value.is_number() || value.is_boolean()) return value.dump();
    return {};
}

PropertyValueKind parsePropertyValueKind(const std::string& valueKind, const std::string& editor) {
    if (valueKind == "number" || valueKind == "double" || valueKind == "int" || valueKind == "uint") {
        return PropertyValueKind::Number;
    }
    if (valueKind == "bool" || valueKind == "boolean") return PropertyValueKind::Bool;
    if (valueKind == "point") return PropertyValueKind::Point;
    if (valueKind == "string" || valueKind == "text" || valueKind == "enum" || valueKind == "color"
        || valueKind == "path" || valueKind == "file") {
        return PropertyValueKind::String;
    }
    if (editor == "checkbox" || editor == "switch") return PropertyValueKind::Bool;
    return PropertyValueKind::String;
}

uint32_t parsePropertyFlags(const nlohmann::json& propertyJson) {
    uint32_t flags = PropertySchemaNone;
    if (propertyJson.value("hidden", false)) flags |= PropertySchemaHidden;
    if (propertyJson.value("readOnly", false)) flags |= PropertySchemaReadOnly;
    if (propertyJson.value("noCopy", false)) flags |= PropertySchemaNoCopy;
    if (propertyJson.value("affectsTopology", false)) flags |= PropertySchemaAffectsTopology;
    if (propertyJson.value("requiresRestart", false)) flags |= PropertySchemaRequiresRestart;
    if (propertyJson.value("showOnSymbol", false)) flags |= PropertySchemaShowOnSymbol;
    return flags;
}

PropertySchema parsePropertySchema(const nlohmann::json& propertyJson) {
    PropertySchema schema;
    schema.id = propertyJson.value("id", propertyJson.value("name", std::string{}));
    schema.label = propertyJson.value("label", schema.id);
    schema.group = propertyJson.value("group", std::string{});
    schema.unit = propertyJson.value("unit", std::string{});
    schema.editor = propertyJson.value("editor", propertyJson.value("type", std::string{"text"}));
    schema.valueKind = parsePropertyValueKind(propertyJson.value("valueKind", propertyJson.value("type", std::string{"string"})),
                                              schema.editor);

    if (propertyJson.contains("default")) {
        schema.defaultValue = jsonToPropertyValue(propertyJson["default"]);
    } else {
        switch (schema.valueKind) {
            case PropertyValueKind::Number: schema.defaultValue = 0.0; break;
            case PropertyValueKind::Bool: schema.defaultValue = false; break;
            case PropertyValueKind::Point: schema.defaultValue = PropertyPoint{}; break;
            case PropertyValueKind::String:
            default: schema.defaultValue = std::string{}; break;
        }
    }

    if (propertyJson.contains("min") && propertyJson["min"].is_number()) schema.minValue = propertyJson["min"].get<double>();
    if (propertyJson.contains("max") && propertyJson["max"].is_number()) schema.maxValue = propertyJson["max"].get<double>();
    if (propertyJson.contains("step") && propertyJson["step"].is_number()) schema.step = propertyJson["step"].get<double>();
    if (propertyJson.contains("options") && propertyJson["options"].is_array()) {
        for (const auto& optionJson : propertyJson["options"]) {
            PropertyOption option;
            if (optionJson.is_object()) {
                if (optionJson.contains("value")) option.value = optionValueToString(optionJson["value"]);
                option.label = optionJson.contains("label") ? optionValueToString(optionJson["label"]) : option.value;
            } else if (optionJson.is_string()) {
                option.value = optionJson.get<std::string>();
                option.label = option.value;
            } else {
                option.value = optionValueToString(optionJson);
                option.label = option.value;
            }
            schema.options.push_back(std::move(option));
        }
    }
    schema.flags = parsePropertyFlags(propertyJson);
    return schema;
}

std::vector<PropertySchema> parsePropertySchemaList(const nlohmann::json& deviceJson) {
    std::vector<PropertySchema> schemaList;
    if (!deviceJson.contains("properties") || !deviceJson["properties"].is_array()) return schemaList;
    schemaList.reserve(deviceJson["properties"].size());
    for (const auto& propertyJson : deviceJson["properties"]) {
        schemaList.push_back(parsePropertySchema(propertyJson));
    }
    return schemaList;
}

/** ABI v2 (.spec/lasecsimul-native-devices.spec): chave opcional `"readout"` de `.lsdevice` --
 * device de terceiros declara como a UI deve decodificar sua leitura sem nenhuma mudança de código
 * no Core nem na Extension. Ausente/mal-formado = nullopt ("sem leitura estruturada"), nunca erro --
 * a maioria dos devices não tem mostrador. */
std::optional<ReadoutFormat> parseReadoutFormat(const nlohmann::json& deviceJson) {
    if (!deviceJson.contains("readout") || !deviceJson["readout"].is_object()) return std::nullopt;
    const nlohmann::json& readout = deviceJson["readout"];
    const std::string kind = readout.value("kind", std::string{"scalar"});
    ReadoutFormat format;
    if (kind == "channelHistory") {
        format.kind = ReadoutKind::ChannelHistory;
        format.channels = readout.value("channels", 0u);
    } else if (kind == "bitmaskHistory") {
        format.kind = ReadoutKind::BitmaskHistory;
        format.channels = readout.value("channels", 0u);
    } else {
        format.kind = ReadoutKind::Scalar;
        format.unit = readout.value("unit", std::string{});
    }
    return format;
}

/** Mesmo padrão de `parseReadoutFormat`, pra chave opcional `"interaction"` (string:
 * "momentary"/"toggle"/"none"). */
std::optional<InteractionKind> parseInteractionKind(const nlohmann::json& deviceJson) {
    if (!deviceJson.contains("interaction") || !deviceJson["interaction"].is_string()) return std::nullopt;
    const std::string value = deviceJson["interaction"].get<std::string>();
    if (value == "momentary") return InteractionKind::Momentary;
    if (value == "toggle") return InteractionKind::Toggle;
    if (value == "none") return InteractionKind::None;
    return std::nullopt; // unknown values (joystick, encoder, etc.) handled Extension-side
}

// ── serialização pro lado IPC (getPropertySchemas) — inversa de jsonToPropertyValue/
// parsePropertySchema acima, pra a Webview receber exatamente o que `.lsdevice` já declara pros
// plugins, agora também pros built-ins (ComponentMetadataRegistry, ver registerBuiltinComponents). ──

nlohmann::json propertyValueToJson(const PropertyValue& value) {
    if (const double* d = std::get_if<double>(&value)) return *d;
    if (const std::string* s = std::get_if<std::string>(&value)) return *s;
    if (const bool* b = std::get_if<bool>(&value)) return *b;
    const PropertyPoint& point = std::get<PropertyPoint>(value);
    return nlohmann::json{{"x", point.x}, {"y", point.y}};
}

const char* propertyValueKindToJson(PropertyValueKind kind) {
    switch (kind) {
        case PropertyValueKind::Number: return "number";
        case PropertyValueKind::Bool: return "bool";
        case PropertyValueKind::Point: return "point";
        case PropertyValueKind::String:
        default: return "string";
    }
}

nlohmann::json propertySchemaToJson(const PropertySchema& schema) {
    nlohmann::json json{
        {"id", schema.id},
        {"label", schema.label},
        {"group", schema.group},
        {"unit", schema.unit},
        {"valueKind", propertyValueKindToJson(schema.valueKind)},
        {"editor", schema.editor},
        {"default", propertyValueToJson(schema.defaultValue)},
        {"hidden", (schema.flags & PropertySchemaHidden) != 0},
        {"readOnly", (schema.flags & PropertySchemaReadOnly) != 0},
        {"noCopy", (schema.flags & PropertySchemaNoCopy) != 0},
        {"affectsTopology", (schema.flags & PropertySchemaAffectsTopology) != 0},
        {"requiresRestart", (schema.flags & PropertySchemaRequiresRestart) != 0},
        {"showOnSymbol", (schema.flags & PropertySchemaShowOnSymbol) != 0},
    };
    if (schema.minValue) json["min"] = *schema.minValue;
    if (schema.maxValue) json["max"] = *schema.maxValue;
    if (schema.step) json["step"] = *schema.step;
    if (!schema.options.empty()) {
        nlohmann::json options = nlohmann::json::array();
        for (const PropertyOption& option : schema.options) {
            options.push_back({{"value", option.value}, {"label", option.label}});
        }
        json["options"] = std::move(options);
    }
    return json;
}

/** ABI v2 -- serializa `ReadoutFormat`/`InteractionKind` pro mesmo payload de `getPropertySchemas`,
 * inversa de `parseReadoutFormat`/`parseInteractionKind` acima. */
nlohmann::json readoutFormatToJson(const ReadoutFormat& format) {
    switch (format.kind) {
        case ReadoutKind::ChannelHistory:
            return nlohmann::json{{"kind", "channelHistory"}, {"channels", format.channels}};
        case ReadoutKind::BitmaskHistory:
            return nlohmann::json{{"kind", "bitmaskHistory"}, {"channels", format.channels}};
        case ReadoutKind::Scalar:
        default:
            return nlohmann::json{{"kind", "scalar"}, {"unit", format.unit}};
    }
}

const char* interactionKindToJson(InteractionKind kind) {
    switch (kind) {
        case InteractionKind::Momentary: return "momentary";
        case InteractionKind::Toggle: return "toggle";
        case InteractionKind::None:
        default: return "none";
    }
}

/** Resolve `propertySchema` de uma `ComponentMetadata` pra a língua pedida — implementação de
 * `lasecsimul.spec` seção 6.3.3 (fallback: solicitada → língua-base do manifesto → devolve a base
 * sem alteração se não houver tradução pra essa língua, nunca string vazia). Caminho rápido (sem cópia
 * nem parse de JSON) quando a língua pedida já é a língua-base ou não há `translations` nenhuma —
 * é o caso comum (maioria das chamadas não pede tradução, ou o componente não tem nenhuma). */
std::vector<PropertySchema> resolvePropertySchemaForLanguage(const registry::ComponentMetadata& meta,
                                                              const std::string& requestedLanguage) {
    if (requestedLanguage.empty() || requestedLanguage == meta.language || meta.translationsJson.empty()) {
        return meta.propertySchema;
    }
    nlohmann::json translations;
    try {
        translations = nlohmann::json::parse(meta.translationsJson);
    } catch (const std::exception&) {
        return meta.propertySchema; // translations malformado -- cai pra língua-base, nunca quebra
    }
    if (!translations.contains(requestedLanguage)) return meta.propertySchema;
    const nlohmann::json& translated = translations[requestedLanguage];
    const nlohmann::json* properties = translated.contains("properties") ? &translated["properties"] : nullptr;

    std::vector<PropertySchema> resolved = meta.propertySchema; // cópia -- a base nunca é alterada
    for (PropertySchema& schema : resolved) {
        if (!properties || !properties->contains(schema.id)) continue;
        const nlohmann::json& propertyTranslation = (*properties)[schema.id];
        if (propertyTranslation.contains("label")) schema.label = propertyTranslation.value("label", schema.label);
        if (propertyTranslation.contains("group")) schema.group = propertyTranslation.value("group", schema.group);
        if (propertyTranslation.contains("options") && propertyTranslation["options"].is_object()) {
            for (PropertyOption& option : schema.options) {
                const nlohmann::json& optionsTranslation = propertyTranslation["options"];
                if (optionsTranslation.contains(option.value)) {
                    option.label = optionsTranslation.value(option.value, option.label);
                }
            }
        }
    }
    return resolved;
}

struct ParsedPropertyError {
    std::string code;
    std::string message;
};

ParsedPropertyError parsePropertyError(const std::string& rawError) {
    const size_t separator = rawError.find('|');
    if (separator == std::string::npos) return {"unknown_property", rawError};
    return {rawError.substr(0, separator), rawError.substr(separator + 1)};
}

/** Parseia `subcircuits/library.json` (lista de `{typeId, manifest}`, mesmo padrão de
 * `devices/library.json`) e cada `.lssubcircuit` referenciado (ou `.lssub.json` antigo, ainda
 * aberto por compatibilidade), registrando no `SubcircuitRegistry`
 * da sessão -- ver .spec/lasecsimul-subcircuits.spec, seções 1 e 7. Roda no mesmo verbo IPC
 * `loadDeviceLibrary` que já existe (seção 6): um `library.json` com `"devices"` cai no caminho de
 * plugin nativo (`loadDeviceLibraryFile`), um com `"subcircuits"` cai aqui -- os dois são checados
 * independentemente porque um `library.json` futuro poderia, em tese, ter as duas chaves. */
/** Lê UM `.lssubcircuit` e registra no `SubcircuitRegistry` -- corpo por-entrada que
 * `loadSubcircuitLibraryFile` sempre executou, fatorado aqui pra ser reutilizado também pelo verbo
 * IPC avulso `registerAdhocSubcircuit` (bloco genérico de subcircuito por caminho, sem exigir
 * `library.json`/registro prévio na paleta -- ver .spec/lasecsimul-subcircuits.spec seção 12).
 * `typeIdOverride` preserva o comportamento de sempre quando chamado a partir do loop de
 * `library.json` (typeId vem da ENTRADA do library.json, não do manifesto); quando vazio (caso do
 * verbo avulso), usa o `typeId` declarado dentro do próprio manifesto. Devolve o typeId
 * efetivamente registrado. */
struct RegisteredSubcircuitInfo {
    std::string typeId;
    nlohmann::json payload;
};

std::string canonicalPathString(const std::filesystem::path& path) {
    std::error_code ec;
    const std::filesystem::path canonical = std::filesystem::weakly_canonical(path, ec);
    return (ec ? std::filesystem::absolute(path) : canonical).lexically_normal().string();
}

std::string requiredString(const nlohmann::json& object, const char* key, const std::string& context) {
    if (!object.contains(key) || !object[key].is_string() || object[key].get<std::string>().empty()) {
        throw std::runtime_error(context + " sem campo string obrigatorio '" + key + "'");
    }
    return object[key].get<std::string>();
}

const nlohmann::json& requiredArray(const nlohmann::json& object, const char* key, const std::string& context) {
    if (!object.contains(key) || !object[key].is_array()) {
        throw std::runtime_error(context + " sem array obrigatorio '" + key + "'");
    }
    return object[key];
}

std::string registerSubcircuitFromManifestLegacyUnused(const std::filesystem::path& manifestPath,
                                                       registry::SubcircuitRegistry& subcircuits,
                                                       const std::string& typeIdOverride = {}) {
    std::ifstream manifestFile(manifestPath);
    if (!manifestFile) throw std::runtime_error("manifesto de subcircuito (.lssubcircuit) não encontrado: " + manifestPath.string());
    nlohmann::json manifest;
    manifestFile >> manifest;

    const std::string typeId = !typeIdOverride.empty() ? typeIdOverride : manifest.value("typeId", std::string{});
    if (typeId.empty()) throw std::runtime_error("manifesto de subcircuito sem typeId: " + manifestPath.string());

    registry::SubcircuitDefinition def;
    def.typeId = typeId;
    def.name = manifest.value("name", typeId);
    def.packageJson = manifest.contains("package") ? manifest["package"].dump() : "{}";

    if (manifest.contains("components") && manifest["components"].is_array()) {
        for (const auto& compJson : manifest["components"]) {
            registry::SubcircuitComponentDef comp;
            comp.id = compJson.value("id", std::string{});
            comp.typeId = compJson.value("typeId", std::string{});
            comp.propertiesJson = compJson.contains("properties") ? compJson["properties"].dump() : "{}";
            def.components.push_back(std::move(comp));
        }
    }
    if (manifest.contains("wires") && manifest["wires"].is_array()) {
        for (const auto& wireJson : manifest["wires"]) {
            registry::SubcircuitWireDef wire;
            wire.fromComponentId = wireJson["from"].value("componentId", std::string{});
            wire.fromPinId = wireJson["from"].value("pinId", std::string{});
            wire.toComponentId = wireJson["to"].value("componentId", std::string{});
            wire.toPinId = wireJson["to"].value("pinId", std::string{});
            def.wires.push_back(std::move(wire));
        }
    }
    if (manifest.contains("interface") && manifest["interface"].is_array()) {
        for (const auto& ifaceJson : manifest["interface"]) {
            registry::SubcircuitInterfaceDef iface;
            iface.pinId = ifaceJson.value("pinId", std::string{});
            iface.label = ifaceJson.value("label", iface.pinId);
            iface.internalTunnel = ifaceJson.value("internalTunnel", std::string{});
            def.interfaceDefs.push_back(std::move(iface));
        }
    }
    subcircuits.registerDefinition(std::move(def));
    return typeId;
}

RegisteredSubcircuitInfo registerSubcircuitFromManifestRich(const std::filesystem::path& manifestPath,
                                                            registry::SubcircuitRegistry& subcircuits,
                                                            const std::string& typeIdOverride = {},
                                                            bool allowReplace = true) {
    std::ifstream manifestFile(manifestPath);
    if (!manifestFile) throw std::runtime_error("manifesto de subcircuito (.lssubcircuit) nao encontrado: " + manifestPath.string());
    nlohmann::json manifest;
    manifestFile >> manifest;
    if (!manifest.is_object()) throw std::runtime_error("manifesto de subcircuito deve ser um objeto JSON: " + manifestPath.string());

    if (!manifest.contains("schemaVersion") || !manifest["schemaVersion"].is_number_integer()) {
        throw std::runtime_error("manifesto de subcircuito sem schemaVersion inteiro: " + manifestPath.string());
    }
    const int schemaVersion = manifest["schemaVersion"].get<int>();
    if (schemaVersion != 1) {
        throw std::runtime_error("schemaVersion de subcircuito nao suportado: " + std::to_string(schemaVersion));
    }

    const std::string typeId = !typeIdOverride.empty() ? typeIdOverride : requiredString(manifest, "typeId", "manifesto de subcircuito");
    const std::string sourcePath = canonicalPathString(manifestPath);
    const registry::SubcircuitDefinition* existing = subcircuits.find(typeId);
    const bool sameSourceReload = existing && !existing->sourcePath.empty() && existing->sourcePath == sourcePath;
    if (existing && !allowReplace && !sameSourceReload) {
        throw std::runtime_error("typeId de subcircuito duplicado: " + typeId + " (ja registrado em " +
                                 (existing->sourcePath.empty() ? std::string{"fonte nao informada"} : existing->sourcePath) + ")");
    }
    const bool replacing = existing != nullptr;

    const nlohmann::json& componentsJson = requiredArray(manifest, "components", "manifesto de subcircuito");
    const nlohmann::json& wiresJson = requiredArray(manifest, "wires", "manifesto de subcircuito");
    const nlohmann::json& interfaceJson = requiredArray(manifest, "interface", "manifesto de subcircuito");

    registry::SubcircuitDefinition def;
    def.typeId = typeId;
    def.name = manifest.value("name", typeId);
    def.sourcePath = sourcePath;
    def.packageJson = manifest.contains("package") ? manifest["package"].dump() : "{}";

    std::unordered_set<std::string> componentIds;
    std::unordered_set<std::string> tunnelNames;
    for (const auto& compJson : componentsJson) {
        if (!compJson.is_object()) throw std::runtime_error("components[] deve conter objetos em " + sourcePath);
        registry::SubcircuitComponentDef comp;
        comp.id = requiredString(compJson, "id", "components[]");
        comp.typeId = requiredString(compJson, "typeId", "components[]");
        if (!componentIds.insert(comp.id).second) throw std::runtime_error("id de componente duplicado no subcircuito: " + comp.id);
        if (compJson.contains("properties") && !compJson["properties"].is_object()) {
            throw std::runtime_error("properties de componente deve ser objeto: " + comp.id);
        }
        comp.propertiesJson = compJson.contains("properties") ? compJson["properties"].dump() : "{}";
        if (comp.typeId == "connectors.tunnel" && compJson.contains("properties") && compJson["properties"].is_object()) {
            const auto& properties = compJson["properties"];
            if (properties.contains("name") && properties["name"].is_string() && !properties["name"].get<std::string>().empty()) {
                tunnelNames.insert(properties["name"].get<std::string>());
            }
        }
        def.components.push_back(std::move(comp));
    }

    for (const auto& wireJson : wiresJson) {
        if (!wireJson.is_object()) throw std::runtime_error("wires[] deve conter objetos em " + sourcePath);
        if (!wireJson.contains("from") || !wireJson["from"].is_object() || !wireJson.contains("to") || !wireJson["to"].is_object()) {
            throw std::runtime_error("wire sem endpoints from/to objetos em " + sourcePath);
        }
        registry::SubcircuitWireDef wire;
        wire.fromComponentId = requiredString(wireJson["from"], "componentId", "wire.from");
        wire.fromPinId = requiredString(wireJson["from"], "pinId", "wire.from");
        wire.toComponentId = requiredString(wireJson["to"], "componentId", "wire.to");
        wire.toPinId = requiredString(wireJson["to"], "pinId", "wire.to");
        if (!componentIds.contains(wire.fromComponentId)) {
            throw std::runtime_error("wire referencia componente inexistente: " + wire.fromComponentId);
        }
        if (!componentIds.contains(wire.toComponentId)) {
            throw std::runtime_error("wire referencia componente inexistente: " + wire.toComponentId);
        }
        def.wires.push_back(std::move(wire));
    }

    nlohmann::json exportedInterface = nlohmann::json::array();
    nlohmann::json pinIds = nlohmann::json::array();
    std::unordered_set<std::string> interfacePinIds;
    for (const auto& ifaceJson : interfaceJson) {
        if (!ifaceJson.is_object()) throw std::runtime_error("interface[] deve conter objetos em " + sourcePath);
        registry::SubcircuitInterfaceDef iface;
        iface.pinId = requiredString(ifaceJson, "pinId", "interface[]");
        iface.label = ifaceJson.value("label", iface.pinId);
        iface.internalTunnel = requiredString(ifaceJson, "internalTunnel", "interface[]");
        if (!interfacePinIds.insert(iface.pinId).second) throw std::runtime_error("pinId duplicado na interface: " + iface.pinId);
        if (!tunnelNames.contains(iface.internalTunnel)) {
            throw std::runtime_error("interface referencia tunnel interno inexistente: " + iface.internalTunnel);
        }
        exportedInterface.push_back({{"pinId", iface.pinId}, {"label", iface.label}, {"internalTunnel", iface.internalTunnel}});
        pinIds.push_back(iface.pinId);
        def.interfaceDefs.push_back(std::move(iface));
    }

    if (manifest.contains("package")) {
        if (!manifest["package"].is_object()) throw std::runtime_error("package de subcircuito deve ser objeto: " + typeId);
        if (manifest["package"].contains("pins")) {
            const nlohmann::json& packagePins = manifest["package"]["pins"];
            if (!packagePins.is_array()) throw std::runtime_error("package.pins deve ser array: " + typeId);
            std::unordered_set<std::string> packagePinIds;
            for (const auto& pinJson : packagePins) {
                if (!pinJson.is_object()) throw std::runtime_error("package.pins[] deve conter objetos: " + typeId);
                const std::string pinId = requiredString(pinJson, "id", "package.pins[]");
                if (!packagePinIds.insert(pinId).second) throw std::runtime_error("package.pins id duplicado: " + pinId);
                if (!interfacePinIds.contains(pinId)) throw std::runtime_error("package.pins referencia pin fora da interface: " + pinId);
            }
        }
    }

    subcircuits.registerDefinition(std::move(def), true);
    nlohmann::json payload{
        {"status", replacing ? "reloaded" : "registered"},
        {"replaced", replacing},
        {"typeId", typeId},
        {"name", manifest.value("name", typeId)},
        {"path", sourcePath},
        {"interface", exportedInterface},
        {"pinIds", pinIds},
        {"pinCount", pinIds.size()},
        {"package", manifest.contains("package") ? manifest["package"] : nlohmann::json(nullptr)},
        {"logicSymbolPackage", manifest.contains("logicSymbolPackage") ? manifest["logicSymbolPackage"] : nlohmann::json(nullptr)},
        {"defaultProperties", manifest.contains("defaultProperties") && manifest["defaultProperties"].is_object() ? manifest["defaultProperties"] : nlohmann::json::object()},
        {"propertySchema", manifest.contains("propertySchema") && manifest["propertySchema"].is_array() ? manifest["propertySchema"] : nlohmann::json::array()},
        {"translations", manifest.contains("translations") && manifest["translations"].is_object() ? manifest["translations"] : nlohmann::json::object()},
        {"language", manifest.contains("language") && manifest["language"].is_string() ? manifest["language"] : nlohmann::json(nullptr)},
        {"folderPath", manifest.contains("folderPath") && (manifest["folderPath"].is_array() || manifest["folderPath"].is_string()) ? manifest["folderPath"] : nlohmann::json(nullptr)},
        {"icon", manifest.contains("icon") && manifest["icon"].is_string() ? manifest["icon"] : nlohmann::json(nullptr)},
        {"iconPath", manifest.contains("iconPath") && manifest["iconPath"].is_string() ? manifest["iconPath"] : nlohmann::json(nullptr)}};
    return {typeId, std::move(payload)};
}

void loadSubcircuitLibraryFile(const std::filesystem::path& libraryJsonPath, registry::SubcircuitRegistry& subcircuits) {
    std::ifstream libraryFile(libraryJsonPath);
    if (!libraryFile) throw std::runtime_error("library.json não encontrado: " + libraryJsonPath.string());
    nlohmann::json library;
    libraryFile >> library;

    if (!library.contains("subcircuits") || !library["subcircuits"].is_array()) return;
    const std::filesystem::path libraryDir = libraryJsonPath.parent_path();

    for (const auto& entry : library["subcircuits"]) {
        const std::string typeId = entry.value("typeId", std::string{});
        const std::string manifestRelative = entry.value("manifest", std::string{});
        if (typeId.empty() || manifestRelative.empty()) continue;
        (void)registerSubcircuitFromManifestRich(libraryDir / manifestRelative, subcircuits, typeId, true);
    }
}

#if defined(_WIN32)
constexpr const char* kPlatformKey = "win32-x64";
#elif defined(__APPLE__)
constexpr const char* kPlatformKey = "darwin-universal";
#else
constexpr const char* kPlatformKey = "linux-x64";
#endif

/** Parseia `library.json` (lista de `{typeId, manifest}`), parseia cada `.lsdevice` referenciado
 * (ou `device.json` antigo, ainda aberto por compatibilidade),
 * resolve o binário nativo da plataforma atual e publica no GlobalPluginCache —
 * `PluginLoader::scanDirectory()` permanece o stub documentado (ver PluginLoader.hpp, "quem chama
 * scanDirectory é responsável por publicar no GlobalPluginCache"); esta função é esse chamador, só
 * ainda não existia nenhum. Caminhos em `nativeEntry`/`manifest` são relativos ao arquivo que os
 * declara (`.lsdevice`/`device.json` e library.json, respectivamente) — mesma convenção usada por
 * `npm run build:devices` ao gerar `devices/example-blinker/build/win-x64/device.dll`. */
void loadDeviceLibraryFile(const std::filesystem::path& libraryJsonPath, GlobalPluginCache& pluginCache) {
    std::ifstream libraryFile(libraryJsonPath);
    if (!libraryFile) throw std::runtime_error("library.json não encontrado: " + libraryJsonPath.string());
    nlohmann::json library;
    libraryFile >> library;

    if (!library.contains("devices") || !library["devices"].is_array()) return;
    const std::filesystem::path libraryDir = libraryJsonPath.parent_path();

    for (const auto& deviceEntry : library["devices"]) {
        const std::string typeId = deviceEntry.value("typeId", std::string{});
        const std::string manifestRelative = deviceEntry.value("manifest", std::string{});
        if (typeId.empty() || manifestRelative.empty()) continue;

        const std::filesystem::path manifestPath = libraryDir / manifestRelative;
        std::ifstream manifestFile(manifestPath);
        if (!manifestFile) throw std::runtime_error("manifesto de dispositivo (.lsdevice) não encontrado: " + manifestPath.string());
        nlohmann::json device;
        manifestFile >> device;

        if (!device.contains("nativeEntry") || !device["nativeEntry"].contains(kPlatformKey)) {
            throw std::runtime_error("manifesto de dispositivo sem nativeEntry para a plataforma atual ('" +
                                      std::string(kPlatformKey) + "'): " + manifestPath.string());
        }
        const std::filesystem::path binaryPath =
            manifestPath.parent_path() / device["nativeEntry"][kPlatformKey].get<std::string>();

        registry::ComponentMetadata metadata;
        metadata.typeId = typeId;
        metadata.displayName = device.value("name", typeId);
        metadata.propertySchema = parsePropertySchemaList(device);
        metadata.readoutFormat = parseReadoutFormat(device);
        metadata.interactionKind = parseInteractionKind(device);
        // language é obrigatório por contrato (RNF12 de lasecsimul.spec), mas manifesto anterior a
        // esta rodada não declara -- default "pt-BR" preserva compatibilidade (todo manifesto existente
        // até aqui foi de fato escrito em português, então o default não está mentindo).
        metadata.language = device.value("language", std::string{"pt-BR"});
        if (device.contains("translations")) metadata.translationsJson = device["translations"].dump();
        if (device.contains("limits") && device["limits"].is_object()) {
            metadata.stepTimeoutMs = device["limits"].value("stepTimeoutMs", 0u);
        }
        if (device.contains("pins") && device["pins"].is_array()) {
            for (const auto& pinJson : device["pins"]) {
                Pin pin;
                pin.id = pinJson.value("id", std::string{});
                pin.x = pinJson.value("x", 0.0);
                pin.y = pinJson.value("y", 0.0);
                metadata.pins.push_back(std::move(pin));
            }
        }
        pluginCache.metadata().registerMetadata(std::move(metadata));

        std::shared_ptr<PluginModule> module = pluginCache.loader().loadDevicePlugin(binaryPath);
        pluginCache.setActiveDeviceModule(typeId, module);
    }
}

/** Mesmo padrão de `loadDeviceLibraryFile`, para a chave `"mcus"` de `library.json` (adaptador de
 * MCU via plugin nativo, ver `mcu_abi.h`). Cada entrada `{chipId, manifest}` aponta pra um
 * `mcu.json` cujo `nativeEntry[plataforma]` é resolvido e carregado via `PluginLoader::loadMcuPlugin`
 * — mesma convenção de caminho relativo de `loadDeviceLibraryFile`. */
void loadMcuLibraryFile(const std::filesystem::path& libraryJsonPath, GlobalPluginCache& pluginCache) {
    std::ifstream libraryFile(libraryJsonPath);
    if (!libraryFile) throw std::runtime_error("library.json não encontrado: " + libraryJsonPath.string());
    nlohmann::json library;
    libraryFile >> library;

    if (!library.contains("mcus") || !library["mcus"].is_array()) return;
    const std::filesystem::path libraryDir = libraryJsonPath.parent_path();

    for (const auto& mcuEntry : library["mcus"]) {
        const std::string chipId = mcuEntry.value("chipId", std::string{});
        const std::string manifestRelative = mcuEntry.value("manifest", std::string{});
        if (chipId.empty() || manifestRelative.empty()) continue;

        const std::filesystem::path manifestPath = libraryDir / manifestRelative;
        std::ifstream manifestFile(manifestPath);
        if (!manifestFile) throw std::runtime_error("manifesto de MCU (.lsdevice) não encontrado: " + manifestPath.string());
        nlohmann::json mcu;
        manifestFile >> mcu;

        if (!mcu.contains("nativeEntry") || !mcu["nativeEntry"].contains(kPlatformKey)) {
            throw std::runtime_error("manifesto de MCU sem nativeEntry para a plataforma atual ('" +
                                      std::string(kPlatformKey) + "'): " + manifestPath.string());
        }
        const std::filesystem::path binaryPath =
            manifestPath.parent_path() / mcu["nativeEntry"][kPlatformKey].get<std::string>();

        std::shared_ptr<PluginModule> module = pluginCache.loader().loadMcuPlugin(binaryPath);
        pluginCache.setActiveMcuModule(chipId, module);
    }
}

} // namespace

namespace {

OutgoingResponse handleMessage(const IncomingMessage& msg, SimulationSession& session,
                                IpcServer& server, GlobalPluginCache& pluginCache) {
    OutgoingResponse resp;
    resp.id = msg.id;

    // ── hello ──────────────────────────────────────────────────────────────────
    if (msg.type == "hello") {
        resp.ok = true;
        resp.payloadJson = R"({"serverVersion":"0.1.0","protocolVersion":)"
                           + std::to_string(PROTOCOL_VERSION) + "}";
        return resp;
    }

    // ── shutdown ───────────────────────────────────────────────────────────────
    if (msg.type == "shutdown") {
        session.scheduler().stop();
        server.shutdown();
        resp.ok = true;
        return resp;
    }

    // ── controle de simulação ──────────────────────────────────────────────────
    if (msg.type == "start") {
        session.scheduler().start();
        resp.ok = true;
        return resp;
    }
    if (msg.type == "pause") {
        session.scheduler().pause();
        resp.ok = true;
        return resp;
    }
    if (msg.type == "stop") {
        session.scheduler().stop();
        resp.ok = true;
        return resp;
    }
    if (msg.type == "step") {
        // passo único — não implementado no Scheduler ainda; reservado
        resp.ok = false;
        resp.error = "step não implementado";
        return resp;
    }

    // ── esquemático: componentes e fios ───────────────────────────────────────
    if (msg.type == "addComponent") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            ComponentParams params;
            if (payload.contains("properties") && payload["properties"].is_object()) {
                for (const auto& [key, value] : payload["properties"].items()) {
                    params.properties[key] = jsonToPropertyValue(value);
                }
            }
            // IDs/posições de pino vindos da Webview — built-ins ignoram o id daqui (usam um
            // hardcoded na própria factory, ver registerBuiltinComponents) e só leem a posição,
            // mas plugins (NativeDeviceProxy) usam ESTES ids diretamente como ComponentMeta::pins
            // — sem isso, connectWire nunca acertaria o pino certo de um plugin (ver
            // .spec/lasecsimul.spec sobre instrumentos/plugins ABI).
            if (payload.contains("pins") && payload["pins"].is_array()) {
                for (const auto& pinJson : payload["pins"]) {
                    Pin pin;
                    pin.id = pinJson.value("id", std::string{});
                    pin.x = pinJson.value("x", 0.0);
                    pin.y = pinJson.value("y", 0.0);
                    params.pinList.push_back(std::move(pin));
                }
            }
            const std::string typeId = payload.value("typeId", std::string{});
            if (session.isSubcircuitType(typeId)) {
                // Subcircuito: nem `properties`/`pins` do payload se aplicam (interno já vem fixo
                // do .lssubcircuit) — ver .spec/lasecsimul-subcircuits.spec, seção 5.1/6.
                const session::SubcircuitExpansionResult expansion = session.addSubcircuitInstance(typeId);
                nlohmann::json exposedPinsJson = nlohmann::json::object();
                for (const auto& [pinId, exposed] : expansion.exposedPins) {
                    exposedPinsJson[pinId] = {{"instanceId", std::to_string(exposed.instanceId)}, {"pinId", exposed.pinId}};
                }
                resp.ok = true;
                resp.payloadJson = nlohmann::json{{"instanceId", std::to_string(expansion.subcircuitInstanceId)},
                                                   {"exposedPins", exposedPinsJson},
                                                   {"primaryMcuInstanceId",
                                                    expansion.primaryMcuInstanceId
                                                        ? nlohmann::json(std::to_string(*expansion.primaryMcuInstanceId))
                                                        : nlohmann::json(nullptr)}}
                                        .dump();
            } else {
                const uint32_t instanceId = session.addComponent(typeId, params);
                resp.ok = true;
                resp.payloadJson = nlohmann::json{{"instanceId", std::to_string(instanceId)}}.dump();
            }
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("addComponent falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "setProperty") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string name = payload.value("name", std::string{});
            const std::optional<PropertySchema> schema = session.propertySchemaOf(instanceId, name);
            const std::optional<std::string> error =
                session.setProperty(instanceId, name, jsonToPropertyValue(payload.at("value")));

            if (error) {
                const ParsedPropertyError parsed = parsePropertyError(*error);
                resp.ok = false;
                resp.error = parsed.message;
                resp.payloadJson = nlohmann::json{{"errorCode", parsed.code}}.dump();
            } else {
                resp.ok = true;
                if (schema && (schema->flags & PropertySchemaRequiresRestart) != 0) {
                    resp.payloadJson = nlohmann::json{{"requiresRestart", true}}.dump();
                }
            }
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("setProperty falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "setSubcircuitChildProperty") {
        // Overlay de Modo Placa no circuito principal -- edita uma propriedade de um componente
        // DENTRO de um subcircuito (ex: "button_en") endereçando por id local em vez do índice Core
        // (que a Extension não conhece pra filhos de subcircuito, só pra instâncias de topo, ver
        // `coreInstanceIdByComponentId` em extension.ts). Mesmo formato de resposta de "setProperty".
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t outerInstanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string localId = payload.value("localId", std::string{});
            const std::string name = payload.value("name", std::string{});
            const std::optional<uint32_t> childIndex = session.findSubcircuitChildByLocalId(outerInstanceId, localId);
            if (!childIndex) {
                resp.ok = false;
                resp.error = "setSubcircuitChildProperty: componente interno '" + localId + "' não encontrado";
                return resp;
            }
            const std::optional<std::string> error =
                session.setProperty(*childIndex, name, jsonToPropertyValue(payload.at("value")));
            if (error) {
                const ParsedPropertyError parsed = parsePropertyError(*error);
                resp.ok = false;
                resp.error = parsed.message;
                resp.payloadJson = nlohmann::json{{"errorCode", parsed.code}}.dump();
            } else {
                resp.ok = true;
            }
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("setSubcircuitChildProperty falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "getSubcircuitChildInstanceId") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t outerInstanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string localId = payload.value("localId", std::string{});
            const std::optional<uint32_t> childIndex = session.findSubcircuitChildByLocalId(outerInstanceId, localId);
            if (!childIndex) {
                resp.ok = false;
                resp.error = "getSubcircuitChildInstanceId: componente interno '" + localId + "' não encontrado";
                return resp;
            }
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"instanceId", std::to_string(*childIndex)}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getSubcircuitChildInstanceId falhou: ") + e.what();
        }
        return resp;
    }
    // Renomeia um túnel e atualiza a topologia do Netlist (grupo de túnel). Não pode passar pelo
    // caminho genérico de setProperty (que só re-stampa sem rebuildar topologia). Ver Tunnel.hpp e
    // SimulationSession::setTunnelName. Payload: { instanceId, pinId, oldName, newName }.
    if (msg.type == "setTunnelName") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string pinId = payload.value("pinId", std::string{});
            const std::string oldName = payload.value("oldName", std::string{});
            const std::string newName = payload.value("newName", std::string{});
            session.setTunnelName(instanceId, pinId, oldName, newName);
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("setTunnelName falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "removeComponent") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            if (session.isSubcircuitInstance(instanceId)) {
                session.removeSubcircuitInstance(instanceId); // cascata -- seção 5.4
            } else {
                session.removeComponent(instanceId);
            }
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("removeComponent falhou: ") + e.what();
        }
        return resp;
    }
    // Leitura genérica do estado opaco de QUALQUER instância (built-in ou plugin) — mecanismo único
    // de "ler de volta" um valor calculado, em vez de um verbo por tipo de componente (ver
    // .spec/lasecsimul.spec sobre instrumentos como plugin ABI). Quem decide o que os bytes
    // significam é o chamador (ex: a Extension sabe que "instruments.voltmeter" devolve 8 bytes =
    // 1 double). Mesma ressalva de concorrência que já existe hoje para addComponent/setProperty/
    // connectWire/removeComponent enquanto a simulação está rodando: lido na thread de IPC enquanto
    // o Scheduler pode estar mutando o mesmo IComponentModel na thread dele, sem mutex entre as
    // duas — não introduzido por este handler, ver docs/mvp-limitacoes.md.
    if (msg.type == "getComponentState") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::vector<uint8_t> state = session.getComponentState(instanceId);
            static const char kHexDigits[] = "0123456789abcdef";
            std::string hex;
            hex.reserve(state.size() * 2);
            for (uint8_t byte : state) {
                hex.push_back(kHexDigits[(byte >> 4) & 0xF]);
                hex.push_back(kHexDigits[byte & 0xF]);
            }
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"stateHex", hex}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getComponentState falhou: ") + e.what();
        }
        return resp;
    }
    // Saúde operacional (watchdog/CrashGuard) de uma instância -- visibilidade pra Extension
    // decidir se avisa o usuário (.spec/lasecsimul-native-devices.spec seção 13). Só leitura.
    if (msg.type == "getComponentHealth") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const PluginHealthStatus health = session.componentHealth(instanceId);
            const char* statusStr = health == PluginHealthStatus::Faulted ? "faulted"
                                     : health == PluginHealthStatus::Lagging ? "lagging"
                                                                              : "ok";
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"status", statusStr}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getComponentHealth falhou: ") + e.what();
        }
        return resp;
    }

    // Leitura de corrente (opção 1 do plano de baixo custo: sem incógnita nova na matriz, lida sob
    // demanda do estado cacheado na última stamp() de cada componente -- ver
    // IComponentModel::current()/SimulationSession::componentCurrent). "hasCurrent": false quando o
    // componente não implementa isso (Ground, Tunnel, etc.) -- nunca erro, a Extension decide se
    // esconde o valor.
    if (msg.type == "getComponentCurrent") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::optional<double> current = session.componentCurrent(instanceId);
            resp.ok = true;
            resp.payloadJson = current
                ? nlohmann::json{{"hasCurrent", true}, {"current", *current}}.dump()
                : nlohmann::json{{"hasCurrent", false}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getComponentCurrent falhou: ") + e.what();
        }
        return resp;
    }

    if (msg.type == "sendComponentEvent") {
        try {
            const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson.empty() ? "{}" : msg.payloadJson);
            const uint32_t instanceId = std::stoul(payload.value("instanceId", "0"));
            ComponentEvent event;
            event.tag = payload.value("tag", 0u);
            event.a = payload.value("a", 0u);
            event.b = payload.value("b", 0u);
            event.c = payload.value("c", 0u);
            session.sendComponentEvent(instanceId, event);
            resp.ok = true;
            resp.payloadJson = R"({"delivered":true})";
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("sendComponentEvent falhou: ") + e.what();
        }
        return resp;
    }
    // Tensão atual do nó ao qual o pino `pinId` da instância `instanceId` está resolvido -- usado
    // pela Extension pra colorir/animar fios na Webview (vermelho/azul conforme tensão, ver
    // SimulIDE ConnectorLine::paint) sem precisar que cada fio seja "lido" via um instrumento. Só
    // leitura (nunca muda topologia/estado) — mesma ressalva de concorrência de getComponentState.
    if (msg.type == "getNodeVoltage") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string pinId = payload.value("pinId", std::string{});
            const double voltage = session.nodeVoltageOfPin(instanceId, pinId);
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"voltage", voltage}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getNodeVoltage falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "loadMcuFirmware") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            const std::string firmwarePath = payload.value("firmwarePath", std::string{});
            const std::string qemuBinaryOverride = payload.value("qemuBinaryOverride", std::string{});
            if (firmwarePath.empty()) throw std::runtime_error("caminho do firmware vazio");
            const std::string arenaName = "lasecsimul-mcu-" + std::to_string(instanceId);
            session.loadMcuFirmware(instanceId, firmwarePath, arenaName, qemuBinaryOverride);
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("loadMcuFirmware falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "getMcuLogs") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.value("instanceId", std::string{"0"})));
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"logs", session.mcuLogs(instanceId)}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getMcuLogs falhou: ") + e.what();
        }
        return resp;
    }
    // Schema de propriedades por typeId (grupo/editor/min/max/opções/flags) — built-in (registrado em
    // registerBuiltinComponents) OU plugin (registrado por loadDeviceLibraryFile a partir do
    // .lsdevice) — `ComponentMetadataRegistry` é a MESMA fonte pros dois, sem distinção aqui. Só
    // leitura, sem payload de entrada; devolve tudo que já está registrado neste momento (chamar de
    // novo depois de um loadDeviceLibrary pega os typeIds novos também).
    if (msg.type == "getPropertySchemas") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            // Sem "language" no payload (ou igual à língua-base de cada componente): devolve tudo na
            // língua-base de cada um, idêntico ao comportamento de antes desta resolução existir --
            // "language" é só um pedido de tradução, nunca obrigatório (ver lasecsimul.spec seção 6.3.3).
            const std::string requestedLanguage = payload.value("language", std::string{});
            nlohmann::json schemasByTypeId = nlohmann::json::object();
            // ABI v2 (.spec/lasecsimul-native-devices.spec) -- mapas IRMÃOS, ADITIVOS, não um campo a
            // mais dentro de schemasByTypeId[typeId]: manter schemasByTypeId[typeId] como array puro
            // preserva 100% de compatibilidade de wire com todo consumidor existente da Extension
            // (lê só o array de propertySchema); readoutFormatByTypeId/interactionKindByTypeId só
            // aparecem pra quem o device declarou, e consumidor antigo simplesmente ignora as chaves
            // novas do payload.
            nlohmann::json readoutFormatByTypeId = nlohmann::json::object();
            nlohmann::json interactionKindByTypeId = nlohmann::json::object();
            for (const auto& [typeId, meta] : pluginCache.metadata().all()) {
                const std::vector<PropertySchema> resolved = resolvePropertySchemaForLanguage(meta, requestedLanguage);
                nlohmann::json schemas = nlohmann::json::array();
                for (const PropertySchema& schema : resolved) {
                    schemas.push_back(propertySchemaToJson(schema));
                }
                schemasByTypeId[typeId] = std::move(schemas);
                if (meta.readoutFormat) readoutFormatByTypeId[typeId] = readoutFormatToJson(*meta.readoutFormat);
                if (meta.interactionKind) interactionKindByTypeId[typeId] = interactionKindToJson(*meta.interactionKind);
            }
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"schemasByTypeId", schemasByTypeId},
                                               {"readoutFormatByTypeId", readoutFormatByTypeId},
                                               {"interactionKindByTypeId", interactionKindByTypeId}}
                                    .dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getPropertySchemas falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "loadDeviceLibrary") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const std::string libraryPath = payload.value("path", std::string{});
            loadDeviceLibraryFile(libraryPath, pluginCache);
            loadMcuLibraryFile(libraryPath, pluginCache);
            loadSubcircuitLibraryFile(libraryPath, session.subcircuits());
            // Reaplica: registra factory pra qualquer typeId que ficou ativo agora (chamar de novo
            // é idempotente — só reatribui no map, ver ComponentRegistry::registerFactory).
            session.registerKnownPluginTypes();
            session.registerKnownMcuTypes();
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("loadDeviceLibrary falhou: ") + e.what();
        }
        return resp;
    }
    // Registra UM `.lssubcircuit` avulso direto, sem exigir um `library.json` -- usado pelo bloco
    // genérico de subcircuito por caminho (Extension escolhe um arquivo numa propriedade; aqui só
    // registra a definição, `addComponent` com esse typeId continua sendo o mesmo caminho de sempre,
    // ver `.spec/lasecsimul-subcircuits.spec` seção 12). Payload: `{path: string}`.
    if (msg.type == "registerAdhocSubcircuit") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const std::string manifestPath = payload.value("path", std::string{});
            const bool replace = payload.value("replace", false);
            if (manifestPath.empty()) throw std::runtime_error("payload sem 'path'");
            const RegisteredSubcircuitInfo info =
                registerSubcircuitFromManifestRich(manifestPath, session.subcircuits(), {}, replace);
            resp.ok = true;
            resp.payloadJson = info.payload.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("registerAdhocSubcircuit falhou: ") + e.what();
        }
        return resp;
    }
    // Configura parâmetros operacionais do Scheduler em runtime. Payload (todos opcionais):
    // { targetStepUs: number, maxNonLinearIterations: number }
    // targetStepUs=0: sem throttle (default). maxNonLinearIterations=0: ilimitado (default).
    if (msg.type == "setSimulationConfig") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            if (payload.contains("targetStepUs") && payload["targetStepUs"].is_number())
                session.scheduler().setTargetStepUs(payload["targetStepUs"].get<uint64_t>());
            if (payload.contains("maxNonLinearIterations") && payload["maxNonLinearIterations"].is_number())
                session.scheduler().setMaxNonLinearIterations(static_cast<size_t>(payload["maxNonLinearIterations"].get<uint64_t>()));
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("setSimulationConfig falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "connectWire") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const uint32_t componentA = static_cast<uint32_t>(std::stoul(payload.value("componentA", std::string{"0"})));
            const uint32_t componentB = static_cast<uint32_t>(std::stoul(payload.value("componentB", std::string{"0"})));
            session.connectWire(componentA, payload.value("pinIdA", std::string{}), componentB,
                                 payload.value("pinIdB", std::string{}));
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("connectWire falhou: ") + e.what();
        }
        return resp;
    }

    // ── mensagem desconhecida ──────────────────────────────────────────────────
    resp.ok = false;
    resp.error = "tipo de mensagem desconhecido: " + msg.type;
    return resp;
}

} // namespace

// ── CoreApplication ────────────────────────────────────────────────────────────

CoreApplication::CoreApplication(CoreConfig config)
    : m_impl(std::make_unique<Impl>(std::move(config))) {
    registerBuiltinComponents(m_impl->session.components(), m_impl->pluginCache.metadata(), m_impl->session.scheduler());
    m_impl->session.registerKnownPluginTypes();
    m_impl->session.registerKnownMcuTypes();

    m_impl->ipcServer.setMessageHandler([this](const IncomingMessage& msg) {
        return handleMessage(msg, m_impl->session, m_impl->ipcServer, m_impl->pluginCache);
    });
}

CoreApplication::~CoreApplication() = default;

int CoreApplication::run() {
    std::fprintf(stderr, "[Core] IPC escutando em '%s'\n", m_impl->config.pipeName.c_str());
    return m_impl->ipcServer.run();
}

// ── parsing de argumentos ──────────────────────────────────────────────────────

CoreConfig parseArgs(int argc, char** argv) {
    CoreConfig cfg;
    for (int i = 1; i < argc - 1; ++i) {
        if (std::strcmp(argv[i], "--pipe") == 0) {
            cfg.pipeName = argv[i + 1];
            return cfg;
        }
    }
    std::fprintf(stderr, "Uso: lasecsimul-core --pipe <nome-do-pipe>\n");
    std::exit(1);
}

} // namespace lasecsimul::app
