/** Ícones próprios em SVG 24×24 (traço em currentColor). NÃO derivam dos ícones do GeoGebra (CC BY-NC-SA 4.0). */
const icon = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  move: icon('<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>'),
  secant: icon('<path d="M3 20c6 0 9-9 18-15" opacity=".55"/><path d="M4 17L20 6"/><circle cx="8" cy="14.2" r="1.9" fill="currentColor"/><circle cx="16.5" cy="8.4" r="1.9" fill="currentColor"/>'),
  tangent: icon('<path d="M3 20c6 0 9-9 18-15" opacity=".55"/><path d="M5 19.5L21 9.5"/><circle cx="12.6" cy="14.8" r="2" fill="currentColor"/>'),
  riemann: icon('<path d="M3 21h18"/><rect x="4" y="13" width="3.6" height="8"/><rect x="7.6" y="10" width="3.6" height="11"/><rect x="11.2" y="8" width="3.6" height="13"/><rect x="14.8" y="6.5" width="3.6" height="14.5"/>'),
  cursor: icon('<path d="M12 3v18" stroke-dasharray="3 2"/><path d="M8 3h8M8 21h8"/><circle cx="12" cy="11" r="2" fill="currentColor"/>'),
  zoomIn: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>'),
  zoomOut: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>'),
  resetView: icon('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><path d="M12 9v3l2 2"/>'),
  deltaZero: icon('<path d="M4 18L9 6l5 12z"/><path d="M15 12h6M15 15h6"/><circle cx="19" cy="7" r="2.4"/>'),
  sideRight: icon('<path d="M3 12h11"/><path d="M10 8l4 4-4 4"/><circle cx="18.5" cy="12" r="2.5" fill="currentColor"/>'),
  sideLeft: icon('<path d="M21 12H10"/><path d="M14 8l-4 4 4 4"/><circle cx="5.5" cy="12" r="2.5" fill="currentColor"/>'),
  keyboard: icon('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 13h.01M18 13h.01M8.5 14.5h7"/>'),
  play: icon('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>'),
  pause: icon('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  restart: icon('<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>'),
  live: icon('<circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>'),
  save: icon('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
  teacher: icon('<circle cx="12" cy="7" r="3.2"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/><path d="M17 4l3 1.5-3 1.5"/>'),
} as const;

export type IconName = keyof typeof ICONS;

/** Botão com ícone, rótulo acessível e dica visível. */
export function iconButton(name: IconName, label: string, options: { id?: string; pressed?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.innerHTML = ICONS[name];
  button.title = label;
  button.setAttribute("aria-label", label);
  if (options.id) button.id = options.id;
  if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
  return button;
}
