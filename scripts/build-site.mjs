import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");
const client = path.join(output, "client");
const server = path.join(output, "server");

await rm(output, { recursive: true, force: true });
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });

for (const file of ["index.html", "app.js", "core.mjs", "styles.css", "speed-slider.css"]) {
  await cp(path.join(root, "web", file), path.join(client, file));
}
await mkdir(path.join(client, "vendor"), { recursive: true });
await cp(path.join(root, "web", "vendor", "jszip.min.js"), path.join(client, "vendor", "jszip.min.js"));

await writeFile(path.join(server, "index.js"), `export default {
  async fetch(request, env) {
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    return new Response("Heat-seal G-code postprocessor assets are unavailable.", { status: 503 });
  }
};
`, "utf8");

console.log(`Built site to ${output}`);
