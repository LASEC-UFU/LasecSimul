#include "CoreApplication.hpp"
#include <algorithm>
#include "../ipc/IpcServer.hpp"
#include "../ipc/Protocol.hpp"
#include "../plugins/GlobalPluginCache.hpp"
#include "../registry/PropertyJson.hpp"
#include "../registry/SubcircuitRegistry.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "../session/SimulationSession.hpp"
#include "../components/SimulideBuiltins.hpp"
#include "../components/active/Diode.hpp"
#include "../components/active/OpAmp.hpp"
#include "../components/active/AnalogMux.hpp"
#include "../components/active/DiodeLegArray.hpp"
#include "../components/passive/ResistorArray.hpp"
#include "../components/switches/Keypad.hpp"
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
 * mesma usada por plugins via `GlobalPluginCache::loadLibrary`) de um typeId num só lugar, pra nunca ficar
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
                    std::optional<InteractionKind> interactionKind = std::nullopt,
                    std::vector<std::string> canonicalPinIds = {}) {
            registry::ComponentMetadata meta;
            meta.typeId = std::move(typeId);
            meta.displayName = std::move(displayName);
            meta.propertySchema = std::move(propertySchema);
            meta.language = "pt-BR";
            meta.translationsJson = std::move(translationsJson);
            meta.readoutFormat = std::move(readoutFormat);
            meta.interactionKind = std::move(interactionKind);
            // Mesmos ids canônicos que a factory acima usa como fallback quando o chamador não
            // manda pino explícito (`pos[N].id.empty() ? "..." : pos[N].id`) -- ABI v2 expõe isso
            // pra `getPropertySchemas` (`pinIdsByTypeId`) em vez da Extension manter uma 2ª cópia
            // hardcoded do mesmo dado (ver .spec/lasecsimul-native-devices.spec).
            for (const std::string& pinId : canonicalPinIds) meta.pins.push_back(Pin{pinId, 0.0, 0.0});
            metadata.registerMetadata(std::move(meta));
        };
    reg.registerFactory("passive.resistor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        // `propertyOrDefault` (não `p.property()`) -- valida contra o schema antes de aceitar (achado
        // de auditoria arquitetural 2026-07-09, D4): um valor salvo fora de faixa/tipo errado cai no
        // default com log em vez de ser aplicado sem checagem nenhuma.
        const double resistance = std::get<double>(propertyOrDefault(p.properties, components::Resistor::propertySchema().front()));
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            resistance);
    });
    registerBuiltinMetadata(
        "passive.resistor",
        "Resistor",
        components::Resistor::propertySchema(),
        R"json({"en":{"name":"Resistor","properties":{"resistance":{"label":"Resistance","group":"Electrical"}}}})json",
        std::nullopt, std::nullopt, std::vector<std::string>{"p1", "p2"});

    reg.registerFactory("passive.capacitor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const double capacitance = std::get<double>(propertyOrDefault(p.properties, components::Capacitor::propertySchema().front()));
        return std::make_unique<components::Capacitor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            capacitance);
    });
    registerBuiltinMetadata(
        "passive.capacitor",
        "Capacitor",
        components::Capacitor::propertySchema(),
        R"json({"en":{"name":"Capacitor","properties":{"capacitance":{"label":"Capacitance","group":"Electrical"}}}})json");

    reg.registerFactory("passive.inductor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const double inductance = std::get<double>(propertyOrDefault(p.properties, components::Inductor::propertySchema().front()));
        return std::make_unique<components::Inductor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            inductance);
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
        R"json({"en":{"name":"Tunnel"}})json",
        std::nullopt, std::nullopt, std::vector<std::string>{"pin"});

    reg.registerFactory("connectors.bus", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        std::vector<Pin> pins{Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y}};
        return std::make_unique<components::SimulidePassiveState>("connectors.bus", std::move(pins), std::vector<PropertySchema>{});
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
        R"json({"en":{"name":"Ground (0 V)"}})json",
        std::nullopt, std::nullopt, std::vector<std::string>{"pin"});

    reg.registerFactory("sources.dc_voltage", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const double voltage = std::get<double>(propertyOrDefault(p.properties, components::DcVoltageSource::propertySchema().front()));
        return std::make_unique<components::DcVoltageSource>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            voltage);
    });
    registerBuiltinMetadata(
        "sources.dc_voltage",
        "Fonte de Tensão",
        components::DcVoltageSource::propertySchema(),
        R"json({"en":{"name":"DC Voltage Source","properties":{"voltage":{"label":"Voltage","group":"Electrical"}}}})json");

    reg.registerFactory("active.diode", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const double saturationCurrent = std::get<double>(propertyOrDefault(p.properties, components::Diode::propertySchema().front()));
        return std::make_unique<components::Diode>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "anode" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "cathode" : pos[1].id, pos[1].x, pos[1].y}},
            saturationCurrent);
    });
    registerBuiltinMetadata(
        "active.diode",
        "Diodo",
        components::Diode::propertySchema(),
        R"json({"en":{"name":"Diode","properties":{"saturationCurrent":{"label":"Saturation Current","group":"Electrical"}}}})json");

    reg.registerFactory("logic.button", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const bool pressed = std::get<bool>(propertyOrDefault(p.properties, components::Button::propertySchema().front()));
        return std::make_unique<components::Button>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            pressed);
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
        reg.registerFactory(typeId, [&, typeId, schema](const ComponentParams& p) {
            const double resistance = std::get<double>(propertyOrDefault(p.properties, schema.front()));
            return std::make_unique<components::SimulideTwoPinResistor>(typeId, makePins2(p), resistance, schema);
        });
        registerBuiltinMetadata(typeId, label, schema, englishName(label));
    };
    registerResistorLike("passive.variable_resistor", "Variable Resistor", 10000.0);
    // `passive.ldr`/`thermistor`/`rtd`/`force_strain_gauge` REMOVIDOS (achado de auditoria
    // 2026-07-08): eram resistores estáticos disfarçados (`SimulideTwoPinResistor`, sem NENHUMA
    // resposta a luz/temperatura/força -- eletricamente indistinguível de um `passive.resistor`
    // comum), catalogados em "Passivos > Resistive Sensors", DUPLICANDO os sensores REAIS
    // (`sensors.ldr`/`thermistor`/`rtd`/`strain`, física de verdade em `devices/simulide-sensors/
    // src/lib.c`, catalogados em "Sensores") sob um nome/pasta diferente -- um usuário pegando "LDR"
    // pela pasta óbvia ("Passivos") ganhava o componente ERRADO, sem aviso nenhum. Fonte única de
    // verdade agora: só `sensors.*` (ver `component-catalog.json`, entradas correspondentes também
    // removidas).

    // DIP de 8 resistores independentes (`ResistorArray`, não `SimulideTwoPinResistor`) -- achado de
    // auditoria 2026-07-08: só os 2 primeiros dos 16 pinos declarados no `package` eram
    // eletricamente reais, os outros 14 ficavam flutuando (topologia errada, não só simplificação).
    // Resistência ÚNICA compartilhada por todos os 8 pares, igual ao `resistordip.cpp` real
    // (`for (eResistor* res : m_resistor) res->setResistance(m_resistance)`, default 100Ω real).
    // Redimensionamento dinâmico e modo "Pullup" (barramento) do original NÃO implementados aqui --
    // fora de escopo desta correção, catálogo atual declara os 16 pinos como fixos.
    reg.registerFactory("passive.resistor_dip", [](const ComponentParams& p) {
        const double resistance = std::get<double>(propertyOrDefault(p.properties, components::ResistorArray::propertySchema(100.0).front()));
        return std::make_unique<components::ResistorArray>("passive.resistor_dip", makePinVector(p, 16), resistance);
    });
    registerBuiltinMetadata("passive.resistor_dip", "ResistorDip", components::ResistorArray::propertySchema(100.0),
                            englishName("ResistorDip"));

    reg.registerFactory("passive.potentiometer", [&](const ComponentParams& p) {
        const std::vector<PropertySchema> schemas = components::SimulidePotentiometer::propertySchema();
        const double resistance = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "resistance")));
        const double position = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "position")));
        return std::make_unique<components::SimulidePotentiometer>("passive.potentiometer", makePins3(p), resistance, position);
    });
    registerBuiltinMetadata("passive.potentiometer", "Potentiometer", components::SimulidePotentiometer::propertySchema(),
                            englishName("Potentiometer"));

    reg.registerFactory("passive.electrolytic_capacitor", [&](const ComponentParams& p) {
        const double capacitance = std::get<double>(propertyOrDefault(p.properties, components::Capacitor::propertySchema().front()));
        return std::make_unique<components::Capacitor>(makePins2(p), capacitance);
    });
    registerBuiltinMetadata("passive.electrolytic_capacitor", "Electrolytic Capacitor",
                            components::Capacitor::propertySchema(), englishName("Electrolytic Capacitor"));
    reg.registerFactory("passive.variable_capacitor", [&](const ComponentParams& p) {
        const double capacitance = std::get<double>(propertyOrDefault(p.properties, components::Capacitor::propertySchema().front()));
        return std::make_unique<components::Capacitor>(makePins2(p), capacitance);
    });
    registerBuiltinMetadata("passive.variable_capacitor", "Variable Capacitor", components::Capacitor::propertySchema(),
                            englishName("Variable Capacitor"));
    reg.registerFactory("passive.variable_inductor", [&](const ComponentParams& p) {
        const double inductance = std::get<double>(propertyOrDefault(p.properties, components::Inductor::propertySchema().front()));
        return std::make_unique<components::Inductor>(makePins2(p), inductance);
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
            // Schema COMPLETO (5 campos) usado como contrato de construção pra QUALQUER typeId --
            // `propertySchemaFor(typeId)` (usado só pra metadata/UI) devolve um subconjunto pra
            // switch/switch_dip (só closed/normallyClosed); `SimulideSwitch::SimulideSwitch()` sempre
            // aceita os 5 parâmetros, então validar contra o subconjunto quebraria
            // (`schemaById` cairia no fallback string-typed pra doubleThrow/poles/key nesse caso).
            const std::vector<PropertySchema> schemas = components::SimulideSwitch::pushPropertySchema();
            std::string key;
            if (const auto it = p.properties.find("key"); it != p.properties.end()) {
                if (const std::string* value = std::get_if<std::string>(&it->second)) key = *value;
            }
            const bool closed = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "closed")));
            const bool normallyClosed = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "normallyClosed")));
            const bool doubleThrow = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "doubleThrow")));
            const double poles = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "poles")));
            return std::make_unique<components::SimulideSwitch>(
                typeId, makePinVector(p, pinCount), closed, normallyClosed, doubleThrow, poles, std::move(key));
        });
        registerBuiltinMetadata(typeId, label, components::SimulideSwitch::propertySchemaFor(typeId),
                                englishName(label), std::nullopt,
                                components::SimulideSwitch::interactionKindFor(typeId));
    };
    registerSwitchLike("switches.push", "Push", 2);
    registerSwitchLike("switches.switch", "Switch (all)", 2);
    registerSwitchLike("switches.switch_dip", "Switch Dip", 16);

    reg.registerFactory("switches.relay", [&](const ComponentParams& p) {
        const std::vector<PropertySchema> schemas = components::SimulideRelay::propertySchema();
        const double iOn = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "iOn")));
        const double iOff = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "iOff")));
        const bool normallyClosed = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "normallyClosed")));
        return std::make_unique<components::SimulideRelay>(makePinVector(p, 4), iOn, iOff, normallyClosed);
    });
    registerBuiltinMetadata("switches.relay", "Relay (all)", components::SimulideRelay::propertySchema(),
                            englishName("Relay (all)"));

    // Limite de 8 rows/8 columns (16 pinos no máximo) -- mesma ordem de grandeza do maior builtin de
    // pino fixo já existente (`switches.switch_dip`, 16 pinos). Sem isto `rows`/`columns` seriam
    // ilimitados (`numberSchema` só tinha `minValue` até esta mudança) e o pino sintético que
    // `makePinVector` cria pra preencher o que faltar (`Pin{}`, sem id/posição reais) apareceria como
    // pino "fantasma" sem conexão elétrica real -- TR-9.
    std::vector<PropertySchema> keypadSchema{
        components::detail::boolSchema("diodes", "Diodos", false),
        components::detail::boolSchema("diodesDirection", "Direcao dos Diodos", false),
        components::detail::numberSchema("rows", "Linhas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
        components::detail::numberSchema("columns", "Colunas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
        components::detail::textSchema("keyLabels", "Rotulos", "123A456B789C*0#D"),
        // Estado de tecla pressionada (bitmask, bit `row*columns+col`) -- substitui o clique
        // interativo do mouse por tecla que o SimulIDE real tem (fora de escopo aqui, exigiria UI +
        // IPC novos); a matriz elétrica em si (`components::Keypad`) é real, só a FONTE do estado é
        // uma propriedade em vez de um clique -- ver achado de auditoria 2026-07-08.
        components::detail::numberSchema("pressedMask", "Teclas Pressionadas (bitmask)", "", 0.0, 0.0, 1.0)};
    // keypad.cpp real: addPropGroup({tr("Main"), {diodes, direction, rows, cols, keyLabels}, 0}) --
    // as 5 propriedades ficam no MESMO grupo/aba. numberSchema/boolSchema/textSchema tem grupo
    // default diferente cada (Eletrica/Eletrica/Geral) porque isso é o correto pra maioria dos
    // devices -- aqui precisa sobrescrever igual `pushPropertySchema()` faz, senão "Rotulos das
    // teclas" cai numa aba/seção separada de "Linhas"/"Colunas" na Webview (bug relatado: usuário
    // via os campos numéricos mas achava que faltava o campo de rótulos).
    for (PropertySchema& schema : keypadSchema) schema.group = "Principal";
    // Pinos = rows+columns, igual ao `keypad.cpp` real do SimulIDE (`m_pin[m_rows+col]`, matriz de
    // varredura -- nunca rows*columns). Dado declarado (`ComponentPinSpec`), não fórmula escrita à
    // mão -- `SimulidePassiveState` resolve isto na criação E a cada edição de `rows`/`columns`
    // (`PropertySchemaAffectsPinCount`), via `resolveDynamicPins` (único intérprete do projeto).
    const ComponentPinSpec keypadPinSpec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};
    // `stamp()` real (matriz linha/coluna real, ver `components::Keypad`) -- antes usava
    // `SimulidePassiveState` (no-op puro), apertar tecla nunca fazia nada eletricamente (achado de
    // auditoria 2026-07-08).
    reg.registerFactory("switches.keypad", [keypadPinSpec, keypadSchema](const ComponentParams& p) {
        const size_t rows = static_cast<size_t>(
            std::max(1.0, std::get<double>(propertyOrDefault(p.properties, schemaById(keypadSchema, "rows")))));
        const size_t columns = static_cast<size_t>(
            std::max(1.0, std::get<double>(propertyOrDefault(p.properties, schemaById(keypadSchema, "columns")))));
        const bool diodes = std::get<bool>(propertyOrDefault(p.properties, schemaById(keypadSchema, "diodes")));
        const bool diodesDirection =
            std::get<bool>(propertyOrDefault(p.properties, schemaById(keypadSchema, "diodesDirection")));
        const double pressedMask =
            std::get<double>(propertyOrDefault(p.properties, schemaById(keypadSchema, "pressedMask")));
        std::vector<Pin> pins = resolveDynamicPins(keypadPinSpec, p.properties);
        return std::make_unique<components::Keypad>(std::move(pins), rows, columns, diodes, diodesDirection, pressedMask);
    });
    registerBuiltinMetadata("switches.keypad", "KeyPad", keypadSchema, englishName("KeyPad"));

    const auto registerDiodeLike = [&](const std::string& typeId, const std::string& label, double threshold) {
        reg.registerFactory(typeId, [&, typeId, threshold](const ComponentParams& p) {
            const std::vector<PropertySchema> schemas = components::SimulideDiodeLike::propertySchema(threshold, 1.0);
            const double thresholdValue = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "threshold")));
            const double resistance = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "resistance")));
            return std::make_unique<components::SimulideDiodeLike>(typeId, makePins2(p), thresholdValue, resistance);
        });
        registerBuiltinMetadata(typeId, label, components::SimulideDiodeLike::propertySchema(threshold, 1.0),
                                englishName(label));
    };
    // "active.diac"/"active.scr"/"active.triac" (e mais abaixo "active.bjt"/"mosfet"/"jfet"):
    // registro built-in aqui é CONFIRMADAMENTE código morto em produção -- `devices/simulide-complex`
    // (KIND_DIAC/SCR/TRIAC/BJT/MOSFET/JFET em `lib.c`) registra os MESMOS typeIds via
    // `SimulationSession::registerKnownPluginTypes()`, chamado DEPOIS de `registerBuiltinComponents`
    // (ver App::activate() abaixo) usando `ComponentRegistry::replaceFactory` -- o plugin sempre
    // vence quando carregado. Mantido como fallback (nunca exercitado se o plugin carrega) --
    // não vale a pena portar Shockley/ruptura pra estes (built-in E plugin usam o mesmo modelo
    // simplificado on/off hoje; consertar de verdade exigiria mexer no `lib.c` do plugin, que é
    // quem manda). Ver .spec/lasecsimul.spec seção 7.4 e memória do projeto.
    registerDiodeLike("active.diac", "Diac", 30.0);
    registerDiodeLike("active.scr", "SCR", 0.8);
    registerDiodeLike("active.triac", "Triac", 0.8);

    // Zener: reaproveita a MESMA classe `Diode` (Shockley + Newton amortecido REAL,
    // `hasConverged()` genuíno) de `active.diode` -- não a `SimulideDiodeLike` simplificada de
    // cima, que sequer modelava ruptura reversa (só um limiar direto de 5.1V, fisicamente errado
    // pra um zener: o comportamento útil de um zener é a ruptura REVERSA, não um joelho direto
    // alto). `supportsBreakdown=true` expõe a propriedade `breakdownVoltage` editável (default
    // 5.1V, igual ao valor antigo -- só a FÍSICA por trás mudou).
    reg.registerFactory("active.zener", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        const std::vector<PropertySchema> schemas = components::Diode::propertySchema(true);
        const double saturationCurrent = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "saturationCurrent")));
        const double breakdownVoltage = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "breakdownVoltage")));
        return std::make_unique<components::Diode>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "anode" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "cathode" : pos[1].id, pos[1].x, pos[1].y}},
            saturationCurrent, 0.02585, breakdownVoltage, true);
    });
    registerBuiltinMetadata("active.zener", "Zener Diode", components::Diode::propertySchema(true),
                            englishName("Zener Diode"));

    const auto registerTransistorLike = [&](const std::string& typeId, const std::string& label, bool pnp) {
        reg.registerFactory(typeId, [&, typeId, pnp](const ComponentParams& p) {
            const double beta = std::get<double>(propertyOrDefault(p.properties, components::SimulideTransistorLike::propertySchema().front()));
            return std::make_unique<components::SimulideTransistorLike>(typeId, makePins3(p), beta, pnp);
        });
        registerBuiltinMetadata(typeId, label, components::SimulideTransistorLike::propertySchema(), englishName(label));
    };
    registerTransistorLike("active.bjt", "BJT", false);
    registerTransistorLike("active.mosfet", "Mosfet", false);
    registerTransistorLike("active.jfet", "Jfet", false);

    // OpAmp/Comparator: `stamp()` real (fonte controlada linearizada por round, ver
    // `components::OpAmp`) -- antes usavam `SimulidePassiveState`, cujo `stamp()` é um no-op puro
    // (`SimulideBuiltins.hpp`), ou seja, os dois ficavam eletricamente inertes (achado de auditoria
    // 2026-07-08). `powerPos`/`powerNeg` (pinos 4/5 do package) continuam declarados mas não
    // estampados (ver comentário em OpAmp.hpp).
    std::vector<PropertySchema> opAmpSchema{components::detail::numberSchema("gain", "Ganho", "", 100000.0, 1.0, 1000.0)};
    reg.registerFactory("active.opamp", [opAmpSchema](const ComponentParams& p) {
        const auto pos = makePinVector(p, 5);
        const double gain = std::get<double>(propertyOrDefault(p.properties, opAmpSchema.front()));
        return std::make_unique<components::OpAmp>(std::array<Pin, 5>{pos[0], pos[1], pos[2], pos[3], pos[4]}, gain);
    });
    registerBuiltinMetadata("active.opamp", "OpAmp", opAmpSchema, englishName("OpAmp"));
    // Comparador: mesma classe, ganho default bem mais alto (aproxima transição quase digital sem
    // precisar de um modelo de saturação de trilho separado -- ver OpAmp.hpp).
    std::vector<PropertySchema> comparatorSchema{
        components::detail::numberSchema("gain", "Ganho", "", 1e7, 1.0, 1000.0)};
    reg.registerFactory("active.comparator", [comparatorSchema](const ComponentParams& p) {
        const auto pos = makePinVector(p, 5);
        const double gain = std::get<double>(propertyOrDefault(p.properties, comparatorSchema.front()));
        return std::make_unique<components::OpAmp>(std::array<Pin, 5>{pos[0], pos[1], pos[2], pos[3], pos[4]}, gain);
    });
    registerBuiltinMetadata("active.comparator", "Comparator", comparatorSchema, englishName("Comparator"));

    // `mux_analog.cpp` real do SimulIDE: pinos = Z (saída) + enable + `addrBits` (linhas de
    // endereço) + `2^addrBits` (canais) -- default `addrBits=3` -> 8 canais (`setAddrBits(3)`).
    // Aqui "channels" é o Nº DE CANAIS diretamente (mais intuitivo que expor `addrBits` bruto na
    // UI) -- `addrBits` é DERIVADO via `Log2Ceil`, nunca um segundo campo editável. Default
    // corrigido pra 8.0 (igual ao SimulIDE real) -- o valor antigo (3.0) media "canais" contra um
    // pino fixo de 5, sem relação real com `addrBits`; 64 de teto é folga generosa (7 bits de
    // endereço, 73 pinos), não um limite físico conhecido do componente.
    // `stamp()` real (chaveamento resistivo real, ver `components::AnalogMux`) -- antes usava
    // `SimulidePassiveState` (no-op puro), ficando eletricamente inerte (achado de auditoria
    // 2026-07-08). Pinos dinâmicos continuam via `ComponentPinSpec`/`resolveDynamicPins`, agora
    // interpretados também pela classe elétrica (`AnalogMux::pinSpec()`), não só pra contagem.
    std::vector<PropertySchema> muxAnalogSchema{components::AnalogMux::schema()};
    reg.registerFactory("active.analog_mux", [muxAnalogSchema](const ComponentParams& p) {
        const double channels = std::get<double>(propertyOrDefault(p.properties, muxAnalogSchema.front()));
        std::vector<Pin> pins = resolveDynamicPins(components::AnalogMux::pinSpec(), p.properties);
        return std::make_unique<components::AnalogMux>(std::move(pins), channels);
    });
    registerBuiltinMetadata("active.analog_mux", "Analog Mux", muxAnalogSchema, englishName("Analog Mux"));

    reg.registerFactory("active.volt_regulator", [&](const ComponentParams& p) {
        const double voltage =
            std::get<double>(propertyOrDefault(p.properties, components::SimulideVoltageRegulator::propertySchema().front()));
        return std::make_unique<components::SimulideVoltageRegulator>(makePins3(p), voltage);
    });
    registerBuiltinMetadata("active.volt_regulator", "Volt. Regulator",
                            components::SimulideVoltageRegulator::propertySchema(), englishName("Volt. Regulator"));

    const auto registerOutputState = [&](const std::string& typeId, const std::string& label, size_t pinCount,
                                         std::vector<PropertySchema> schema,
                                         std::optional<ComponentPinSpec> pinSpec = std::nullopt) {
        reg.registerFactory(typeId, [&, typeId, pinCount, schema, pinSpec](const ComponentParams& p) {
            return std::make_unique<components::SimulidePassiveState>(typeId, makePinVector(p, pinCount), schema,
                                                                       p.properties, pinSpec);
        });
        registerBuiltinMetadata(typeId, label, schema, englishName(label));
    };
    // LED: mesma classe `Diode` real (não `SimulideDiodeLike`) que `active.zener` acima --
    // `saturationCurrent`/`thermalVoltage` iguais ao preset real "RGY Default" do SimulIDE
    // (`e-diode.cpp::getModels()`: satCurr=0.0932nA, emCoef=3.73 -> thermalVoltage efetivo =
    // emCoef*Vt = 3.73*0.025865 ≈ 0.0965V) -- dá o joelho de tensão bem mais alto que um diodo
    // comum (~1.8-2V vs ~0.6V), sem precisar de um parâmetro `emCoef` separado nesta classe (já
    // embutido em `thermalVoltage`). Sem ruptura reversa (LED não teria breakdown modelado aqui,
    // `supportsBreakdown=false`, igual ao preset "RGY Default" real, `brkDown=0`).
    reg.registerFactory("outputs.led", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        // `saturationCurrent` tem schema (validado via propertyOrDefault); `thermalVoltage` NUNCA
        // teve entrada em `Diode::propertySchema()` (não é editável na UI, só parâmetro de
        // construção) -- `p.property()` direto continua correto aqui, não há schema pra validar contra.
        const double saturationCurrent =
            std::get<double>(propertyOrDefault(p.properties, components::Diode::propertySchema().front()));
        return std::make_unique<components::Diode>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "anode" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "cathode" : pos[1].id, pos[1].x, pos[1].y}},
            saturationCurrent, p.property("thermalVoltage", 0.0965));
    });
    registerBuiltinMetadata("outputs.led", "Led", components::Diode::propertySchema(), englishName("Led"));
    // `stamp()` real (3 pernas de diodo reais, ver `components::DiodeLegArray`) -- antes usava
    // `SimulidePassiveState` (no-op), ficando eletricamente inerte (achado de auditoria 2026-07-08).
    // Pinos fixos `[R, G, B, C]` (ver `component-catalog.json`) -- `C` é CATODO comum (`ledrgb.cpp`
    // real, `setComCathode(true)` é o default), R/G/B são os 3 anodos. Modo "Common Anode" (bool
    // `CommonCathode=false` no original) não exposto como propriedade aqui -- fora de escopo,
    // documentado.
    reg.registerFactory("outputs.led_rgb", [](const ComponentParams& p) {
        std::vector<Pin> pins = makePinVector(p, 4);
        std::vector<components::DiodeLegArray::Leg> legs{{0, 3}, {1, 3}, {2, 3}};
        return std::make_unique<components::DiodeLegArray>("outputs.led_rgb", std::move(pins), std::move(legs));
    });
    registerBuiltinMetadata("outputs.led_rgb", "Led Rgb", {}, englishName("Led Rgb"));
    // `ledbar.cpp` real: `m_pin.resize(m_size*2)` -- par P/N por LED (`pinP`/`pinN`), nunca 1 pino
    // por LED. Dois grupos independentes na MESMA propriedade `size`, ids `pin-P1..PN`/`pin-N1..NN`
    // (ordem P1..PN,N1..NN -- difere da intercalação do SimulIDE real, P1,N1,P2,N2,..., mas o `id`
    // é opaco pro Core; quem intercala pra bater com o desenho é o `dynamicLayout` da Extension,
    // que é livre pra escolher a própria ordem contanto que os MESMOS ids apareçam dos dois lados).
    // `stamp()` real -- cada par P_i/N_i vira uma perna de diodo real (`DiodeLegArray`), anodo=P,
    // catodo=N (mesma convenção de `ledbar.cpp`: `eLed` entre par P/N por índice).
    {
        const ComponentPinSpec ledBarPinSpec{{}, {{"pin-P", "size"}, {"pin-N", "size"}}};
        std::vector<PropertySchema> ledBarSchema{components::detail::numberSchema(
            "size", "Tamanho", "Leds", 8.0, 1.0, 1.0, PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 32.0)};
        reg.registerFactory("outputs.led_bar", [ledBarPinSpec](const ComponentParams& p) {
            std::vector<Pin> pins = resolveDynamicPins(ledBarPinSpec, p.properties);
            const size_t size = pins.size() / 2;
            std::vector<components::DiodeLegArray::Leg> legs;
            legs.reserve(size);
            for (size_t i = 0; i < size; ++i) legs.push_back({i, size + i});
            return std::make_unique<components::DiodeLegArray>("outputs.led_bar", std::move(pins), std::move(legs));
        });
        registerBuiltinMetadata("outputs.led_bar", "Led Bar", ledBarSchema, englishName("Led Bar"));
    }
    // `ledmatrix.cpp` real: `m_pin[row]`/`m_pin[m_rows+col]` -- MESMA fórmula do `switches.keypad`
    // (rows+columns, nunca rows*columns). `stamp()` real: 1 perna de diodo por INTERSEÇÃO
    // linha×coluna (`rows*columns` pernas, `getEpin(0)`=linha/anodo, `getEpin(1)`=coluna/catodo,
    // mesma convenção de `ledmatrix.cpp:87-88`), nunca uma perna por pino.
    {
        const ComponentPinSpec ledMatrixPinSpec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};
        std::vector<PropertySchema> ledMatrixSchema{
            components::detail::numberSchema("rows", "Linhas", "Leds", 8.0, 1.0, 1.0,
                                             PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 16.0),
            components::detail::numberSchema("columns", "Colunas", "Leds", 8.0, 1.0, 1.0,
                                             PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 16.0)};
        reg.registerFactory("outputs.led_matrix", [ledMatrixPinSpec, ledMatrixSchema](const ComponentParams& p) {
            const size_t rows = static_cast<size_t>(
                std::max(0.0, std::get<double>(propertyOrDefault(p.properties, schemaById(ledMatrixSchema, "rows")))));
            std::vector<Pin> pins = resolveDynamicPins(ledMatrixPinSpec, p.properties);
            const size_t columns = pins.size() >= rows ? pins.size() - rows : 0;
            std::vector<components::DiodeLegArray::Leg> legs;
            legs.reserve(rows * columns);
            for (size_t row = 0; row < rows; ++row)
                for (size_t col = 0; col < columns; ++col) legs.push_back({row, rows + col});
            return std::make_unique<components::DiodeLegArray>("outputs.led_matrix", std::move(pins), std::move(legs));
        });
        registerBuiltinMetadata("outputs.led_matrix", "LedMatrix", ledMatrixSchema, englishName("LedMatrix"));
    }
    registerOutputState("outputs.max72xx_matrix", "Max72xx matrix", 5,
                        {components::detail::numberSchema("rows", "Linhas", "Leds", 8.0, 1.0, 1.0),
                         components::detail::numberSchema("columns", "Colunas", "Leds", 8.0, 1.0, 1.0)});
    registerOutputState("outputs.ws2812", "WS2812 Led", 3,
                        {components::detail::numberSchema("rows", "Linhas", "Leds", 1.0, 1.0, 1.0),
                         components::detail::numberSchema("columns", "Colunas", "Leds", 1.0, 1.0, 1.0)});
    // `stamp()` real -- 8 pernas de diodo (a-g + ponto decimal, `pin-1..pin-8`), catodo comum
    // (`pin-9`/`pin-10`, os DOIS pinos comuns do package -- unidos entre si por uma condutância
    // alta, `shortedPairs`, porque no hardware real são o MESMO net exposto duas vezes pra solda,
    // ver `sevensegment.cpp` real). Antes eletricamente inerte (`SimulidePassiveState`, achado de
    // auditoria 2026-07-08).
    reg.registerFactory("outputs.seven_segment", [](const ComponentParams& p) {
        std::vector<Pin> pins = makePinVector(p, 10);
        std::vector<components::DiodeLegArray::Leg> legs;
        for (size_t i = 0; i < 8; ++i) legs.push_back({i, 8}); // segmentos a-g + ponto -> commona (pin-9, índice 8)
        return std::make_unique<components::DiodeLegArray>("outputs.seven_segment", std::move(pins), std::move(legs),
                                                             9.32e-11, 0.0965,
                                                             std::vector<std::pair<size_t, size_t>>{{8, 9}});
    });
    registerBuiltinMetadata("outputs.seven_segment", "7 Segment", {}, englishName("7 Segment"));
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
    // `stamp()` real (resistor de verdade, ver `components::Resistor`) -- antes `SimulidePassiveState`
    // (no-op), motor não drenava corrente nenhuma (achado de auditoria 2026-07-08). Simplificação
    // documentada: sem modelo de torque/rotação/back-EMF (`dcmotor.cpp` real tem isso), só a carga
    // resistiva do enrolamento -- eletricamente presente, não mais um circuito aberto.
    // Schema PRÓPRIO (não `Resistor::propertySchema()`, default 1000Ω -- valor genérico de resistor
    // avulso, não de um enrolamento de motor): achado ao converter pra `propertyOrDefault` -- a
    // metadata registrada pra `outputs.dc_motor` já usava `Resistor::propertySchema()` (default
    // 1000.0) enquanto a fábrica caía em 10.0 quando `resistance` vinha ausente -- os dois nunca
    // bateram. Corrigido com um schema dedicado, default 10.0 (mesma ordem de grandeza de um
    // enrolamento DC real), usado tanto na metadata quanto na validação de construção.
    std::vector<PropertySchema> dcMotorSchema{
        components::detail::numberSchema("resistance", "Resistência", "Ω", 10.0, 1e-9, 1.0, PropertySchemaShowOnSymbol)};
    reg.registerFactory("outputs.dc_motor", [dcMotorSchema](const ComponentParams& p) {
        const auto pos = makePins2(p, "lPin", "rPin");
        const double resistance = std::get<double>(propertyOrDefault(p.properties, dcMotorSchema.front()));
        return std::make_unique<components::Resistor>(pos, resistance);
    });
    registerBuiltinMetadata("outputs.dc_motor", "Dc Motor", dcMotorSchema, englishName("Dc Motor"));
    // Idem, 2 bobinas independentes (A+/A-, B+/B-) via `ResistorArray` -- sem modelo de passo/torque
    // (`stepper.cpp` real tem isso), só as duas bobinas eletricamente presentes.
    reg.registerFactory("outputs.stepper", [](const ComponentParams& p) {
        std::vector<Pin> pins = makePinVector(p, 4);
        const double resistance = std::get<double>(propertyOrDefault(p.properties, components::ResistorArray::propertySchema(10.0).front()));
        return std::make_unique<components::ResistorArray>("outputs.stepper", std::move(pins), resistance);
    });
    registerBuiltinMetadata("outputs.stepper", "Stepper", components::ResistorArray::propertySchema(10.0),
                            englishName("Stepper"));
    registerOutputState("outputs.servo", "Servo Motor", 3,
                        {components::detail::numberSchema("minPulse", "Pulso Minimo", "us", 1000.0, 1.0, 10.0),
                         components::detail::numberSchema("maxPulse", "Pulso Maximo", "us", 2000.0, 1.0, 10.0)});
    registerOutputState("outputs.audio_out", "Audio Out", 1, {});
    // `stamp()` real (resistor de verdade) -- antes `SimulidePassiveState` (no-op), lâmpada era um
    // circuito aberto (achado de auditoria 2026-07-08). Sem modelo de resistência variável com
    // temperatura/corrente (`lamp.cpp` real tem isso) -- só a carga resistiva fixa.
    // Mesmo achado de `outputs.dc_motor` (ver comentário lá): metadata/fábrica usavam defaults
    // diferentes (`Resistor::propertySchema()`=1000Ω vs literal 100.0) -- schema dedicado agora.
    std::vector<PropertySchema> incandescentLampSchema{
        components::detail::numberSchema("resistance", "Resistência", "Ω", 100.0, 1e-9, 1.0, PropertySchemaShowOnSymbol)};
    reg.registerFactory("outputs.incandescent_lamp", [incandescentLampSchema](const ComponentParams& p) {
        const auto pos = makePins2(p, "p1", "p2");
        const double resistance = std::get<double>(propertyOrDefault(p.properties, incandescentLampSchema.front()));
        return std::make_unique<components::Resistor>(pos, resistance);
    });
    registerBuiltinMetadata("outputs.incandescent_lamp", "Incandescent lamp", incandescentLampSchema,
                            englishName("Incandescent lamp"));

    // ── Fontes (pasta "Sources" do SimulIDE) ────────────────────────────────────
    reg.registerFactory("sources.battery", [](const ComponentParams& p) {
        const std::vector<PropertySchema> schemas = components::Battery::propertySchema();
        const double voltage = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "voltage")));
        const double resistance = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "resistance")));
        return std::make_unique<components::Battery>(makePins2(p, "p1", "p2"), voltage, resistance);
    });
    registerBuiltinMetadata("sources.battery", "Bateria", components::Battery::propertySchema(), englishName("Battery"),
                            std::nullopt, std::nullopt, std::vector<std::string>{"p1", "p2"});

    reg.registerFactory("sources.rail", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const double voltage = std::get<double>(propertyOrDefault(p.properties, components::Rail::propertySchema().front()));
        return std::make_unique<components::Rail>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y}, voltage);
    });
    registerBuiltinMetadata("sources.rail", "Trilho (Rail)", components::Rail::propertySchema(), englishName("Rail"),
                            std::nullopt, std::nullopt, std::vector<std::string>{"out"});

    reg.registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const std::vector<PropertySchema> schemas = components::FixedVolt::propertySchema();
        const double voltage = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "voltage")));
        const bool out = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "out")));
        return std::make_unique<components::FixedVolt>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y}, voltage, out);
    });
    registerBuiltinMetadata("sources.fixed_volt", "Tensão Fixa", components::FixedVolt::propertySchema(),
                            englishName("Fixed Voltage"), std::nullopt, std::nullopt, std::vector<std::string>{"out"});

    reg.registerFactory("sources.voltage_source", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const std::vector<PropertySchema> schemas = components::VoltSource::propertySchema();
        const double value = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "value")));
        const double minValue = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "minValue")));
        const double maxValue = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "maxValue")));
        return std::make_unique<components::VoltSource>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                         value, minValue, maxValue);
    });
    registerBuiltinMetadata("sources.voltage_source", "Fonte de Tensão Variável", components::VoltSource::propertySchema(),
                            englishName("Voltage Source"));

    reg.registerFactory("sources.current_source", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const std::vector<PropertySchema> schemas = components::CurrSource::propertySchema();
        const double value = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "value")));
        const double minValue = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "minValue")));
        const double maxValue = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "maxValue")));
        return std::make_unique<components::CurrSource>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                         value, minValue, maxValue);
    });
    registerBuiltinMetadata("sources.current_source", "Fonte de Corrente", components::CurrSource::propertySchema(),
                            englishName("Current Source"));

    reg.registerFactory("sources.controlled_source", [](const ComponentParams& p) {
        const auto pos = makePinVector(p, 4);
        const std::vector<PropertySchema> schemas = components::Csource::propertySchema();
        const bool controlPins = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "controlPins")));
        const bool currSource = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "currSource")));
        const bool currControl = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "currControl")));
        const double gain = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "gain")));
        const double voltage = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "voltage")));
        const double current = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "current")));
        return std::make_unique<components::Csource>(
            std::array<Pin, 4>{pos[0], pos[1], pos[2], pos[3]}, controlPins, currSource, currControl, gain, voltage, current);
    });
    registerBuiltinMetadata("sources.controlled_source", "Fonte Controlada", components::Csource::propertySchema(),
                            englishName("Controlled Source"));

    reg.registerFactory("sources.clock", [&scheduler](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const std::vector<PropertySchema> schemas = components::Clock::propertySchema();
        const double voltage = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "voltage")));
        const double freqHz = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "freqHz")));
        const bool alwaysOn = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "alwaysOn")));
        return std::make_unique<components::Clock>(scheduler, Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                    voltage, freqHz, alwaysOn);
    });
    registerBuiltinMetadata("sources.clock", "Clock", components::Clock::propertySchema(), englishName("Clock"));

    reg.registerFactory("sources.wave_gen", [&scheduler](const ComponentParams& p) {
        // Achado ao converter (fora do escopo desta rodada, registrado pra referência futura): o
        // construtor de `WaveGen` só aceita `freqHz` -- `waveType`/`phaseShift`/`duty`/`bipolar`/
        // `floating`/`semiAmplitude`/`midVoltage` (todas com schema e editáveis via
        // `propertyDescriptors()` DEPOIS de criado) NUNCA são lidas de `ComponentParams` na criação,
        // mesma classe de bug já corrigida em `Probe`/`SimulidePassiveState` -- um `.lsproj` salvo
        // com `bipolar=true` volta pro default `false` ao reabrir. Corrigir exigiria estender o
        // construtor ou chamar os setters aqui depois de construir -- deixado como achado, não
        // corrigido nesta rodada (o pedido era só converter `p.property()` já existente).
        const std::vector<PropertySchema> schemas = components::WaveGen::propertySchema();
        const double freqHz = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "freqHz")));
        return std::make_unique<components::WaveGen>(scheduler, makePins2(p, "out", "gnd"), freqHz);
    });
    registerBuiltinMetadata("sources.wave_gen", "Gerador de Onda", components::WaveGen::propertySchema(),
                            englishName("Wave Generator"));

    // ── Medidores (pasta "Meters" do SimulIDE) ──────────────────────────────────
    reg.registerFactory("meters.probe", [&scheduler](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        // `showVolt`/`pauseOnChange` lidos aqui (não só do default do construtor) -- mesma correção
        // já aplicada a `SimulidePassiveState`: sem isto, reabrir um projeto salvo com
        // `pauseOnChange=true` silenciosamente voltaria pro default `false` (a instância só existe
        // de novo via este construtor, `propertyDescriptors()` nunca é chamado na criação).
        // `propertyOrDefault` (não `p.property()`) -- valida contra o schema antes de aceitar (achado
        // de auditoria arquitetural 2026-07-09, D4): um valor salvo corrompido/fora de faixa cai no
        // default com log em vez de ser aplicado sem checagem nenhuma.
        const auto schemas = components::Probe::propertySchema();
        const double threshold = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "threshold")));
        const bool showVolt = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "showVolt")));
        const bool pauseOnChange = std::get<bool>(propertyOrDefault(p.properties, schemaById(schemas, "pauseOnChange")));
        return std::make_unique<components::Probe>(scheduler, Pin{pos[0].id.empty() ? "in" : pos[0].id, pos[0].x, pos[0].y},
                                                    threshold, showVolt, pauseOnChange);
    });
    registerBuiltinMetadata("meters.probe", "Sonda (Probe)", components::Probe::propertySchema(), englishName("Probe"),
                            components::Probe::readoutFormat());

    reg.registerFactory("meters.ampmeter", [](const ComponentParams& p) {
        const auto pos = makePinVector(p, 3);
        const double resistance = std::get<double>(propertyOrDefault(p.properties, components::Ampmeter::propertySchema().front()));
        return std::make_unique<components::Ampmeter>(std::array<Pin, 3>{pos[0], pos[1], pos[2]}, resistance);
    });
    registerBuiltinMetadata("meters.ampmeter", "Amperímetro", components::Ampmeter::propertySchema(),
                            englishName("Ampmeter"), components::Ampmeter::readoutFormat());

    reg.registerFactory("meters.freqmeter", [&scheduler](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        const double filter = std::get<double>(propertyOrDefault(p.properties, components::FreqMeter::propertySchema().front()));
        return std::make_unique<components::FreqMeter>(
            scheduler, Pin{pos[0].id.empty() ? "in" : pos[0].id, pos[0].x, pos[0].y}, filter);
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
        const std::vector<PropertySchema> schemas = components::LogicAnalyzer::propertySchema();
        const double thresholdRising = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "thresholdRising")));
        const double thresholdFalling = std::get<double>(propertyOrDefault(p.properties, schemaById(schemas, "thresholdFalling")));
        return std::make_unique<components::LogicAnalyzer>(scheduler, pins, thresholdRising, thresholdFalling);
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

