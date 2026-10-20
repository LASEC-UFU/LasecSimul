import type { WebviewGeometry } from "./visualDocument.js";

/**
 * Geometria da janela do SO que hospeda esta Webview (docs/61 §6.3). Dentro do *iframe* da Webview,
 * `screenX/Y` e `outer*` são os da janela de nível superior e `screen.*` é o do monitor em que ela
 * está -- é a única forma de uma extensão saber se a tela está acoplada, flutuante, maximizada ou em
 * tela cheia, e em qual monitor (medido no experimento da PoC).
 */
export function readWebviewGeometry(): WebviewGeometry {
  return {
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: (screen as Screen & { availLeft?: number }).availLeft ?? 0,
      availTop: (screen as Screen & { availTop?: number }).availTop ?? 0,
    },
  };
}

/** Avisa a cada mudança: `resize` (com atraso, o redimensionamento chega em rajada) e uma checagem
 * por segundo, porque MOVER a janela (inclusive para outro monitor) não dispara evento nenhum. Logo
 * após a Webview ser recriada a altura pode vir 0 (visto no VS Code 1.141): esse quadro é ignorado. */
export function watchWebviewGeometry(post: (geometry: WebviewGeometry) => void): void {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    const geometry = readWebviewGeometry();
    if (geometry.innerHeight <= 0 || geometry.innerWidth <= 0) return;
    const key = JSON.stringify(geometry);
    if (key === last) return;
    last = key;
    post(geometry);
  };
  window.addEventListener("resize", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 250);
  });
  setInterval(check, 1000);
  setTimeout(check, 0);
}
