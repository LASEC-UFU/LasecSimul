import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { reorderedZOrder, zOrderModeForKey } from "./zOrder";

const order = (...ids: string[]): string[] => ids;
const sel = (...ids: string[]): Set<string> => new Set(ids);
const apply = (ids: string[], selected: Set<string>, mode: Parameters<typeof reorderedZOrder>[2]): string =>
  (reorderedZOrder(ids, selected, mode) ?? ids).join("");

(async () => {
  const { test, finish } = createTestRunner("zOrder");

  await test("frente/fundo movem a selecao para a ponta da pilha", () => {
    const stack = order("a", "b", "c", "d");
    assert(apply(stack, sel("b"), "front") === "acdb", `front: veio ${apply(stack, sel("b"), "front")}`);
    assert(apply(stack, sel("c"), "back") === "cabd", `back: veio ${apply(stack, sel("c"), "back")}`);
  });

  await test("um passo move exatamente uma posicao", () => {
    const stack = order("a", "b", "c", "d");
    assert(apply(stack, sel("b"), "forward") === "acbd", `forward: veio ${apply(stack, sel("b"), "forward")}`);
    assert(apply(stack, sel("c"), "backward") === "acbd", `backward: veio ${apply(stack, sel("c"), "backward")}`);
  });

  await test("selecao multipla preserva a ordem RELATIVA entre os escolhidos", () => {
    // O bug que a direcao da varredura evita: percorrendo na direcao errada, o primeiro item movido
    // empurra o proximo selecionado e os dois trocam de posicao ENTRE SI a cada clique -- "trazer
    // para frente" nao pode reembaralhar o que o usuario escolheu junto.
    const stack = order("a", "b", "c", "d", "e");
    assert(apply(stack, sel("b", "c"), "forward") === "adbce", `forward duplo: veio ${apply(stack, sel("b", "c"), "forward")}`);
    assert(apply(stack, sel("c", "d"), "backward") === "acdbe", `backward duplo: veio ${apply(stack, sel("c", "d"), "backward")}`);
    // Seleção esparsa: os escolhidos vão juntos para a frente, mas "a" continua antes de "c".
    assert(apply(stack, sel("a", "c"), "front") === "bdeac", `front esparso: veio ${apply(stack, sel("a", "c"), "front")}`);
    assert(apply(stack, sel("a", "c"), "back") === "acbde", `back esparso: veio ${apply(stack, sel("a", "c"), "back")}`);
  });

  await test("nao muda nada quando nao ha para onde ir", () => {
    // Importa porque quem chama grava o projeto e repinta: um passo que nao move nada nao pode
    // sujar o arquivo nem forcar render. Segurar `Ctrl+]` no topo tem que virar no-op.
    assert(reorderedZOrder(order("a", "b"), sel("b"), "forward") === undefined, "topo nao avanca");
    assert(reorderedZOrder(order("a", "b"), sel("b"), "front") === undefined, "topo ja' esta' na frente");
    assert(reorderedZOrder(order("a", "b"), sel("a"), "backward") === undefined, "fundo nao recua");
    assert(reorderedZOrder(order("a", "b"), sel("a"), "back") === undefined, "fundo ja' esta' atras");
    assert(reorderedZOrder(order("a", "b"), sel("a", "b"), "front") === undefined, "tudo selecionado nao reordena");
    assert(reorderedZOrder(order("a", "b"), sel(), "front") === undefined, "selecao vazia");
    assert(reorderedZOrder(order("a"), sel("a"), "front") === undefined, "cena com um item");
  });

  await test("ids desconhecidos na selecao sao ignorados sem quebrar", () => {
    // A selecao pode conter fios e rotulos, que nao participam da pilha de componentes.
    assert(apply(order("a", "b", "c"), sel("b", "fio-7"), "front") === "acb", "id fora da cena nao atrapalha");
    assert(reorderedZOrder(order("a", "b"), sel("nada"), "front") === undefined, "so' ids fora da cena: nada muda");
  });

  await test("a funcao e' pura: o array de entrada nunca e' mutado", () => {
    const stack = order("a", "b", "c");
    const before = stack.join("");
    reorderedZOrder(stack, sel("a"), "front");
    assert(stack.join("") === before, `entrada foi mutada: ${before} -> ${stack.join("")}`);
  });

  await test("atalhos: colchete resolve o modo nos layouts US e ABNT2", () => {
    // Com Shift o layout US entrega `}`/`{` no lugar de `]`/`[`; aceitar os quatro glifos e' o que
    // faz o atalho funcionar nos dois teclados sem depender de `event.code`.
    assert(zOrderModeForKey("]", false) === "forward", "Ctrl+]");
    assert(zOrderModeForKey("[", false) === "backward", "Ctrl+[");
    assert(zOrderModeForKey("}", true) === "front", "Ctrl+Shift+] (glifo US)");
    assert(zOrderModeForKey("{", true) === "back", "Ctrl+Shift+[ (glifo US)");
    assert(zOrderModeForKey("]", true) === "front", "Ctrl+Shift+] (glifo ABNT2)");
    assert(zOrderModeForKey("[", true) === "back", "Ctrl+Shift+[ (glifo ABNT2)");
    assert(zOrderModeForKey("a", false) === undefined, "tecla qualquer nao e' z-order");
    assert(zOrderModeForKey("r", true) === undefined, "nao colide com girar");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
