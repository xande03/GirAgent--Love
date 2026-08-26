import { parseRepoUrl } from "./github.server";

const GH_API = "https://api.github.com";

/**
 * Proxies a GitHub repo ZIP download through the server so the token
 * is never exposed to the client.
 */
export async function handleDownloadRepo(request: Request): Promise<Response> {
  let body: { token: string; repoUrl: string; branch?: string };
  try {
    body = await request.json();
    if (!body.token || !body.repoUrl) {
      return new Response(JSON.stringify({ error: "token e repoUrl são obrigatórios" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ref = parseRepoUrl(body.repoUrl);
  const branch = body.branch || "main";

  try {
    const archiveUrl = `${GH_API}/repos/${ref.owner}/${ref.repo}/zipball/${branch}`;
    const res = await fetch(archiveUrl, {
      headers: {
        Authorization: `Bearer ${body.token.trim()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "xerife-switch-agent",
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Erro desconhecido");
      let userMsg = `Erro ao baixar: HTTP ${res.status}`;
      if (res.status === 401) userMsg = "Token do GitHub inválido ou expirado.";
      else if (res.status === 404) userMsg = "Repositório ou branch não encontrado.";
      else if (res.status === 403) userMsg = "Acesso negado. Verifique as permissões do token.";
      return new Response(JSON.stringify({ error: `${userMsg} ${errText.slice(0, 200)}` }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const blob = await res.blob();
    const fileName = `${ref.repo}-${branch}.zip`;

    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Erro ao conectar com o GitHub." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
