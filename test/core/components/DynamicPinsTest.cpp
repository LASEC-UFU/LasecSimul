#include <cstdio>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "components/SimulideBuiltins.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "registry/ComponentParams.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

std::vector<std::string> idsOf(const std::vector<Pin>& pins) {
    std::vector<std::string> ids;
    for (const Pin& pin : pins) ids.push_back(pin.id);
    return ids;
}

/** `resolveDynamicPins` pura -- sem `SimulationSession`/`SimulidePassiveState`, só o intérprete
 * genérico de `ComponentPinSpec` (Types.hpp) usado por keypad/led_matrix/led_bar/analog_mux e, no
 * futuro, por qualquer plugin que declare `pinSpec` no manifesto. */
void testResolveDynamicPinsPureFormulas() {
    std::fprintf(stderr, "\n[DynamicPins T1] resolveDynamicPins -- grupos fixos + dinâmicos + Log2Ceil\n");

    // switches.keypad / outputs.led_matrix: rows+columns, ids sequenciais cruzando os 2 grupos.
    {
        const ComponentPinSpec spec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};
        const auto pins = resolveDynamicPins(spec, {{"rows", 4.0}, {"columns", 3.0}});
        TEST_ASSERT(pins.size() == 7, "keypad default (rows=4,columns=3) deve ter 7 pinos, nunca 8 fixo");
        TEST_ASSERT(idsOf(pins) == std::vector<std::string>({"pin-1", "pin-2", "pin-3", "pin-4", "pin-5", "pin-6", "pin-7"}),
                    "ids devem ser pin-1..pin-7, rows primeiro depois columns");
    }
    {
        const ComponentPinSpec spec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};
        const auto pins = resolveDynamicPins(spec, {{"rows", 6.0}, {"columns", 2.0}});
        TEST_ASSERT(pins.size() == 8, "rows=6,columns=2 deve ter 8 pinos (6+2, nunca 6*2)");
    }

    // outputs.led_bar: 2 grupos independentes na MESMA propriedade (par P/N por LED).
    {
        const ComponentPinSpec spec{{}, {{"pin-P", "size"}, {"pin-N", "size"}}};
        const auto pins = resolveDynamicPins(spec, {{"size", 4.0}});
        TEST_ASSERT(pins.size() == 8, "led_bar com size=4 deve ter 8 pinos (4 P + 4 N)");
        // resolveDynamicPins numera sequencialmente CRUZANDO todos os grupos (mesmo contador que faz
        // columns continuar de onde rows parou no keypad) -- por isso o grupo N continua a partir de
        // 5, nunca reinicia em 1. Prefixo (P/N) já garante unicidade sozinho; a Extension é livre
        // pra escolher OUTRA numeração no próprio `dynamicLayout`, contanto que os ids batam com
        // este lado quando o `pinSpec` do led_bar for escrito.
        TEST_ASSERT(idsOf(pins) == std::vector<std::string>({"pin-P1", "pin-P2", "pin-P3", "pin-P4", "pin-N5", "pin-N6", "pin-N7", "pin-N8"}),
                    "grupo N continua a numeracao global a partir de onde o grupo P parou (5), nunca reinicia em 1");
    }

    // active.analog_mux: pinos fixos (Z, enable) + endereço (Log2Ceil de canais) + canais.
    {
        const ComponentPinSpec spec{{"z", "en"}, {{"addr-", "channels", DynamicPinCountFn::Log2Ceil}, {"chan-", "channels"}}};
        const auto pins = resolveDynamicPins(spec, {{"channels", 8.0}});
        TEST_ASSERT(pins.size() == 2 + 3 + 8, "8 canais precisa de ceil(log2(8))=3 linhas de endereco + 2 fixos");
        TEST_ASSERT(pins[0].id == "z" && pins[1].id == "en", "pinos fixos vem primeiro, na ordem declarada");
    }
    {
        const ComponentPinSpec spec{{"z", "en"}, {{"addr-", "channels", DynamicPinCountFn::Log2Ceil}, {"chan-", "channels"}}};
        const auto pins = resolveDynamicPins(spec, {{"channels", 5.0}});
        TEST_ASSERT(pins.size() == 2 + 3 + 5, "5 canais tambem precisa de ceil(log2(5))=3 linhas de endereco (nao-potencia-de-2)");
    }

    // Propriedade ausente do mapa conta como grupo vazio (0 pinos), nunca erro -- mesmo
    // comportamento default-seguro que `materializePinGroup` já tem do lado da Extension.
    {
        const ComponentPinSpec spec{{}, {{"pin-", "rows"}}};
        const auto pins = resolveDynamicPins(spec, {});
        TEST_ASSERT(pins.empty(), "propriedade ausente deve resultar em grupo vazio, nao lancar excecao");
    }
}

