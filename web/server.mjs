import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
const root = decodeURIComponent(new URL(".", import.meta.url).pathname.slice(1)), port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
createServer((req, res) => { const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname), relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""), file = normalize(join(root, relative)); if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end("Not found"); res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); createReadStream(file).pipe(res); }).listen(port, "127.0.0.1", () => console.log(`Local URL: http://127.0.0.1:${port}`));
