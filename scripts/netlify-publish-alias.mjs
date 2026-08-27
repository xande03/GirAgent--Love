// Netlify's UI-configured publish directory (dist/client) overrides netlify.toml.
// This script mirrors whatever static output the build produced into dist/client
// so the deploy succeeds regardless of which publish path Netlify uses.
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "dist", "client");

const candidates = [
  "dist/public",
  ".output/public",
  "dist",
  ".netlify/static",
];

async function isStaticDir(dir) {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.includes("index.html") || entries.includes("_headers") || entries.includes("assets");
  } catch {
    return false;
  }
}

let source = null;
for (const c of candidates) {
  const abs = path.join(root, c);
  if (abs === target) continue;
  if (await isStaticDir(abs)) {
    source = abs;
    break;
  }
}

if (!source) {
  console.warn("[netlify-publish-alias] no static output directory found; skipping");
  process.exit(0);
}

if (existsSync(target) && source === path.join(root, "dist")) {
  // avoid copying dist into itself
  console.log("[netlify-publish-alias] dist/client already present");
  process.exit(0);
}

await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (src) => !src.startsWith(target),
});
console.log(`[netlify-publish-alias] mirrored ${path.relative(root, source)} -> dist/client`);
