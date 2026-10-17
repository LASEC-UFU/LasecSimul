// Servidor estático mínimo para a PoC (somente localhost).
// Uso nos testes: import { serve } from "./server.mjs".  Uso direto: node server.mjs  (porta 8123)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain" };

/** mounts: { "/": dir, "/GeoGebra/": dir2 }; headers(path) devolve cabeçalhos extras (ex.: CSP); port 0 = porta livre. */
export function serve(mounts, headers = () => ({}), port = 0) {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const [prefix, dir] = entries.find(([p]) => path.startsWith(p)) ?? [];
      if (!dir) { res.writeHead(404).end(); return; }
      const root = resolve(dir);
      let file = normalize(join(root, path.slice(prefix.length)));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...headers(path) });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const { url } = await serve({ "/": here }, () => ({}), 8123);
  console.log(`PoC em ${url}/index.html (Limites + editor) e ${url}/tanque.html (Tanque) — Ctrl+C para sair`);
}
