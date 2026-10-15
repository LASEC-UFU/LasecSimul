/*
 * Variáveis que o depurador do OpenPLC pode ler e forçar no CLP do LasecSimul.
 *
 * O Core gera, para cada build, o `driver.cpp` do worker (core/src/plc/PlcDriverCodegen.cpp) com a
 * tabela `allVars` que plcGet/plcSet/plcForce usam: as escalares do programa e também os membros de
 * instâncias de FB (`T1.Q`, `FLIP.EDGE.CLK`), campos de struct e elementos de vetor (`ARR[3]`). O mapa
 * de depuração do editor sai dessa tabela, então a árvore de variáveis do OpenPLC mostra o que o CLP
 * simulado tem de fato.
 */

import * as fs from "fs";
import * as path from "path";

export interface DriverMonitorVariable {
  /** Nome no programa, como o Core o aceita depois de `PROGRAMA.` (`T1.Q`, `ARR[3]`). */
  name: string;
  /** Tipo IEC da tag do driver (`BOOL`, `INT`, `TIME`...). */
  type: string;
}

/** Linhas `{"T1.Q", VarTypeTag::BOOL, &...}` do bloco `allVars` (tags sem tipo IEC ficam de fora). */
export function driverMonitorVariables(driverSource: string): DriverMonitorVariable[] {
  const start = driverSource.indexOf("std::vector<VarDescriptor> allVars = {");
  if (start < 0) return [];
  const end = driverSource.indexOf("};", start);
  const block = driverSource.slice(start, end < 0 ? undefined : end);
  return [...block.matchAll(/\{"([^"]+)", VarTypeTag::([A-Z]+),/g)]
    .filter(match => match[2] !== "OTHER")
    .map(match => ({ name: match[1]!, type: match[2]! }));
}

/** Tabela do driver ao lado do executável do worker de um build (vazia se o arquivo não existir). */
export function driverMonitorVariablesForBinary(nativeBinaryRef: string): DriverMonitorVariable[] {
  const driver = path.join(path.dirname(nativeBinaryRef), "driver.cpp");
  return fs.existsSync(driver) ? driverMonitorVariables(fs.readFileSync(driver, "utf8")) : [];
}
