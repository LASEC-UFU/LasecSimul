// Roda um teste compilado da extensão (out/...) a partir do espelho de junções do repositório
// (test/e2e/openplc-lab.cjs): mesmo código e mesmo Core compilado, mas sem as fontes do Core que
// outra pessoa esteja editando, que fazem a extensão recusar o Core como desatualizado.
// Uso: node test/run-mirrored.cjs out/plc/openplc/legacyIecProject.realCore.test.js
const path = require("path");
const { spawnSync } = require("child_process");
const { prepareMirror, removeMirror, harnessRoot } = require("./e2e/openplc-lab.cjs");

const script = process.argv[2];
if (!script) {
  console.error("uso: node test/run-mirrored.cjs <script em out/>");
  process.exit(2);
}
const extension = prepareMirror();
let status = 1;
try {
  // Script de fora da extensão roda como está, com o diretório de trabalho no espelho.
  const relative = path.relative(harnessRoot, path.resolve(script));
  const mirrored = relative.startsWith("..") || path.isAbsolute(relative) ? path.resolve(script) : path.join(extension, relative);
  // Sem --preserve-symlinks o Node segue a junção e __dirname volta a ser o repositório.
  status = spawnSync(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", mirrored, ...process.argv.slice(3)], {
    cwd: extension,
    stdio: "inherit",
  }).status ?? 1;
} finally {
  removeMirror(extension);
}
process.exit(status);
