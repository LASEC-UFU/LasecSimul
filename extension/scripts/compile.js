"use strict";

// Achado real (2026-07-18): `"compile": "tsc -p ./ && tsc -p ./tsconfig.webview.json"` usava `&&`,
// que em QUALQUER shell (cmd.exe/PowerShell/sh) só roda o segundo comando se o primeiro sair com
// código 0. `tsc` sai com código != 0 quando há QUALQUER erro de tipo em QUALQUER arquivo do host
// (`src/**/*.ts` exceto a Webview), mesmo um erro sem nenhuma relação com o que está sendo testado
// -- e como `noEmitOnError` não está setado em `tsconfig.json`, o host ainda EMITE `out/` (mesmo com
// erro), mas o `&&` nunca deixa o segundo `tsc` (Webview) rodar. Resultado: `out-webview/main.js`
// fica congelado no último build que teve sucesso, silenciosamente, até o erro do HOST (não
// necessariamente relacionado à mudança que se está testando na Webview) ser corrigido -- e o
// sintoma reportado ("aperto F5, minhas mudanças na Webview não aparecem") persiste mesmo depois de
// reabrir o painel, porque o arquivo em disco genuinamente não mudou. Este script roda os dois
// `tsc` SEMPRE, incondicionalmente (host e Webview são unidades de compilação independentes, uma
// não precisa da outra ter sucesso), e só propaga falha (`process.exitCode`) no final -- preserva o
// comportamento de "compile falha => pretest/CI falham", mas nunca deixa um alvo starve o outro.
const { spawnSync } = require("child_process");

// Roda o MESMO executável Node desta task (`process.execPath`) sobre o script CLI do `tsc` resolvido
// via `require.resolve` -- não depende de PATH, de `npm.cmd` nem de extensão de binário por SO,
// então funciona idêntico em cmd.exe, PowerShell e sh sem ambiguidade de shell.
const tscBin = require.resolve("typescript/bin/tsc");

function runProject(label, tsconfigPath) {
  console.log(`> tsc -p ${tsconfigPath}`);
  const result = spawnSync(process.execPath, [tscBin, "-p", tsconfigPath], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`compile: falhou (${label}), veja os erros de tsc acima.`);
  }
  return result.status === 0;
}

const hostOk = runProject("host", "./");
const webviewOk = runProject("webview", "./tsconfig.webview.json");

process.exitCode = hostOk && webviewOk ? 0 : 1;
