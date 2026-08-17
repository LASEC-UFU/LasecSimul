import * as path from "path";

/** Converte caminhos persistidos em caminhos de runtime. O projeto continua portátil no disco,
 * mas nenhuma camada posterior precisa conhecer o diretório corrente do `.lsproj`. */
export function resolveProjectSourcePaths(sources: readonly string[], projectDir: string): string[] {
  return sources.map((source) => path.isAbsolute(source)
    ? path.normalize(source)
    : path.resolve(projectDir, source));
}

