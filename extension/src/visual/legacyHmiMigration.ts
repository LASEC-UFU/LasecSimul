import type { HmiApplication, WebviewComponentModel } from "../ui/webview/model";
import { HMI_SCREEN_TYPE_ID, VISUAL_DOCUMENT_SCHEMA_VERSION, uniqueScreenId, type VisualDocument } from "../ui/webview/visualDocument";

/**
 * Projetos anteriores guardavam UMA aplicação HMI por projeto (`hmiApplication`), editada dentro do
 * esquemático. Na abertura ela vira uma Tela HMI (docs/62 §12.1): o mesmo conteúdo (páginas,
 * elementos, navegação, STALE, auditoria) num documento próprio, e um botão `tools.hmi_screen` no
 * esquemático, colocado ACIMA do circuito existente -- nenhum componente é movido.
 */
export function migrateLegacyHmiApplication(
  application: HmiApplication,
  components: readonly WebviewComponentModel[],
  takenScreenIds: ReadonlySet<string>,
  takenComponentIds: ReadonlySet<string>,
): { document: VisualDocument; button: WebviewComponentModel } {
  const id = uniqueScreenId(takenScreenIds);
  const title = "Tela HMI";
  const document: VisualDocument = {
    ...structuredClone(application),
    schemaVersion: VISUAL_DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "screen",
    title,
    presentation: { fullscreenContext: "lab" },
  };
  const minX = components.length > 0 ? Math.min(...components.map((component) => component.x)) : 40;
  const minY = components.length > 0 ? Math.min(...components.map((component) => component.y)) : 120;
  let buttonId = "tela-hmi";
  for (let index = 2; takenComponentIds.has(buttonId); index += 1) buttonId = `tela-hmi-${index}`;
  const button: WebviewComponentModel = {
    id: buttonId,
    typeId: HMI_SCREEN_TYPE_ID,
    label: title,
    x: Math.round(minX / 8) * 8,
    y: Math.round((minY - 96) / 8) * 8,
    rotation: 0,
    pins: [],
    showId: false,
    showValue: false,
    properties: { title, screenId: id, width: 176, height: 64 },
  };
  return { document, button };
}
