"use strict";

// Browser ESM resolves relative imports exactly as written. TypeScript accepts
// `./module`, but the VS Code Webview requests that URL without adding `.js`.
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..", "out-webview");
const failures = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(file);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const imports = ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), imported.fileName);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(`${path.relative(root, file)}: ${imported.fileName}`);
      }
    }
  }
}

if (!fs.existsSync(root)) {
  console.error(`Webview output missing: ${root}`);
  process.exit(1);
}
visit(root);
if (failures.length) {
  console.error(`Unresolvable Webview ESM imports:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Webview ESM imports resolved.");
