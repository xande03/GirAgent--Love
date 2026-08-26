import { z } from "zod";

import type { ContentBlock } from "./ai.server";

const AttachmentSchema = z.object({
  name: z.string(),
  mime: z.string(),
  dataUrl: z.string(),
});

const StreamSchema = z.object({
  token: z.string().min(10),
  repoUrl: z.string().min(3),
  instruction: z.string().min(2),
  attachments: z.array(AttachmentSchema).default([]),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .default([]),
});

type StreamInput = z.infer<typeof StreamSchema>;

/**
 * Handles a streaming agent request.
 * Returns a Response with SSE content type.
 *
 * SSE event types:
 *   phase  — current phase: "snapshot" | "thinking" | "committing" | "done"
 *   chunk  — LLM text delta
 *   result — final JSON result
 *   error  — error message
 */
export async function handleAgentStream(request: Request): Promise<Response> {
  let body: StreamInput;
  try {
    const raw = await request.json();
    body = StreamSchema.parse(raw);
  } catch (err) {
    return sseError("Dados inválidos: " + (err as Error).message);
  }

  const { parseRepoUrl, getCachedSnapshot, setSnapshotCache, invalidateSnapshotCache, commitToMain } =
    await import("./github.server");
  const { chatStream, extractJson } = await import("./ai.server");
  const { classifyImageIntent, buildSystemPrompt, assetPath, sanitizeInstruction, validateChanges } =
    await import("./agent-core");

  const { clean: instruction, flagged } = sanitizeInstruction(body.instruction);
  const ref = parseRepoUrl(body.repoUrl);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));

      try {
        // Phase 1: Snapshot
        send("phase", JSON.stringify({ phase: "snapshot" }));

        let snap = getCachedSnapshot(ref.owner, ref.repo);
        if (!snap) {
          const { getRepoSnapshot } = await import("./github.server");
          snap = await getRepoSnapshot(body.token, ref);
          setSnapshotCache(snap);
        }

        const images = body.attachments.filter((a) => a.mime.startsWith("image/"));
        const intent = classifyImageIntent(instruction);

        const repoContext = [
          `Repositório: ${snap.owner}/${snap.repo} (branch de trabalho: main)`,
          `Árvore completa (${snap.paths.length} arquivos):`,
          snap.paths.map((p) => p.path).join("\n"),
          "",
          "Conteúdo dos arquivos indexados:",
          ...snap.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`),
          snap.truncated ? "(alguns arquivos grandes/binários não foram indexados)" : "",
        ].join("\n");

        const textAttachments = body.attachments.filter((a) => !a.mime.startsWith("image/"));
        const attachmentNotes = textAttachments.length
          ? "\n\nAnexos não-imagem enviados (conteúdo decodificado):\n" +
            textAttachments
              .map((a) => {
                try {
                  const b64 = a.dataUrl.split(",")[1] ?? "";
                  const bin = atob(b64);
                  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                  return `<attachment name="${a.name}">\n${new TextDecoder().decode(bytes).slice(0, 20000)}\n</attachment>`;
                } catch {
                  return `<attachment name="${a.name}">(não foi possível ler)</attachment>`;
                }
              })
              .join("\n")
          : "";

        const imagePolicy =
          images.length === 0
            ? "Nenhuma imagem foi anexada."
            : intent === "add-to-project"
              ? `Foram anexadas ${images.length} imagem(ns) e o usuário PEDIU que elas façam parte do projeto. Elas serão gravadas no repositório em ${assetPath("<nome>")} — referencie esses caminhos no código.`
              : `Foram anexadas ${images.length} imagem(ns) apenas como REFERÊNCIA VISUAL para entender o pedido. NÃO adicione essas imagens ao repositório e não crie arquivos de imagem.`;

        const userBlocks: ContentBlock[] = [
          {
            type: "text",
            text: [
              repoContext,
              attachmentNotes,
              "",
              `POLÍTICA DE IMAGENS: ${imagePolicy}`,
              "",
              body.history.length
                ? "Histórico da conversa:\n" +
                  body.history.map((h) => `${h.role === "user" ? "Usuário" : "Agente"}: ${h.content}`).join("\n")
                : "",
              "",
              `SOLICITAÇÃO DO USUÁRIO:\n${instruction}`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
          ...images.map<ContentBlock>((i) => ({ type: "image_url", image_url: { url: i.dataUrl } })),
        ];

        // Phase 2: Stream LLM response
        send("phase", JSON.stringify({ phase: "thinking" }));

        let fullText = "";
        for await (const chunk of chatStream([
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userBlocks },
        ])) {
          fullText += chunk;
          send("chunk", JSON.stringify({ text: chunk }));
        }

        // Parse the complete response
        const parsed = extractJson<{
          reasoning?: string;
          summary?: string;
          commitMessage?: string;
          needsClarification?: boolean;
          question?: string;
          changes?: { path: string; action?: "upsert" | "delete"; content?: string }[];
        }>(fullText);

        if (parsed.needsClarification || !parsed.changes?.length) {
          send(
            "result",
            JSON.stringify({
              applied: false,
              reasoning: parsed.reasoning ?? "",
              summary:
                parsed.summary ??
                parsed.question ??
                "Preciso de mais detalhes para alterar o projeto com segurança.",
              imageIntent: intent,
              commit: null,
              changedPaths: [],
              sanitized: flagged,
            }),
          );
          send("phase", JSON.stringify({ phase: "done" }));
          return;
        }

        // Validate changes
        validateChanges(parsed.changes);

        const changes = parsed.changes.map((c) =>
          c.action === "delete"
            ? ({ path: c.path, action: "delete" as const })
            : ({ path: c.path, action: "upsert" as const, content: c.content ?? "" }),
        );

        if (intent === "add-to-project") {
          for (const img of images) {
            changes.push({
              path: assetPath(img.name),
              action: "upsert",
              content: img.dataUrl.split(",")[1] ?? "",
              encoding: "base64",
            } as never);
          }
        }

        // Phase 3: Commit
        send("phase", JSON.stringify({ phase: "committing" }));
        invalidateSnapshotCache(ref.owner, ref.repo);

        const commit = await commitToMain(
          body.token,
          ref,
          changes as never,
          parsed.commitMessage?.slice(0, 200) || `agente: ${instruction.slice(0, 60)}`,
          snap.branch,
        );

        send(
          "result",
          JSON.stringify({
            applied: true,
            reasoning: parsed.reasoning ?? "",
            summary: parsed.summary ?? "Alterações aplicadas.",
            imageIntent: intent,
            commit,
            changedPaths: changes.map((c) => c.path),
            sanitized: flagged,
          }),
        );
        send("phase", JSON.stringify({ phase: "done" }));
      } catch (err) {
        send("error", JSON.stringify({ message: (err as Error).message }));
        send("phase", JSON.stringify({ phase: "done" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function sseError(message: string): Response {
  const body = `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
  return new Response(body, {
    status: 400,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
