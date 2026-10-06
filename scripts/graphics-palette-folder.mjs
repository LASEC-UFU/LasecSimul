/** Une os controles HMI e indicadores nativos/IPD na mesma pasta da paleta. */
export function graphicsPaletteFolder(folder) {
  if (folder[0] === "Indicadores" || folder[0] === "Controles HMI") {
    return ["Controles/Indicadores", "Controls/Indicators"];
  }
  return folder;
}