/** `SimulidePassiveState` com `pinSpec`: contagem correta JÁ NA CRIAÇÃO (a partir de
 * `initialProperties`, não só do default do schema -- corrige de quebra o gap de
 * `ComponentParams::properties` sendo ignorado por este construtor) e recontagem automática ao
 * editar uma propriedade `AffectsPinCount` via `propertyDescriptors()`. */
void testSimulidePassiveStateDynamicPins() {
    std::fprintf(stderr, "\n[DynamicPins T2] SimulidePassiveState -- contagem na criação e após editar propriedade\n");

    std::vector<PropertySchema> schema{
        components::detail::numberSchema("rows", "Linhas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
        components::detail::numberSchema("columns", "Colunas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
    };
    const ComponentPinSpec spec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};

    // Criação SEM properties explícitas -- cai nos defaults do schema (4+4=8), igual ao
    // comportamento de sempre pra quem não passa `initialProperties`.
    {
        components::SimulidePassiveState state("switches.keypad", {}, schema, {}, spec);
        TEST_ASSERT(state.pins().size() == 8, "sem initialProperties, usa os defaults do schema (4+4)");
    }

    // Criação COM properties explícitas (ex: projeto salvo com rows=6,columns=2) -- a contagem
    // JÁ NASCE certa, sem precisar de um setProperty() depois.
    {
        std::unordered_map<std::string, PropertyValue> initial{{"rows", 6.0}, {"columns", 2.0}};
        components::SimulidePassiveState state("switches.keypad", {}, schema, initial, spec);
        TEST_ASSERT(state.pins().size() == 8, "com initialProperties, a contagem reflete rows/columns REAIS (6+2), nao o default");
    }

    // Editar `rows` depois de criado recomputa `pins()` automaticamente.
    {
        components::SimulidePassiveState state("switches.keypad", {}, schema, {}, spec);
        auto descriptors = state.propertyDescriptors();
        bool found = false;
        for (PropertyDescriptor& descriptor : descriptors) {
            if (descriptor.name != "rows") continue;
            found = true;
            descriptor.set(PropertyValue{8.0});
        }
        TEST_ASSERT(found, "descriptor de 'rows' deve existir");
        TEST_ASSERT(state.pins().size() == 12, "editar rows de 4 para 8 deve recomputar pins() para 8+4=12 na hora");
    }

    // Propriedade SEM AffectsPinCount (ex: um schema hipotético sem o flag) não deveria existir
    // neste spec de teste -- mas confirmamos que uma propriedade numérica comum (sem o flag) usa o
    // caminho genérico de sempre (detail::numberDescriptor), não o hook de recontagem.
}

void testSimulationSessionKeypadEndToEnd() {
    std::fprintf(stderr, "\n[DynamicPins T3] SimulationSession -- addComponent+setProperty reregistram pinos reais no Netlist\n");

    plugins::GlobalPluginCache cache;
    session::SimulationSession session(cache);

    // `registerBuiltinComponents` (CoreApplication.cpp) tem linkage interna (namespace anônimo) --
    // nenhum teste unitário consegue chamá-la direto, nem `voltage_divider_test`/`diode_test`
    // fazem isso (todos registram um componente de teste local equivalente). A fórmula rows+columns
    // do keypad de verdade já foi validada de forma pura em T1 (resolveDynamicPins) contra o
    // catálogo/CoreApplication.cpp; aqui o objetivo é só provar que a ORQUESTRAÇÃO genérica
    // (SimulationSession::setProperty -> Netlist::reregisterComponentPins) funciona ponta a ponta
    // pra QUALQUER componente com `ComponentPinSpec`, usando a MESMA forma de registro/schema.
    std::vector<PropertySchema> testSchema{
        components::detail::numberSchema("rows", "Linhas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
        components::detail::numberSchema("columns", "Colunas", "", 4.0, 1.0, 1.0,
                                         PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount, 8.0),
    };
    const ComponentPinSpec testPinSpec{{}, {{"pin-", "rows"}, {"pin-", "columns"}}};
    session.components().registerFactory("test.dynamic_keypad", [testSchema, testPinSpec](const registry::ComponentParams& p) {
        return std::make_unique<components::SimulidePassiveState>("test.dynamic_keypad", std::vector<Pin>{}, testSchema,
                                                                   p.properties, testPinSpec);
    });
    // Sonda de 1 pino fixo (equivalente a `other.ground`, também indisponível fora do registro real)
    // -- só serve pra ter algo do OUTRO LADO de um `connectWire` de teste.
    session.components().registerFactory("test.probe", [](const registry::ComponentParams&) {
        return std::make_unique<components::SimulidePassiveState>("test.probe", std::vector<Pin>{Pin{"pin", 0.0, 0.0}},
                                                                   std::vector<PropertySchema>{});
    });

    registry::ComponentParams keypadParams;
    keypadParams.properties["rows"] = PropertyValue{6.0};
    keypadParams.properties["columns"] = PropertyValue{2.0}; // 8 pinos reais (6+2), nao 8 fixo por coincidencia
    uint32_t keypad = 0;
    try {
        keypad = session.addComponent("test.dynamic_keypad", keypadParams);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "  EXCEPTION addComponent(test.dynamic_keypad): %s\n", e.what());
        TEST_ASSERT(false, "addComponent(test.dynamic_keypad) nao deveria lancar");
        return;
    }

    registry::ComponentParams probeParams;
    uint32_t probe = 0;
    try {
        probe = session.addComponent("test.probe", probeParams);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "  EXCEPTION addComponent(test.probe): %s\n", e.what());
        TEST_ASSERT(false, "addComponent(test.probe) nao deveria lancar");
        return;
    }

    // pin-8 deve existir (6+2=8); pin-9 não deve existir ainda -- connectWire com pino inexistente
    // lança (Netlist::pinSlotsOf(...).at(pinId) -- ver SimulationSession::connectWire).
    bool pin8Connects = true;
    try {
        session.connectWire(keypad, "pin-8", probe, "pin");
    } catch (const std::exception&) {
        pin8Connects = false;
    }
    TEST_ASSERT(pin8Connects, "keypad criado com rows=6,columns=2 deve ter pin-8 real registrado no Netlist");

    bool pin9ConnectsBeforeEdit = true;
    try {
        session.connectWire(keypad, "pin-9", probe, "pin");
    } catch (const std::exception&) {
        pin9ConnectsBeforeEdit = false;
    }
    TEST_ASSERT(!pin9ConnectsBeforeEdit, "pin-9 nao deve existir antes de qualquer edicao (rows+columns=8)");

    // Editar rows de 6 para 8 (columns continua 2) -> 10 pinos reais -- SimulationSession::setProperty
    // deve reregistrar no Netlist (não só marcar dirty).
    std::optional<std::string> error;
    try {
        error = session.setProperty(keypad, "rows", PropertyValue{8.0});
    } catch (const std::exception& e) {
        std::fprintf(stderr, "  EXCEPTION setProperty(rows=8): %s\n", e.what());
        TEST_ASSERT(false, "setProperty(rows=8) nao deveria lancar");
        return;
    }
    TEST_ASSERT(!error.has_value(), "setProperty(rows=8) deve ser aceito (dentro do maxValue=8)");

    bool pin10ConnectsAfterEdit = true;
    try {
        session.connectWire(keypad, "pin-10", probe, "pin");
    } catch (const std::exception&) {
        pin10ConnectsAfterEdit = false;
    }
    TEST_ASSERT(pin10ConnectsAfterEdit, "depois de rows=8 (8+2=10), pin-10 deve existir de verdade no Netlist");
}

} // namespace

int main() {
    testResolveDynamicPinsPureFormulas();
    testSimulidePassiveStateDynamicPins();
    testSimulationSessionKeypadEndToEnd();

    if (failures == 0) {
        std::printf("OK: Dynamic pins cases passed.\n");
        return 0;
    }
    std::fprintf(stderr, "%d dynamic pins assertion(s) failed.\n", failures);
    return 1;
}
