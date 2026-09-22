/**
 * Z-order da cena, como função pura.
 *
 * A ordem de empilhamento É a ordem do array de componentes (quem vem depois desenha por cima, ver
 * `main.ts::render()`), e essa ordem já é preservada na serialização (`ProjectSerializer` e
 * `subcircuitDocument` gravam `components[]` na ordem). Por isso reordenar o array é a
 * implementação inteira: não existe campo `zIndex` no modelo nem no arquivo.
 *
 * Telas de processo dependem disso o tempo todo: casco do tanque → líquido → tubo → válvula →
 * instrumento → texto é uma PILHA, não um conjunto. Sem isto, desenhar a válvula antes do tubo
 * significa refazer a válvula.
 *
 * Esta função devolve a NOVA ORDEM DE IDS e não toca em nada. Quem chama aplica o resultado com um
 * `splice` no mesmo array -- `activeSceneComponents()` devolve a referência viva da cena ativa
 * (circuito/Símbolo/Ícone), então trocar o objeto quebraria quem guardou a referência.
 */

export type ZOrderMode = "front" | "back" | "forward" | "backward";

/**
 * `order` é a ordem atual (do fundo para a frente) e `selected` os ids que se movem.
 *
 * Devolve `undefined` quando nada muda -- seleção vazia, cena com menos de dois itens, tudo
 * selecionado, ou um passo que esbarra na ponta da pilha. Quem chama usa isso para não gravar nem
 * repintar à toa, que é o que faz segurar `Ctrl+]` parar de fazer sentido quando já se chegou ao
 * topo.
 */
export function reorderedZOrder(
  order: readonly string[],
  selected: ReadonlySet<string>,
  mode: ZOrderMode,
): string[] | undefined {
  if (selected.size === 0 || order.length < 2) return undefined;
  const next = [...order];
  const isSelected = (index: number): boolean => selected.has(next[index]!);

  if (mode === "front" || mode === "back") {
    const moved = next.filter((id) => selected.has(id));
    const rest = next.filter((id) => !selected.has(id));
    // Tudo selecionado: mandar a pilha inteira para a frente não muda pilha nenhuma.
    if (moved.length === 0 || rest.length === 0) return undefined;
    const result = mode === "front" ? [...rest, ...moved] : [...moved, ...rest];
    return sameOrder(order, result) ? undefined : result;
  }

  if (mode === "forward") {
    // De trás para a frente: na direção contrária, o primeiro item movido empurraria o próximo
    // selecionado e a ordem RELATIVA da seleção mudaria a cada clique -- dois objetos escolhidos
    // juntos trocariam de posição entre si, que não é o que "trazer para frente" quer dizer.
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (!isSelected(index) || isSelected(index + 1)) continue;
      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
    }
  } else {
    for (let index = 1; index < next.length; index += 1) {
      if (!isSelected(index) || isSelected(index - 1)) continue;
      [next[index], next[index - 1]] = [next[index - 1]!, next[index]!];
    }
  }
  return sameOrder(order, next) ? undefined : next;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return true;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Traduz um atalho de teclado em modo de z-order, ou `undefined` quando a tecla não é uma das
 * quatro.
 *
 * O casamento é pelo GLIFO e não por `event.code`: com `Shift` o layout US entrega `}` no lugar de
 * `]`, e no ABNT2 os colchetes não ficam na posição física `BracketLeft`/`BracketRight`. Aceitar os
 * quatro glifos cobre os dois layouts sem depender da geometria do teclado.
 */
export function zOrderModeForKey(key: string, shiftKey: boolean): ZOrderMode | undefined {
  const towardsFront = key === "]" || key === "}";
  const towardsBack = key === "[" || key === "{";
  if (!towardsFront && !towardsBack) return undefined;
  if (shiftKey) return towardsFront ? "front" : "back";
  return towardsFront ? "forward" : "backward";
}
