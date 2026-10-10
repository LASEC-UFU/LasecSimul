import * as http from "http";
import type { AddressInfo } from "net";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { openReleaseAsset, readBody } from "./releaseAssets";

/**
 * Download dos arquivos da release (setup.exe, SHA256SUMS.txt) usado pela instalação da rede
 * lab-router. Um servidor local faz o papel do GitHub: o link público pode responder 403 ("Access
 * to this site has been restricted" para o IP, como no servidor do laboratório em 2026-10-09) e a
 * API entrega o asset por redirecionamento para outro host.
 */
const { test, finish } = createTestRunner("Arquivos da release do GitHub");

const REPO = "LASEC-UFU/LasecSimul";
const SUMS = "abc123  lasecsimul-1.2.3-win32-x64-setup.exe\n";

interface FakeGitHub {
  base: string;
  webStatus: number;
  requests: Array<{ path: string; accept?: string }>;
  close: () => Promise<void>;
}

async function fakeGitHub(webStatus: number): Promise<FakeGitHub> {
  const requests: FakeGitHub["requests"] = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? "";
    requests.push({ path, accept: request.headers.accept });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (path === `/web/${REPO}/releases/download/v1.2.3/SHA256SUMS.txt`) {
      response.writeHead(fake.webStatus, { "Content-Type": "text/plain" });
      response.end(fake.webStatus === 200 ? SUMS : "Access to this site has been restricted.");
    } else if (path === `/api/repos/${REPO}/releases/tags/v1.2.3`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ assets: [
        { name: "lasecsimul-1.2.3-win32-x64.vsix", url: `${base}/api/repos/${REPO}/releases/assets/6` },
        { name: "SHA256SUMS.txt", url: `${base}/api/repos/${REPO}/releases/assets/7` },
      ] }));
    } else if (path === `/api/repos/${REPO}/releases/assets/7` && request.headers.accept === "application/octet-stream") {
      response.writeHead(302, { Location: `${base}/release-assets/7?signed=1` });
      response.end();
    } else if (path === "/release-assets/7?signed=1") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(SUMS);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeGitHub = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    webStatus,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}

(async () => {
  await test("link público respondendo: baixa direto, sem gastar a cota da API", async () => {
    const github = await fakeGitHub(200);
    try {
      const body = await readBody(await openReleaseAsset({ repo: REPO, webBase: `${github.base}/web`, apiBase: `${github.base}/api` }, "1.2.3", "SHA256SUMS.txt"));
      assert(body.toString("utf8") === SUMS, `conteúdo ${body.toString("utf8")}`);
      assert(github.requests.every((r) => !r.path.startsWith("/api/")), `a API não deve ser chamada: ${JSON.stringify(github.requests)}`);
    } finally {
      await github.close();
    }
  });

  await test("link público com 403 (IP restrito): baixa pela API, com o Accept do asset até o host final", async () => {
    const github = await fakeGitHub(403);
    try {
      const body = await readBody(await openReleaseAsset({ repo: REPO, webBase: `${github.base}/web`, apiBase: `${github.base}/api` }, "1.2.3", "SHA256SUMS.txt"));
      assert(body.toString("utf8") === SUMS, `conteúdo ${body.toString("utf8")}`);
      const final = github.requests.find((r) => r.path.startsWith("/release-assets/"));
      assert(final?.accept === "application/octet-stream", `Accept no host final: ${final?.accept}`);
    } finally {
      await github.close();
    }
  });

  await test("arquivo ausente na release: o erro cita o 403 do link e a falta do asset na API", async () => {
    const github = await fakeGitHub(403);
    try {
      let message = "";
      try {
        await openReleaseAsset({ repo: REPO, webBase: `${github.base}/web`, apiBase: `${github.base}/api` }, "1.2.3", "nao-existe.exe");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(message.includes("HTTP 404") && message.includes("pela API do GitHub") && message.includes("nao-existe.exe"), message);
    } finally {
      await github.close();
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
