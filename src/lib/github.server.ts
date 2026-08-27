const API = "https://api.github.com";

/* ── Snapshot cache (TTL-based, in-process) ── */
const _snapCache = new Map<string, { data: RepoSnapshot; ts: number }>();
const SNAP_CACHE_TTL_MS = 60_000; // 1 minute

export function getCachedSnapshot(owner: string, repo: string): RepoSnapshot | null {
  const entry = _snapCache.get(`${owner}/${repo}`);
  if (entry && Date.now() - entry.ts < SNAP_CACHE_TTL_MS) return entry.data;
  if (entry) _snapCache.delete(`${owner}/${repo}`);
  return null;
}

export function setSnapshotCache(snap: RepoSnapshot): void {
  _snapCache.set(`${snap.owner}/${snap.repo}`, { data: snap, ts: Date.now() });
}

export function invalidateSnapshotCache(owner: string, repo: string): void {
  _snapCache.delete(`${owner}/${repo}`);
}

export type RepoRef = { owner: string; repo: string };

export type RepoFile = { path: string; content: string };

export type RepoSnapshot = {
  owner: string;
  repo: string;
  branch: string;
  headSha: string;
  paths: { path: string; size: number }[];
  files: RepoFile[];
  truncated: boolean;
};

const TEXT_EXT =
  /\.(tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|sass|html|svg|txt|yml|yaml|toml|env\.example|py|rb|go|rs|java|kt|php|sh|sql|vue|svelte|astro|prisma|graphql|lock|gitignore|editorconfig|babelrc|eslintrc)$/i;

const SKIP_DIR =
  /(^|\/)(node_modules|\.git|dist|build|\.next|\.cache|coverage|vendor|\.turbo|out)(\/|$)/;

export function parseRepoUrl(input: string): RepoRef {
  let cleaned = input.trim();
  // remove protocolo, credenciais embutidas, prefixo git@ e sufixos comuns
  cleaned = cleaned
    .replace(/^git\+/, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^(www\.)?github\.com[:/]/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("URL de repositório inválida. Use https://github.com/usuario/repositorio");
  }
  const owner = parts[0]!;
  const repo = parts[1]!;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error("URL de repositório inválida. Use https://github.com/usuario/repositorio");
  }
  return { owner, repo };
}


function gitHubMessage(status: number, path: string, body: string): string {
  let providerMessage = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") providerMessage = parsed.message;
  } catch {
    // Keep the raw provider body when it is not JSON.
  }

  if (status === 401) {
    return "Token do GitHub inválido ou expirado. Gere um novo token com acesso ao repositório e tente novamente.";
  }

  if (status === 403) {
    return "O GitHub recusou o acesso. Confirme se o token tem permissão para ler e escrever no repositório e se o limite de uso da API não foi atingido.";
  }

  if (status === 404 && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
    return "Repositório não encontrado ou inacessível para este token. Confirme a URL no formato https://github.com/usuario/repositorio e, se for privado, use um token com acesso ao repositório.";
  }

  if (status === 404 && path.includes("/branches/")) {
    return "Branch padrão não encontrada no repositório. Confirme se o repositório tem uma branch principal válida.";
  }

  return `GitHub API ${status}: ${providerMessage}`;
}

async function gh(token: string, path: string, init?: RequestInit) {
  const cleanToken = token.trim();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cleanToken}`,
      "User-Agent": "xerife-switch-agent",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(gitHubMessage(res.status, path, body));
  }
  return res.json() as Promise<any>;
}

export async function getRepoSnapshot(
  token: string,
  ref: RepoRef,
  maxChars = 160_000,
): Promise<RepoSnapshot> {
  const repoInfo = await gh(token, `/repos/${ref.owner}/${ref.repo}`);
  const branch: string = repoInfo.default_branch ?? "main";
  const branchInfo = await gh(token, `/repos/${ref.owner}/${ref.repo}/branches/${branch}`);
  const headSha: string = branchInfo.commit.sha;
  const treeSha: string = branchInfo.commit.commit.tree.sha;

  const tree = await gh(
    token,
    `/repos/${ref.owner}/${ref.repo}/git/trees/${treeSha}?recursive=1`,
  );

  const blobs = (tree.tree as any[])
    .filter((n) => n.type === "blob" && !SKIP_DIR.test(n.path))
    .map((n) => ({ path: n.path as string, size: (n.size as number) ?? 0, sha: n.sha as string }));

  const readable = blobs
    .filter((b) => TEXT_EXT.test(b.path) || !b.path.includes("."))
    .filter((b) => b.size > 0 && b.size < 120_000)
    .sort((a, b) => score(b.path) - score(a.path));

  const files: RepoFile[] = [];
  let used = 0;
  let truncated = false;
  for (const b of readable) {
    if (used + b.size > maxChars) {
      truncated = true;
      continue;
    }
    try {
      const blob = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/blobs/${b.sha}`);
      const content = decodeBase64(blob.content ?? "");
      files.push({ path: b.path, content });
      used += content.length;
    } catch {
      truncated = true;
    }
  }

  return {
    owner: ref.owner,
    repo: ref.repo,
    branch,
    headSha,
    paths: blobs.map(({ path, size }) => ({ path, size })),
    files,
    truncated,
  };
}

