import * as fs from "fs";
import * as path from "path";
import type { BlockLibraryFile } from "../ui/webview/blockLibrary/spec";

/**
 * Lê a especificação da biblioteca de blocos equivalente ao Simulink (docs/66 §3) -- os MESMOS
 * arquivos que o Core embute no executável. No repositório ficam em `project/schema/block-library`;
 * no pacote instalado, em `bundled/project/schema/block-library`.
 */
export function blockLibraryDirectory(extensionPath: string): string | undefined {
  const candidates = [
    path.join(extensionPath, "..", "project", "schema", "block-library"),
    path.join(extensionPath, "bundled", "project", "schema", "block-library"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

let cache: { directory: string; stamp: string; files: BlockLibraryFile[] } | undefined;

export function loadBlockLibrary(extensionPath: string): BlockLibraryFile[] {
  const directory = blockLibraryDirectory(extensionPath);
  if (!directory) return [];
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const stamp = names.map((name) => `${name}:${fs.statSync(path.join(directory, name)).mtimeMs}`).join("|");
  if (cache && cache.directory === directory && cache.stamp === stamp) return cache.files;
  const files = names.map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8").replace(/^﻿/, "")) as BlockLibraryFile);
  files.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  cache = { directory, stamp, files };
  return files;
}
