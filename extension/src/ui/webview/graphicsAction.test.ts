import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  graphicalActionConfig,
  isGraphicalActionTypeId,
  parseGraphicalActionValue,
  resolveGraphicalActionValue,
} from "./graphicsAction";

(async () => {
  const { test, finish } = createTestRunner("graphicsAction — HMI para simulação");

  await test("literal de ação preserva booleano, número e texto", () => {
    assert(parseGraphicalActionValue("true") === true, "true deveria virar booleano");
    assert(parseGraphicalActionValue("12.5") === 12.5, "número deveria virar number");
    assert(parseGraphicalActionValue("OPEN") === "OPEN", "comando textual deveria permanecer texto");
  });

  await test("configuração exige alvo e propriedade estáveis", () => {
    assert(graphicalActionConfig({ actionTarget: "", actionProperty: "position" }) === undefined, "alvo vazio deveria invalidar");
    const config = graphicalActionConfig({ actionTarget: "fcv101", actionProperty: "position", actionMode: "set", actionValue: "63" });
    assert(config?.targetId === "fcv101" && config.property === "position" && config.value === 63, "configuração válida não foi resolvida");
  });

  await test("toggle alterna entre valores autorados", () => {
    const config = graphicalActionConfig({ actionTarget: "dist", actionProperty: "enabled", actionMode: "toggle", actionValue: "true", actionReleaseValue: "false" })!;
    assert(resolveGraphicalActionValue(config, false, "activate") === true, "toggle desligado deveria ligar");
    assert(resolveGraphicalActionValue(config, true, "activate") === false, "toggle ligado deveria desligar");
  });

  await test("momentâneo separa pressionar de soltar", () => {
    const config = graphicalActionConfig({ actionTarget: "valve", actionProperty: "command", actionMode: "momentary", actionValue: "OPEN", actionReleaseValue: "HOLD" })!;
    assert(resolveGraphicalActionValue(config, "HOLD", "press") === "OPEN", "press deveria escrever comando");
    assert(resolveGraphicalActionValue(config, "OPEN", "release") === "HOLD", "release deveria escrever repouso");
    assert(resolveGraphicalActionValue(config, "HOLD", "activate") === undefined, "activate isolado não serve para momentâneo");
  });

  await test("incremento respeita limites", () => {
    const config = graphicalActionConfig({ actionTarget: "sp", actionProperty: "value", actionMode: "increment", actionStep: 7, actionMin: 0, actionMax: 100 })!;
    assert(resolveGraphicalActionValue(config, 96, "activate") === 100, "incremento deveria saturar no máximo");
    assert(resolveGraphicalActionValue(config, -3, "activate") === 4, "incremento deveria partir do valor atual");
  });

  await test("entrada explícita usa faixa e serve slider/setpoint", () => {
    const config = graphicalActionConfig({ actionTarget: "fic", actionProperty: "setpoint", actionMode: "set", actionMin: 0, actionMax: 60 })!;
    assert(resolveGraphicalActionValue(config, 10, "input", 75) === 60, "entrada deveria saturar no máximo");
    assert(resolveGraphicalActionValue(config, 10, "input", 32.5) === 32.5, "entrada dentro da faixa deveria passar");
  });

  await test("somente widgets operadores são ações", () => {
    assert(isGraphicalActionTypeId("graphics.hmi_button"), "botão deveria ser operador");
    assert(isGraphicalActionTypeId("graphics.hmi_lamp_button"), "botão luminoso deveria ser operador");
    assert(isGraphicalActionTypeId("graphics.slider"), "slider deveria ser operador");
    assert(!isGraphicalActionTypeId("graphics.status_lamp"), "lâmpada é indicador, não ação");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
