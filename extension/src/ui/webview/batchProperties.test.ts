import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { WebviewComponentModel } from "./model";
import {
  PropertyField,
  computeGenericInstanceFields,
  computeSharedPropertyFields,
  planBatchPropertyChange,
  validateValueForField,
} from "./batchProperties";

function textComponent(id: string, color: string, fontSize = 11, overrides: Partial<WebviewComponentModel> = {}): WebviewComponentModel {
  return {
    id,
    typeId: "graphics.text",
    x: 0,
    y: 0,
    rotation: 0,
    label: id,
    pins: [],
    properties: { text: "Texto", fontSize, color },
    ...overrides,
  };
}

function resistorComponent(id: string, overrides: Partial<WebviewComponentModel> = {}): WebviewComponentModel {
  return {
    id,
    typeId: "passive.resistor",
    x: 10,
    y: 20,
    rotation: 0,
    label: id,
    pins: [{ id: "p1", x: 0, y: 0 }, { id: "p2", x: 10, y: 0 }],
    properties: { resistance: 1000 },
    ...overrides,
  };
}

/** Simula `resolvePropertyFields`/`inferPropertyFields` de `main.ts` -- suficiente pros testes deste
 * módulo, que só precisa de UMA função `(component) => PropertyField[]` injetada, nunca do `main.ts`
 * inteiro (que tem DOM/side-effects no top-level, não roda em Node). */
function inferFields(component: WebviewComponentModel): PropertyField[] {
  const fields: PropertyField[] = [];
  for (const [key, value] of Object.entries(component.properties)) {
    fields.push({
      key,
      label: key,
      kind: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text",
      value,
      group: "principal",
    });
  }
  return fields;
}

