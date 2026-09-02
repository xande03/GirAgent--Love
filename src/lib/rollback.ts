import { z } from "zod";
import { parseRepoUrl, revertLastCommit } from "./github.server";

const RollbackSchema = z.object({
  token: z.string().min(10),
  repoUrl: z.string().min(3),
});

export async function handleRollback(request: Request): Promise<Response> {
  let body: z.infer<typeof RollbackSchema>;
  try {
    const raw = await request.json();
    body = RollbackSchema.parse(raw);
  } catch (err) {
    return Response.json({ error: "Dados inválidos: " + (err as Error).message }, { status: 400 });
  }

  try {
    const ref = parseRepoUrl(body.repoUrl);
    console.log(`[rollback] Revertendo último commit de ${ref.owner}/${ref.repo}...`);
    const result = await revertLastCommit(body.token, ref);
    console.log(`[rollback] Revertido: ${result.sha}`);
    return Response.json({
      success: true,
      sha: result.sha,
      url: result.url,
      branch: result.branch,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error("[rollback] Erro:", msg);
    return Response.json({ error: msg }, { status: 400 });
  }
}
