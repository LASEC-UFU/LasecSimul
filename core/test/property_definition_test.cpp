// Auditoria arquitetural 2026-07-09 (Fase 1.4/2.1): prova que o contrato novo (PropertyDefinition/
// validatePropertyValue/propertyOrDefault, lasecsimul/PropertyDefinition.hpp) funciona -- e que
// Probe/Resistor (migrados como demonstração) casam get/set ao schema certo POR ID, não por
// índice (o bug real, D2, que já mordeu Probe uma vez quando a ordem de propertySchema() e
// propertyDescriptors() podia divergir em silêncio).
#include <cstdio>
#include <memory>
#include "components/meters/Probe.hpp"
#include "components/passive/Resistor.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

using namespace lasecsimul;
using namespace lasecsimul::components;

namespace {

int failures = 0;
#define CHECK(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

void testValidatePropertyValue() {
    PropertySchema numberSchema;
    numberSchema.id = "n";
    numberSchema.valueKind = PropertyValueKind::Number;
    numberSchema.minValue = 1.0;
    numberSchema.maxValue = 10.0;

    CHECK(!validatePropertyValue(numberSchema, PropertyValue{5.0}), "5.0 dentro de [1,10] valida");
    CHECK(validatePropertyValue(numberSchema, PropertyValue{0.5}).has_value(), "0.5 abaixo do mínimo rejeita");
    CHECK(validatePropertyValue(numberSchema, PropertyValue{20.0}).has_value(), "20.0 acima do máximo rejeita");
    CHECK(validatePropertyValue(numberSchema, PropertyValue{std::string{"x"}}).has_value(), "tipo errado (string p/ number) rejeita");

    PropertySchema readOnlySchema;
    readOnlySchema.id = "ro";
    readOnlySchema.valueKind = PropertyValueKind::Bool;
    readOnlySchema.flags |= PropertySchemaReadOnly;
    CHECK(validatePropertyValue(readOnlySchema, PropertyValue{true}).has_value(), "propriedade readOnly sempre rejeita set");
}

void testPropertyOrDefaultFallsBackSilentlyToLoudDefault() {
    PropertySchema schema;
    schema.id = "resistance";
    schema.valueKind = PropertyValueKind::Number;
    schema.defaultValue = 1000.0;
    schema.minValue = 0.01;

    std::unordered_map<std::string, PropertyValue> missing;
    CHECK(std::get<double>(propertyOrDefault(missing, schema)) == 1000.0, "chave ausente cai no default (comportamento de sempre)");

    std::unordered_map<std::string, PropertyValue> valid{{"resistance", PropertyValue{470.0}}};
    CHECK(std::get<double>(propertyOrDefault(valid, schema)) == 470.0, "valor válido presente é aceito");

    std::unordered_map<std::string, PropertyValue> invalid{{"resistance", PropertyValue{-5.0}}};
    CHECK(std::get<double>(propertyOrDefault(invalid, schema)) == 1000.0,
          "valor inválido presente (abaixo do mínimo) cai no default -- D4: antes isso passava em silêncio "
          "SEM cair no default certo, agora cai no default do schema com log");
}

void testProbePropertiesMatchByIdNotPosition() {
    simulation::Scheduler scheduler(4, [] { return false; });
    Probe probe(scheduler, Pin{"in"}, 2.5);

    std::vector<PropertyDescriptor> descriptors = probe.propertyDescriptors();
    CHECK(descriptors.size() == 3, "Probe declara 3 propriedades");

    // Acha cada descriptor por nome (não por índice) e confirma que editar UM nunca afeta os
    // outros -- exatamente o cenário que o bug de acoplamento posicional (D2) quebraria se
    // schemas[] e descriptors[] pudessem divergir em ordem.
    PropertyDescriptor* pauseOnChange = nullptr;
    PropertyDescriptor* threshold = nullptr;
    PropertyDescriptor* showVolt = nullptr;
    for (PropertyDescriptor& d : descriptors) {
        if (d.name == "pauseOnChange") pauseOnChange = &d;
        if (d.name == "threshold") threshold = &d;
        if (d.name == "showVolt") showVolt = &d;
    }
    CHECK(pauseOnChange && threshold && showVolt, "os 3 descriptors existem com os nomes certos");

    CHECK(std::get<bool>(pauseOnChange->get()) == false, "pauseOnChange começa false (default)");
    CHECK(std::get<double>(threshold->get()) == 2.5, "threshold começa 2.5 (construtor)");

    pauseOnChange->set(PropertyValue{true});
    CHECK(std::get<bool>(pauseOnChange->get()) == true, "editar pauseOnChange muda pauseOnChange");
    CHECK(std::get<double>(threshold->get()) == 2.5, "editar pauseOnChange NÃO afeta threshold (sem acoplamento posicional)");
    CHECK(std::get<bool>(showVolt->get()) == true, "editar pauseOnChange NÃO afeta showVolt (default true)");

    threshold->set(PropertyValue{4.0});
    CHECK(std::get<double>(threshold->get()) == 4.0, "editar threshold muda threshold");
    CHECK(std::get<bool>(pauseOnChange->get()) == true, "editar threshold NÃO reverte pauseOnChange já setado");
}

void testResistorPropertiesRoundTrip() {
    Resistor resistor(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}}, 1000.0);
    std::vector<PropertyDescriptor> descriptors = resistor.propertyDescriptors();
    CHECK(descriptors.size() == 1, "Resistor declara 1 propriedade");
    CHECK(descriptors[0].name == "resistance", "a propriedade única é 'resistance'");
    CHECK(std::get<double>(descriptors[0].get()) == 1000.0, "valor inicial é o do construtor");

    descriptors[0].set(PropertyValue{470.0});
    CHECK(std::get<double>(descriptors[0].get()) == 470.0, "set() muda o valor lido de volta");
}

} // namespace

int main() {
    std::fprintf(stderr, "=== PropertyDefinitionTest ===\n");
    testValidatePropertyValue();
    testPropertyOrDefaultFallsBackSilentlyToLoudDefault();
    testProbePropertiesMatchByIdNotPosition();
    testResistorPropertiesRoundTrip();

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