(async () => {
  const { test, finish } = createTestRunner("batchProperties - computeSharedPropertyFields/planBatchPropertyChange");

  await test("cor comum entre vários graphics.text vira 1 patch por componente ao aplicar", () => {
    const components = [textComponent("t1", "#111111"), textComponent("t2", "#111111"), textComponent("t3", "#111111")];
    const fields = computeSharedPropertyFields(components, inferFields);
    const colorField = fields.find((f) => f.key === "color");
    assert(colorField !== undefined, "campo 'color' deveria ser compartilhado (presente e mesmo kind em todos)");
    assert(colorField!.value.state === "common" && colorField!.value.value === "#111111", "valor comum deveria ser exibido, não misto");

    const plan = planBatchPropertyChange(components, colorField!, "#ff0000");
    assert(plan.ok === true, "aplicar uma cor válida a todos deveria ser aceito");
    if (plan.ok) {
      assert(plan.patches.length === 3, `esperado 1 patch por componente (3), recebido ${plan.patches.length}`);
      assert(plan.patches.every((p) => p.key === "color" && p.value === "#ff0000" && p.source === "properties"), "todos os patches deveriam setar color=#ff0000 via 'properties'");
    }
  });

  await test("valores diferentes pra mesma propriedade exibem estado misto, sem escolher um dos valores existentes", () => {
    const components = [textComponent("t1", "#111111"), textComponent("t2", "#222222")];
    const fields = computeSharedPropertyFields(components, inferFields);
    const colorField = fields.find((f) => f.key === "color");
    assert(colorField !== undefined, "campo 'color' deveria continuar compartilhado mesmo com valores diferentes");
    assert(colorField!.value.state === "mixed", `esperado estado misto, recebido ${JSON.stringify(colorField!.value)}`);
  });

  await test("aplicar UMA propriedade não gera patch para as outras (preserva o que não foi alterado)", () => {
    const components = [textComponent("t1", "#111111", 11), textComponent("t2", "#111111", 14)];
    const fields = computeSharedPropertyFields(components, inferFields);
    const colorField = fields.find((f) => f.key === "color")!;
    const fontSizeField = fields.find((f) => f.key === "fontSize")!;
    assert(fontSizeField.value.state === "mixed", "fontSize deveria estar misto (11 vs 14) antes de qualquer edição");

    const plan = planBatchPropertyChange(components, colorField, "#00ff00");
    assert(plan.ok === true, "aplicar color deveria ser aceito");
    if (plan.ok) {
      assert(plan.patches.every((p) => p.key === "color"), "só deveria haver patches de 'color' -- fontSize não foi tocado, não deveria aparecer nos patches");
      assert(!plan.patches.some((p) => p.key === "fontSize"), "fontSize (não editado) não deveria ser incluído no patch");
    }
  });

  await test("seleção de tipos diferentes: propriedade específica de um typeId NÃO aparece, mas campos genéricos (rotation) continuam disponíveis", () => {
    const components: WebviewComponentModel[] = [textComponent("t1", "#111111"), resistorComponent("r1")];
    const typeSpecificFields = computeSharedPropertyFields(components, inferFields);
    assert(typeSpecificFields.find((f) => f.key === "color") === undefined, "'color' só existe em graphics.text -- não deveria aparecer como compartilhado com um resistor selecionado junto");
    assert(typeSpecificFields.find((f) => f.key === "resistance") === undefined, "'resistance' só existe no resistor -- não deveria aparecer como compartilhado");

    const genericFields = computeGenericInstanceFields(components);
    const rotationField = genericFields.find((f) => f.key === "rotation");
    assert(rotationField !== undefined, "rotation é genérico -- deveria estar disponível mesmo com tipos diferentes selecionados");
    assert(rotationField!.source === "instance", "rotation deveria ser 'instance' (campo top-level, não bag de properties)");

    const plan = planBatchPropertyChange(components, rotationField!, "90");
    assert(plan.ok === true, "aplicar rotation a tipos heterogêneos deveria ser aceito (campo genérico)");
    if (plan.ok) assert(plan.patches.length === 2 && plan.patches.every((p) => p.source === "instance" && p.key === "rotation"), "ambos componentes deveriam receber patch instance/rotation");
  });

  await test("rejeita e não gera NENHUM patch quando um componente não aceitaria o valor (tudo ou nada)", () => {
    const strict: WebviewComponentModel = textComponent("t1", "#111111");
    const lenient: WebviewComponentModel = textComponent("t2", "#111111");
    const components = [strict, lenient];
    // Simula um schema com 'options' restritas só pro primeiro componente (heterogeneidade de faixa/opção mesmo com o mesmo kind).
    const resolveWithOptions = (component: WebviewComponentModel): PropertyField[] => {
      const base = inferFields(component);
      return base.map((field) =>
        field.key === "color" && component.id === "t1"
          ? { ...field, kind: "select" as const, options: [{ value: "#111111", label: "Escuro" }] }
          : field.key === "color"
            ? { ...field, kind: "select" as const }
            : field
      );
    };
    const fields = computeSharedPropertyFields(components, resolveWithOptions);
    const colorField = fields.find((f) => f.key === "color")!;
    const plan = planBatchPropertyChange(components, colorField, "#ff0000");
    assert(plan.ok === false, "valor fora das 'options' de um dos componentes deveria rejeitar o lote inteiro");
    if (!plan.ok) assert(plan.invalidComponentIds.includes("t1"), "t1 (options restritas) deveria estar entre os inválidos");
  });

  await test("validateValueForField: number respeita min/max PRÓPRIO do campo; select respeita options PRÓPRIAS", () => {
    const numberField: PropertyField = { key: "n", label: "n", kind: "number", value: 5, group: "g", min: 0, max: 10 };
    assert(validateValueForField(numberField, 5) === true, "5 dentro de [0,10] deveria ser válido");
    assert(validateValueForField(numberField, 20) === false, "20 fora de [0,10] deveria ser inválido");
    assert(validateValueForField(numberField, Number.NaN) === false, "NaN nunca é válido pra number");

    const selectField: PropertyField = { key: "s", label: "s", kind: "select", value: "a", group: "g", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };
    assert(validateValueForField(selectField, "b") === true, "'b' está nas options, deveria ser válido");
    assert(validateValueForField(selectField, "c") === false, "'c' não está nas options, deveria ser inválido");
  });

  await test("planBatchPropertyChange produz UM único conjunto atômico de patches (pré-condição pro Undo/Redo tratar como 1 passo)", () => {
    const components = [textComponent("t1", "#111111"), textComponent("t2", "#111111"), textComponent("t3", "#111111")];
    const fields = computeSharedPropertyFields(components, inferFields);
    const colorField = fields.find((f) => f.key === "color")!;
    const plan = planBatchPropertyChange(components, colorField, "#abcdef");
    assert(plan.ok === true, "aplicar deveria ser aceito");
    if (plan.ok) {
      const ids = new Set(plan.patches.map((p) => p.componentId));
      assert(ids.size === components.length, "o plano deveria cobrir TODOS os componentes selecionados numa única resposta (aplicado de uma vez, nunca em lotes parciais separados)");
    }
  });

  finish();
})();