// jsonToPropertyValue/optionValueToString/parsePropertySchema(List)/parseReadoutFormat/
// parseInteractionKind/parsePinSpec/propertyValueToJson/propertySchemaToJson/readoutFormatToJson/
// interactionKindToJson: movidos pra registry::PropertyJson.hpp (achado de auditoria arquitetural
// 2026-07-09, D16) -- GlobalPluginCache::loadLibrary precisa do MESMO parser pra montar
// registry::ComponentMetadata a partir de `.lsdevice`, sem duplicar o vocabulário inteiro.

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
 * `devices/library.json`) e cada `.lssubcircuit` referenciado, registrando no `SubcircuitRegistry`
 * da sessão -- ver .spec/lasecsimul-subcircuits.spec, seções 1 e 7. Roda no mesmo verbo IPC
 * `loadDeviceLibrary` que já existe (seção 6): um `library.json` com `"devices"` cai no caminho de
 * plugin nativo (`GlobalPluginCache::loadLibrary`), um com `"subcircuits"` cai aqui -- os dois são checados
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

struct WireEndpointsJson {
    std::string fromComponentId;
    std::string fromPinId;
    std::string toComponentId;
    std::string toPinId;
};

/** Forma única de "fio" em JSON -- `{from:{componentId,pinId}, to:{componentId,pinId}}` -- usada
 * tanto pelo manifesto `.lssubcircuit` (`wires[]`) quanto pelos verbos IPC ao vivo
 * `connectWire`/`disconnectWire`. Antes existiam DUAS formas (achado de auditoria arquitetural
 * 2026-07-09, D14): a IPC ao vivo usava uma forma achatada própria
 * (`componentA`/`pinIdA`/`componentB`/`pinIdB`) enquanto o arquivo já usava esta forma aninhada --
 * mesma entidade lógica, dois parsers. Unificado nesta forma (não a achatada) porque já era o
 * formato do arquivo, já é o modelo interno de fio da Webview (`WebviewWireModel.from`/`.to`) e já
 * é o que `.spec/lasecsimul-subcircuits.spec` documenta -- eliminar a segunda forma, não escolher
 * a "melhor" das duas do zero. */
