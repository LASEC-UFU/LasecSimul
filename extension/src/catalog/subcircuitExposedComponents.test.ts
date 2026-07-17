import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { SUBCIRCUIT_SCHEMA_VERSION, SubcircuitDocument } from "./subcircuitDocument";
import { pruneInvalidExportedPropertyRefs, pruneInvalidExposedComponentRefs, removeExposedComponent, setExposedComponent } from "./subcircuitExposedComponents";

function baseDocument(): SubcircuitDocument {
  return {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId: "subcircuits.demo",
    name: "Demo",
    components: [
      { id: "led1", typeId: "outputs.led", properties: {}, visual: { x: 0, y: 0, rotation: 0 } },
      { id: "btn1", typeId: "inputs.button", properties: {}, visual: { x: 0, y: 0, rotation: 0 } },
    ],
    topology: { revision: 0, nodes: [], conductors: [] },
    interface: [],
    exposedComponents: [],
    exportedPropertyComponentIds: [],
  };
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitExposedComponents - referências por id persistente, nunca cópia");

  await test("setExposedComponent adiciona uma nova entrada quando o componente ainda não está exposto", () => {
    const doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 10, y: 10, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(doc.exposedComponents.length === 1, "deveria ter adicionado 1 exposição");
    assert(doc.exposedComponents[0]!.componentId === "led1", "componentId deveria referenciar o componente interno real");
  });

  await test("setExposedComponent SUBSTITUI (nunca duplica) quando o componente já está exposto", () => {
    let doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 10, y: 10, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    doc = setExposedComponent(doc, { componentId: "led1", x: 99, y: 99, rotation: 90, flipH: true, flipV: false, scale: 2, layer: 1 });
    assert(doc.exposedComponents.length === 1, `esperado ainda 1 entrada (substituída, não duplicada), recebido ${doc.exposedComponents.length}`);
    assert(doc.exposedComponents[0]!.x === 99 && doc.exposedComponents[0]!.rotation === 90, "a entrada deveria refletir os novos valores de apresentação");
  });

  await test("expor um componente NUNCA copia suas propriedades funcionais -- exposedComponents só guarda apresentação, referencia o componente por id", () => {
    const doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 5, y: 5, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    const entry = doc.exposedComponents[0]!;
    const keys = Object.keys(entry).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["componentId", "flipH", "flipV", "layer", "rotation", "scale", "x", "y"].sort()), `exposedComponents[] só deveria ter campos de apresentação, recebido: ${keys.join(",")}`);
    const stillOneComponent = doc.components.filter((c) => c.id === "led1").length;
    assert(stillOneComponent === 1, "expor não deveria criar nenhuma cópia do componente interno em components[]");
  });

  await test("removeExposedComponent remove só a exposição -- o componente interno em si nunca é afetado", () => {
    let doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 5, y: 5, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    doc = removeExposedComponent(doc, "led1");
    assert(doc.exposedComponents.length === 0, "exposição deveria ter sido removida");
    assert(doc.components.some((c) => c.id === "led1"), "componente interno led1 deveria continuar existindo em components[]");
  });

  await test("pruneInvalidExposedComponentRefs remove referência órfã (componentId que não existe mais) com warning explicativo", () => {
    const doc: SubcircuitDocument = { ...baseDocument(), exposedComponents: [{ componentId: "nao-existe", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 }] };
    const result = pruneInvalidExposedComponentRefs(doc);
    assert(result.document.exposedComponents.length === 0, "referência órfã deveria ser removida");
    assert(result.warnings.length === 1, `esperado 1 warning, recebido ${result.warnings.length}`);
    assert(result.warnings[0]!.includes("nao-existe"), "warning deveria mencionar o componentId órfão");
  });

  await test("pruneInvalidExposedComponentRefs mantém só a PRIMEIRA de 2+ exposições do MESMO componente, com warning (nunca escolhe arbitrariamente)", () => {
    const doc: SubcircuitDocument = {
      ...baseDocument(),
      exposedComponents: [
        { componentId: "led1", x: 1, y: 1, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 },
        { componentId: "led1", x: 2, y: 2, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 1 },
      ],
    };
    const result = pruneInvalidExposedComponentRefs(doc);
    assert(result.document.exposedComponents.length === 1, "só deveria sobrar 1 exposição de led1");
    assert(result.document.exposedComponents[0]!.x === 1, "deveria manter a PRIMEIRA ocorrência (x=1), não escolher arbitrariamente");
    assert(result.warnings.length === 1, "deveria gerar 1 warning explicando a remoção da duplicata");
  });

  await test("pruneInvalidExposedComponentRefs não toca no documento (mesma referência) quando não há nada pra corrigir", () => {
    const doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 5, y: 5, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    const result = pruneInvalidExposedComponentRefs(doc);
    assert(result.warnings.length === 0, "sem problemas, não deveria gerar warnings");
    assert(result.document === doc, "sem mudanças necessárias, deveria devolver a MESMA referência de documento (nunca clonar à toa)");
  });

  await test("exportedPropertyComponentIds é INDEPENDENTE de exposedComponents[] -- expor um componente nunca marca ele como exportado, e vice-versa", () => {
    const doc = setExposedComponent(baseDocument(), { componentId: "led1", x: 5, y: 5, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(doc.exportedPropertyComponentIds.length === 0, "expor um componente não deveria exportar suas propriedades automaticamente");
    const doc2: SubcircuitDocument = { ...baseDocument(), exportedPropertyComponentIds: ["btn1"] };
    assert(doc2.exposedComponents.length === 0, "exportar propriedades não deveria expor o componente automaticamente");
  });

  await test("pruneInvalidExportedPropertyRefs remove referência órfã com warning explicativo", () => {
    const doc: SubcircuitDocument = { ...baseDocument(), exportedPropertyComponentIds: ["nao-existe"] };
    const result = pruneInvalidExportedPropertyRefs(doc);
    assert(result.document.exportedPropertyComponentIds.length === 0, "referência órfã deveria ser removida");
    assert(result.warnings.length === 1, `esperado 1 warning, recebido ${result.warnings.length}`);
    assert(result.warnings[0]!.includes("nao-existe"), "warning deveria mencionar o componentId órfão");
  });

  await test("pruneInvalidExportedPropertyRefs deduplica ids repetidos, mantendo a primeira ocorrência", () => {
    const doc: SubcircuitDocument = { ...baseDocument(), exportedPropertyComponentIds: ["led1", "btn1", "led1"] };
    const result = pruneInvalidExportedPropertyRefs(doc);
    assert(JSON.stringify(result.document.exportedPropertyComponentIds) === JSON.stringify(["led1", "btn1"]), "deveria deduplicar preservando a primeira ocorrência de cada id");
  });

  await test("pruneInvalidExportedPropertyRefs não toca no documento (mesma referência) quando não há nada pra corrigir", () => {
    const doc: SubcircuitDocument = { ...baseDocument(), exportedPropertyComponentIds: ["led1"] };
    const result = pruneInvalidExportedPropertyRefs(doc);
    assert(result.warnings.length === 0, "sem problemas, não deveria gerar warnings");
    assert(result.document === doc, "sem mudanças necessárias, deveria devolver a MESMA referência de documento");
  });

  finish();
})();