function score(path: string) {
  let s = 0;
  if (/^(src|app|lib|components|pages|routes)\//.test(path)) s += 50;
  if (/(index|main|app|layout|router)\.[jt]sx?$/i.test(path)) s += 40;
  if (/package\.json|tsconfig|vite\.config|next\.config|readme/i.test(path)) s += 30;
  if (/\.(tsx|ts|jsx|js|vue|svelte)$/.test(path)) s += 10;
  if (path.split("/").length > 4) s -= 10;
  return s;
}

export function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export type ChangeFile =
  | { path: string; action: "upsert"; content: string; encoding?: "utf8" | "base64" }
  | { path: string; action: "delete" };

/** Commits directly to the default branch (no branches, no PRs).
 *  Includes retry on the ref update (push) step, which is the most common failure point.
 */
export async function commitToMain(
  token: string,
  ref: RepoRef,
  changes: ChangeFile[],
  message: string,
  branch = "main",
): Promise<{ sha: string; url: string; branch: string }> {
  let head: any;
  try {
    head = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${branch}`);
  } catch {
    throw new Error(
      `A branch '${branch}' não existe nesse repositório. O agente comita apenas na branch padrão.`,
    );
  }
  const headSha = head.object.sha as string;
  const headCommit = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha as string;

  const treeItems: any[] = [];
  for (const c of changes) {
    if (c.action === "delete") {
      treeItems.push({ path: c.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: c.content,
        encoding: c.encoding === "base64" ? "base64" : "utf-8",
      }),
    });
    treeItems.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: treeItems }),
  });

  const commit = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });

  // Push the ref — retry up to 2 times (handles race conditions / transient GitHub errors)
  let pushSuccess = false;
  let lastPushErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await gh(token, `/repos/${ref.owner}/${ref.repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      pushSuccess = true;
      break;
    } catch (pushErr) {
      lastPushErr = (pushErr as Error).message ?? String(pushErr);
      console.error(`[github] Push attempt ${attempt}/3 failed:`, lastPushErr);
      // On 409 (conflict), re-read head and re-create commit with updated parent
      if (lastPushErr.includes("409") || lastPushErr.includes("conflict")) {
        try {
          const freshHead = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${branch}`);
          const freshSha = freshHead.object.sha as string;
          const retryCommit = await gh(token, `/repos/${ref.owner}/${ref.repo}/git/commits`, {
            method: "POST",
            body: JSON.stringify({ message: message + " (retry)", tree: newTree.sha, parents: [freshSha] }),
          });
          await gh(token, `/repos/${ref.owner}/${ref.repo}/git/refs/heads/${branch}`, {
            method: "PATCH",
            body: JSON.stringify({ sha: retryCommit.sha, force: false }),
          });
          pushSuccess = true;
          console.log(`[github] Push succeeded on conflict retry with new commit ${retryCommit.sha}`);
          break;
        } catch (retryErr) {
          lastPushErr = (retryErr as Error).message ?? String(retryErr);
          console.error(`[github] Conflict retry failed:`, lastPushErr);
        }
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  if (!pushSuccess) {
    throw new Error(`Falha ao fazer push após 3 tentativas. Último erro: ${lastPushErr}`);
  }

  return {
    sha: commit.sha,
    url: `https://github.com/${ref.owner}/${ref.repo}/commit/${commit.sha}`,
    branch,
  };
}