WireEndpointsJson parseWireEndpoints(const nlohmann::json& wireJson, const std::string& context) {
    if (!wireJson.contains("from") || !wireJson["from"].is_object() || !wireJson.contains("to") ||
        !wireJson["to"].is_object()) {
        throw std::runtime_error(context + " sem endpoints from/to objetos");
    }
    WireEndpointsJson endpoints;
    endpoints.fromComponentId = requiredString(wireJson["from"], "componentId", context + ".from");
    endpoints.fromPinId = requiredString(wireJson["from"], "pinId", context + ".from");
    endpoints.toComponentId = requiredString(wireJson["to"], "componentId", context + ".to");
    endpoints.toPinId = requiredString(wireJson["to"], "pinId", context + ".to");
    return endpoints;
}

RegisteredSubcircuitInfo registerSubcircuitFromManifestRich(const std::filesystem::path& manifestPath,
                                                            registry::SubcircuitRegistry& subcircuits,
                                                            const std::string& typeIdOverride = {},
                                                            bool allowReplace = true,
                                                            bool returnPayload = true) {
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
    const bool canonicalTopology = manifest.contains("topology") && manifest["topology"].is_object();
    const nlohmann::json wiresJson = canonicalTopology
        ? requiredArray(manifest["topology"], "conductors", "topology de subcircuito")
        : requiredArray(manifest, "wires", "manifesto de subcircuito");
    const nlohmann::json& interfaceJson = requiredArray(manifest, "interface", "manifesto de subcircuito");

    registry::SubcircuitDefinition def;
    def.typeId = typeId;
    def.name = manifest.value("name", typeId);
    def.sourcePath = sourcePath;
    def.packageJson = manifest.contains("package") ? manifest["package"].dump() : "{}";

    std::unordered_set<std::string> componentIds;
    std::unordered_set<std::string> topologyNodeIds;
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
        if (comp.typeId == "connectors.junction") topologyNodeIds.insert(comp.id);
        else def.components.push_back(std::move(comp));
    }

    if (canonicalTopology) {
        for (const auto& nodeJson : requiredArray(manifest["topology"], "nodes", "topology de subcircuito")) {
            const std::string nodeId = requiredString(nodeJson, "id", "topology.nodes[]");
            if (!componentIds.insert(nodeId).second) throw std::runtime_error("id topológico duplicado: " + nodeId);
            topologyNodeIds.insert(nodeId);
        }
    }

    for (const auto& wireJson : wiresJson) {
        if (!wireJson.is_object()) throw std::runtime_error("wires[] deve conter objetos em " + sourcePath);
        WireEndpointsJson endpoints;
        if (canonicalTopology) {
            const auto parseEndpoint = [&](const nlohmann::json& endpoint, const char* side, std::string& componentId, std::string& pinId) {
                if (!endpoint.is_object()) throw std::runtime_error(std::string("endpoint ") + side + " inválido");
                const std::string kind = endpoint.value("kind", std::string{});
                if (kind == "node") { componentId = requiredString(endpoint, "nodeId", side); pinId = "pin-1"; }
                else if (kind == "port") { componentId = requiredString(endpoint, "componentId", side); pinId = requiredString(endpoint, "pinId", side); }
                else throw std::runtime_error(std::string("endpoint ") + side + " com kind inválido");
            };
            parseEndpoint(wireJson.at("from"), "from", endpoints.fromComponentId, endpoints.fromPinId);
            parseEndpoint(wireJson.at("to"), "to", endpoints.toComponentId, endpoints.toPinId);
        } else {
            endpoints = parseWireEndpoints(wireJson, "wire em " + sourcePath);
        }
        registry::SubcircuitWireDef wire;
        wire.fromComponentId = endpoints.fromComponentId;
        wire.fromPinId = endpoints.fromPinId;
        wire.toComponentId = endpoints.toComponentId;
        wire.toPinId = endpoints.toPinId;
        if (!componentIds.contains(wire.fromComponentId)) {
            throw std::runtime_error("wire referencia componente inexistente: " + wire.fromComponentId);
        }
        if (!componentIds.contains(wire.toComponentId)) {
            throw std::runtime_error("wire referencia componente inexistente: " + wire.toComponentId);
        }
        def.wires.push_back(std::move(wire));
    }

    // Junction é sintaxe topológica do arquivo, nunca componente de simulação. Achata cada rede em
    // uma árvore de N-1 arestas entre portas reais e remove todos os endpoints de nó artificial.
    if (!topologyNodeIds.empty()) {
        constexpr char separator = '\x1f';
        const auto key = [separator](const std::string& componentId, const std::string& pinId) {
            return componentId + std::string(1, separator) + pinId;
        };
        std::unordered_map<std::string, std::vector<std::string>> adjacency;
        for (const auto& wire : def.wires) {
            const std::string a = key(wire.fromComponentId, wire.fromPinId);
            const std::string b = key(wire.toComponentId, wire.toPinId);
            adjacency[a].push_back(b); adjacency[b].push_back(a);
        }
        std::unordered_set<std::string> visited;
        std::vector<registry::SubcircuitWireDef> flattened;
        for (const auto& [start, unused] : adjacency) {
            (void)unused;
            if (visited.contains(start)) continue;
            std::vector<std::string> stack{start}; visited.insert(start);
            std::vector<std::pair<std::string, std::string>> ports;
            while (!stack.empty()) {
                std::string current = std::move(stack.back()); stack.pop_back();
                const size_t split = current.find(separator);
                const std::string componentId = current.substr(0, split);
                const std::string pinId = current.substr(split + 1);
                if (!topologyNodeIds.contains(componentId)) ports.emplace_back(componentId, pinId);
                for (const std::string& next : adjacency[current]) if (visited.insert(next).second) stack.push_back(next);
            }
            if (ports.size() < 2) continue;
            for (size_t i = 1; i < ports.size(); ++i) flattened.push_back({ports[0].first, ports[0].second, ports[i].first, ports[i].second});
        }
        def.wires = std::move(flattened);
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
        if (returnPayload) {
            exportedInterface.push_back({{"pinId", iface.pinId}, {"label", iface.label}, {"internalTunnel", iface.internalTunnel}});
            pinIds.push_back(iface.pinId);
        }
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
    if (!returnPayload) return {typeId, nlohmann::json::object()};

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
        (void)registerSubcircuitFromManifestRich(libraryDir / manifestRelative, subcircuits, typeId, true, false);
    }
}

