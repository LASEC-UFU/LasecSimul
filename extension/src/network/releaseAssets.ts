import * as http from "http";
import * as https from "https";

/** Download de um arquivo anexado a uma release do GitHub (setup.exe, SHA256SUMS.txt...).
 *
 * Caminho principal: o link público `github.com/<repo>/releases/download/v<versão>/<arquivo>`, sem
 * limite de requisições. O GitHub pode recusar esse host para um IP inteiro com 403 ("Access to
 * this site has been restricted", visto em 2026-10-09 no servidor do laboratório), o que derrubava
 * a instalação da rede lab-router. Nesse caso o arquivo vem pela API REST: a release pela tag, o
 * asset pelo nome e o conteúdo com `Accept: application/octet-stream`, que redireciona para outro
 * host (`release-assets.githubusercontent.com`). A API sem token aceita só 60 requisições por hora
 * por IP -- por isso é o caminho reserva, nunca o principal (uma turma atrás do mesmo NAT esgotaria). */

export interface ReleaseAssetSource {
  repo: string;
  /** Base do link público; padrão `https://github.com`. Trocável só em teste. */
  webBase?: string;
  /** Base da API REST; padrão `https://api.github.com`. Trocável só em teste. */
  apiBase?: string;
}

const USER_AGENT = "LasecSimul-Extension";

/** GET que segue redirecionamentos (o `https` do Node não segue sozinho). Os cabeçalhos vão também
 * nos saltos: o `Accept` do asset da API precisa chegar ao host final. */
export function getFollowingRedirects(url: string, headers: Record<string, string> = {}, remainingRedirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("http:") ? http : https;
    const request = transport.get(url, { headers: { "User-Agent": USER_AGENT, ...headers } }, (response) => {
      const { statusCode, headers: responseHeaders } = response;
      if (statusCode && statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
        response.resume();
        if (remainingRedirects <= 0) {
          reject(new Error(`Muitos redirecionamentos ao baixar ${url}`));
          return;
        }
        getFollowingRedirects(new URL(responseHeaders.location, url).toString(), headers, remainingRedirects - 1).then(resolve, reject);
        return;
      }
      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode ?? "desconhecido"} ao baixar ${url}`));
        return;
      }
      resolve(response);
    });
    request.on("error", reject);
  });
}

export function readBody(response: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

export function releaseAssetWebUrl(source: ReleaseAssetSource, version: string, fileName: string): string {
  return `${source.webBase ?? "https://github.com"}/${source.repo}/releases/download/v${version}/${fileName}`;
}

async function openThroughApi(source: ReleaseAssetSource, version: string, fileName: string): Promise<http.IncomingMessage> {
  const apiBase = source.apiBase ?? "https://api.github.com";
  const releaseResponse = await getFollowingRedirects(`${apiBase}/repos/${source.repo}/releases/tags/v${version}`,
    { Accept: "application/vnd.github+json" });
  const release = JSON.parse((await readBody(releaseResponse)).toString("utf8")) as { assets?: Array<{ name?: string; url?: string }> };
  const asset = release.assets?.find((candidate) => candidate.name === fileName);
  if (!asset?.url) throw new Error(`a release v${version} não tem o arquivo "${fileName}"`);
  return getFollowingRedirects(asset.url, { Accept: "application/octet-stream" });
}

/** Abre o arquivo da release: link público e, se falhar, a API do GitHub. O erro final cita os dois. */
export async function openReleaseAsset(source: ReleaseAssetSource, version: string, fileName: string): Promise<http.IncomingMessage> {
  try {
    return await getFollowingRedirects(releaseAssetWebUrl(source, version, fileName));
  } catch (webError) {
    try {
      return await openThroughApi(source, version, fileName);
    } catch (apiError) {
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new Error(`${message(webError)}; pela API do GitHub: ${message(apiError)}`);
    }
  }
}
