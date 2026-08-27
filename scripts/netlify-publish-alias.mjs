// Netlify's UI-configured publish directory (dist/client) overrides netlify.toml.
// This script mirrors the static output that vite build produced into dist/client
// so the deploy succeeds regardless of which publish path Netlify uses.
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const target = path.join(root, "dist", "client");

const candidates = ["dist/public", ".output/public", "dist", ".netlify/static"];

async function isStaticDir(dir) {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return (
      entries.includes("index.html") ||
      entries.includes("_headers") ||
      entries.includes("assets")
    );
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
  console.warn(
    "[netlify-publish-alias] no static output directory found; skipping"
  );
  process.exit(0);
}

// Use a temp dir OUTSIDE of source to avoid Node.js EINVAL on cp.
const tmp = path.join(tmpdir(), `netlify-publish-${Date.now()}`);

await rm(tmp, { recursive: true, force: true });
await cp(source, tmp, { recursive: true });
await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await rename(tmp, target);
console.log(
  `[netlify-publish-alias] mirrored ${path.relative(root, source)} -> dist/client`
);
