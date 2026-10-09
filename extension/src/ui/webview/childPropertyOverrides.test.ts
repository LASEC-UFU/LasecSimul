import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import {
  childPropertyKey,
  childPropertyOverrides,
  effectiveChildProperties,
  parseChildPropertyKey,
  withoutChildPropertyOverrides,
} from "./childPropertyOverrides";

(async () => {
  const { test, finish } = createTestRunner("propriedades exportadas por instância");

  await test("a chave @interno.prop identifica o componente interno e a propriedade", () => {
    assert(childPropertyKey("ld301", "hartVariablesJson") === "@ld301.hartVariablesJson", "formato da chave");
    const parsed = parseChildPropertyKey("@c_sg_seal.value");
    assert(parsed?.innerComponentId === "c_sg_seal" && parsed.name === "value", JSON.stringify(parsed));
    assert(parseChildPropertyKey("value") === undefined && parseChildPropertyKey("@semponto") === undefined &&
           parseChildPropertyKey("@.x") === undefined && parseChildPropertyKey("@x.") === undefined, "chaves inválidas");
  });

  await test("as chaves da instância não vão para o addComponent e viram uma lista de aplicações", () => {
    const properties = { label: "LT-1", "@ld301.tag": "LT101", "@c_height.value": 2.5, "@x.obj": { not: "scalar" } };
    assert(JSON.stringify(withoutChildPropertyOverrides(properties)) === JSON.stringify({ label: "LT-1" }), "sobram só as da instância");
    const overrides = childPropertyOverrides(properties);
    assert(overrides.length === 2 && overrides.some((o) => o.innerComponentId === "c_height" && o.value === 2.5), JSON.stringify(overrides));
  });

  await test("o valor efetivo é o do modelo com o da instância por cima, só do componente certo", () => {
    const model = { value: 3, unit: "m" };
    const instance = { "@c_height.value": 2, "@c_gas.value": 80 };
    const effective = effectiveChildProperties(model, instance, "c_height");
    assert(effective.value === 2 && effective.unit === "m", JSON.stringify(effective));
    assert(effectiveChildProperties(model, instance, "c_diameter").value === 3, "outro componente fica com o valor do modelo");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