// loadDeviceLibraryFile/loadMcuLibraryFile: movidos pra GlobalPluginCache::loadLibrary
// (achado de auditoria arquitetural 2026-07-09, D16) -- é GlobalPluginCache quem tem loader()
// E metadata() E os mapas setActive*Module pra publicar de fato; PluginLoader::scanDirectory
// permanece deliberadamente estreito (só carrega UM binário validado, não conhece
// ComponentMetadataRegistry), ver PluginLoader.hpp.

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
        // `Scheduler::step(deltaNs)` já existe e é usado por `mcu_controller_real_qemu_test`/etc --
        // só faltava ligar o verbo IPC nele (achado de auditoria 2026-07-08: "step não implementado"
        // era falso, o mecanismo real já existia, só não estava exposto). `deltaNs` no payload
        // (`{"deltaNs": N}`), default 1000ns (passo mínimo, avança e assenta uma única vez).
        uint64_t deltaNs = 1000;
        try {
            if (!msg.payloadJson.empty()) {
                const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson);
                if (payload.contains("deltaNs") && payload["deltaNs"].is_number()) deltaNs = payload["deltaNs"].get<uint64_t>();
            }
        } catch (const std::exception&) {
            // payload malformado -- segue com o default, mesma tolerância de outros handlers que só
            // leem campos opcionais do JSON.
        }
        session.scheduler().step(deltaNs);
        resp.ok = true;
        return resp;
    }
    if (msg.type == "getSimulationTime") {
        // Achado de auditoria de UI 2026-07-09 (paridade SimulIDE: `InfoWidget::setRate()` mostra a
        // taxa REAL alcançada, não uma configuração estática) -- `Scheduler::nowNs()` já existe e é
        // exatamente o que falta pra Extension calcular `Δ(tempo simulado)/Δ(tempo de parede)` entre
        // duas amostras (mesma técnica do SimulIDE real: tempo simulado dividido pelo tempo de
        // parede decorrido). Verbo somente-leitura, sem estado novo no Core.
        resp.ok = true;
        resp.payloadJson = nlohmann::json{{"simulatedNs", session.scheduler().nowNs()}}.dump();
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
    if (msg.type == "getComponentStates") {
        try {
            const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson);
            nlohmann::json states = nlohmann::json::object();
            static const char digits[] = "0123456789abcdef";
            for (const auto& item : payload.at("items")) {
                const std::string key = item.at("key").get<std::string>();
                const uint32_t id = static_cast<uint32_t>(std::stoul(item.at("instanceId").get<std::string>()));
                const std::vector<uint8_t> bytes = session.getComponentState(id);
                std::string hex; hex.reserve(bytes.size() * 2);
                for (uint8_t byte : bytes) { hex.push_back(digits[byte >> 4]); hex.push_back(digits[byte & 15]); }
                states[key] = std::move(hex);
            }
            resp.ok = true; resp.payloadJson = nlohmann::json{{"states", states}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false; resp.error = std::string("getComponentStates falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "resume") {
        session.scheduler().start();
        session.scheduler().resume();
        resp.ok = true;
        return resp;
    }
    if (msg.type == "settleMcuDebug") {
        try {
            const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.at("instanceId").get<std::string>()));
            session.scheduler().markDirty(instanceId);
            session.scheduler().step(0);
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("settleMcuDebug falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "stopMcuFirmware") {
        try {
            const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson);
            const uint32_t instanceId = static_cast<uint32_t>(std::stoul(payload.at("instanceId").get<std::string>()));
            session.stopMcuFirmware(instanceId);
            resp.ok = true;
        } catch (const std::exception& e) {
            resp.ok = false; resp.error = std::string("stopMcuFirmware falhou: ") + e.what();
        }
        return resp;
    }
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
    if (msg.type == "getNodeVoltages") {
        try {
            const nlohmann::json payload = nlohmann::json::parse(msg.payloadJson);
            nlohmann::json values = nlohmann::json::object();
            for (const auto& probe : payload.at("probes")) {
                const std::string key = probe.at("key").get<std::string>();
                const uint32_t instanceId = static_cast<uint32_t>(std::stoul(probe.at("instanceId").get<std::string>()));
                values[key] = session.nodeVoltageOfPin(instanceId, probe.at("pinId").get<std::string>());
            }
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"values", values}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("getNodeVoltages falhou: ") + e.what();
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
            McuDebugOptions debug;
            if (payload.contains("gdbPort")) debug.gdbPort = payload["gdbPort"].get<uint16_t>();
            debug.startPaused = payload.value("startPaused", true);
            if (firmwarePath.empty()) throw std::runtime_error("caminho do firmware vazio");
            const std::string arenaName = "lasecsimul-mcu-" + std::to_string(instanceId);
            if (debug.enabled() && debug.startPaused) session.scheduler().pause();
            session.loadMcuFirmware(instanceId, firmwarePath, arenaName, qemuBinaryOverride, debug);
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"gdbPort", debug.gdbPort}, {"debug", debug.enabled()}}.dump();
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
    // registerBuiltinComponents) OU plugin (registrado por GlobalPluginCache::loadLibrary a partir do
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
            // `pinIdsByTypeId`: id ELÉTRICO real de cada pino, na mesma ordem que a factory usa como
            // fallback (ver `registerBuiltinMetadata`/`registerBuiltinComponents` acima) -- só
            // aparece pra typeId que declarou `pins` (built-ins com id canônico fixo, OU device/
            // subcircuit-file cujo `.lsdevice`/`.lssubcircuit` já populou `meta.pins` via
            // `interface[]`). Substitui a Extension manter uma tabela hardcoded 2ª cópia do mesmo
            // dado (ver .spec/lasecsimul-native-devices.spec).
            nlohmann::json pinIdsByTypeId = nlohmann::json::object();
            for (const auto& [typeId, meta] : pluginCache.metadata().all()) {
                const std::vector<PropertySchema> resolved = resolvePropertySchemaForLanguage(meta, requestedLanguage);
                nlohmann::json schemas = nlohmann::json::array();
                for (const PropertySchema& schema : resolved) {
                    schemas.push_back(propertySchemaToJson(schema));
                }
                schemasByTypeId[typeId] = std::move(schemas);
                if (meta.readoutFormat) readoutFormatByTypeId[typeId] = readoutFormatToJson(*meta.readoutFormat);
                if (meta.interactionKind) interactionKindByTypeId[typeId] = interactionKindToJson(*meta.interactionKind);
                if (!meta.pins.empty()) {
                    nlohmann::json pinIds = nlohmann::json::array();
                    for (const Pin& pin : meta.pins) pinIds.push_back(pin.id);
                    pinIdsByTypeId[typeId] = std::move(pinIds);
                }
            }
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"schemasByTypeId", schemasByTypeId},
                                               {"pinIdsByTypeId", pinIdsByTypeId},
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
            pluginCache.loadLibrary(libraryPath);
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
            const bool returnPayload = payload.value("returnPayload", true);
            if (manifestPath.empty()) throw std::runtime_error("payload sem 'path'");
            const RegisteredSubcircuitInfo info =
                registerSubcircuitFromManifestRich(manifestPath, session.subcircuits(), {}, replace, returnPayload);
            resp.ok = true;
            if (returnPayload) resp.payloadJson = info.payload.dump();
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
            TransientSettings transient = session.transientSettings();
            if (payload.contains("maxNonLinearIterations") && payload["maxNonLinearIterations"].is_number())
                transient.maximumNewtonIterations = payload["maxNonLinearIterations"].get<uint32_t>();
            if (payload.contains("integrationMethod") && payload["integrationMethod"].is_string()) {
                const std::string method = payload["integrationMethod"].get<std::string>();
                if (method == "automatic") transient.method = IntegrationMethod::Automatic;
                else if (method == "backwardEuler") transient.method = IntegrationMethod::BackwardEuler;
                else if (method == "trapezoidal") transient.method = IntegrationMethod::Trapezoidal;
                else if (method == "gear2") transient.method = IntegrationMethod::Gear2;
                else throw std::invalid_argument("integrationMethod desconhecido");
            }
            if (payload.contains("initialStepNs")) transient.initialStepNs = payload["initialStepNs"].get<uint64_t>();
            if (payload.contains("minimumStepNs")) transient.minimumStepNs = payload["minimumStepNs"].get<uint64_t>();
            if (payload.contains("maximumStepNs")) transient.maximumStepNs = payload["maximumStepNs"].get<uint64_t>();
            if (payload.contains("relativeTolerance")) transient.relativeTolerance = payload["relativeTolerance"].get<double>();
            if (payload.contains("absoluteTolerance")) transient.absoluteTolerance = payload["absoluteTolerance"].get<double>();
            if (payload.contains("maximumNewtonIterations")) transient.maximumNewtonIterations = payload["maximumNewtonIterations"].get<uint32_t>();
            if (payload.contains("adaptiveTimeStep")) transient.adaptiveTimeStep = payload["adaptiveTimeStep"].get<bool>();
            session.setTransientSettings(transient);
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
            const WireEndpointsJson endpoints = parseWireEndpoints(payload, "connectWire");
            const uint32_t componentA = static_cast<uint32_t>(std::stoul(endpoints.fromComponentId));
            const uint32_t componentB = static_cast<uint32_t>(std::stoul(endpoints.toComponentId));
            session.connectWire(componentA, endpoints.fromPinId, componentB, endpoints.toPinId);
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"topologyRevision", session.wireTopologyRevision()}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("connectWire falhou: ") + e.what();
        }
        return resp;
    }
    // EX-6.1/EX-6.2 (.spec/lasecsimul-native-devices.spec) -- inverso de "connectWire", remove só
    // este fio sem reconstruir o circuito inteiro (antes, a Extension não tinha nenhum jeito de
    // remover um fio sem removeComponent+addComponent+connectWire de TODOS os componentes).
    if (msg.type == "disconnectWire") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            const WireEndpointsJson endpoints = parseWireEndpoints(payload, "disconnectWire");
            const uint32_t componentA = static_cast<uint32_t>(std::stoul(endpoints.fromComponentId));
            const uint32_t componentB = static_cast<uint32_t>(std::stoul(endpoints.toComponentId));
            const bool removed = session.disconnectWire(componentA, endpoints.fromPinId, componentB, endpoints.toPinId);
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"removed", removed}, {"topologyRevision", session.wireTopologyRevision()}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("disconnectWire falhou: ") + e.what();
        }
        return resp;
    }
    if (msg.type == "applyWireTopologyTransaction") {
        try {
            const nlohmann::json payload =
                msg.payloadJson.empty() ? nlohmann::json::object() : nlohmann::json::parse(msg.payloadJson);
            if (!payload.contains("operations") || !payload["operations"].is_array())
                throw std::invalid_argument("operations precisa ser array");
            std::vector<session::WireTopologyOperation> operations;
            operations.reserve(payload["operations"].size());
            for (const auto& operationJson : payload["operations"]) {
                const WireEndpointsJson endpoints = parseWireEndpoints(operationJson, "applyWireTopologyTransaction");
                const std::string kind = operationJson.value("kind", std::string{});
                session::WireTopologyOperation operation;
                if (kind == "connect") operation.kind = session::WireTopologyOperation::Kind::Connect;
                else if (kind == "disconnect") operation.kind = session::WireTopologyOperation::Kind::Disconnect;
                else throw std::invalid_argument("kind precisa ser connect ou disconnect");
                operation.from = {static_cast<uint32_t>(std::stoul(endpoints.fromComponentId)), endpoints.fromPinId};
                operation.to = {static_cast<uint32_t>(std::stoul(endpoints.toComponentId)), endpoints.toPinId};
                operations.push_back(std::move(operation));
            }
            const uint64_t baseRevision = payload.value("baseRevision", uint64_t{0});
            const uint64_t topologyRevision = session.applyWireTopologyTransaction(baseRevision, operations);
            resp.ok = true;
            resp.payloadJson = nlohmann::json{{"applied", operations.size()}, {"topologyRevision", topologyRevision}}.dump();
        } catch (const std::exception& e) {
            resp.ok = false;
            resp.error = std::string("applyWireTopologyTransaction falhou: ") + e.what();
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
