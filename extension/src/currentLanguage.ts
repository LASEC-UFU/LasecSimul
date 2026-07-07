import * as vscode from "vscode";
import { LasecSimulLanguage, resolveLasecSimulLanguage } from "./language";

/** Wrapper impuro (lê `vscode.workspace`/`vscode.env` ao vivo) em volta de
 * `resolveLasecSimulLanguage` (deliberadamente pura, ver `language.ts`) -- extraído de
 * `extension.ts` (EX-9, .spec/lasecsimul-native-devices.spec) pra um arquivo próprio sem
 * dependência de volta pra `extension.ts`, já que módulos de domínio (ex:
 * `catalog/registeredSources.ts`) também precisam dele e uma importação circular quebraria o build. */
export function currentLasecSimulLanguage(): LasecSimulLanguage {
  const configured = vscode.workspace.getConfiguration("lasecsimul").get<string>("language", "system");
  return resolveLasecSimulLanguage(configured, vscode.env.language);
}
