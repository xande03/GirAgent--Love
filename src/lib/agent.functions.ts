import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { ContentBlock } from "./ai.server";

const AttachmentSchema = z.object({
  name: z.string(),
  mime: z.string(),
  dataUrl: z.string(),
});

const ConnectSchema = z.object({
  token: z.string().min(10),
  repoUrl: z.string().min(3),
});

const RunSchema = z.object({
  token: z.string().min(10),
  repoUrl: z.string().min(3),
  instruction: z.string().min(2),
  attachments: z.array(AttachmentSchema).default([]),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .default([]),
});

export const connectRepo = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ConnectSchema.parse(input))
  .handler(async ({ data }) => {
    const { parseRepoUrl, getRepoSnapshot, setSnapshotCache, getCachedSnapshot } = await import("./github.server");
    const ref = parseRepoUrl(data.repoUrl);

    // Try cache first
    const cached = getCachedSnapshot(ref.owner, ref.repo);
    if (cached) {
      return {
        owner: cached.owner,
        repo: cached.repo,
        branch: cached.branch,
        headSha: cached.headSha,
        totalFiles: cached.paths.length,
        indexedFiles: cached.files.length,
        truncated: cached.truncated,
        paths: cached.paths.slice(0, 800),
      };
    }

    const snap = await getRepoSnapshot(data.token, ref);
    setSnapshotCache(snap);
    return {
      owner: snap.owner,
      repo: snap.repo,
      branch: snap.branch,
      headSha: snap.headSha,
      totalFiles: snap.paths.length,
      indexedFiles: snap.files.length,
      truncated: snap.truncated,
      paths: snap.paths.slice(0, 800),
    };
  });

export const runAgent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RunSchema.parse(input))
  .handler(async ({ data }) => {
    const {
      parseRepoUrl,
      getRepoSnapshot,
      commitToMain,
      getCachedSnapshot,
      setSnapshotCache,
      invalidateSnapshotCache,
    } = await import("./github.server");
    const { chat, extractJson } = await import("./ai.server");
    const { classifyImageIntent, buildSystemPrompt, assetPath, sanitizeInstruction, validateChanges } = await import("./agent-core");

    // Sanitize instruction
    const { clean: instruction, flagged } = sanitizeInstruction(data.instruction);

    const ref = parseRepoUrl(data.repoUrl);

    // Try snapshot cache, fallback to fetch
    let snap = getCachedSnapshot(ref.owner, ref.repo);
    if (!snap) {
      snap = await getRepoSnapshot(data.token, ref);
      setSnapshotCache(snap);
    }

    const images = data.attachments.filter((a) => a.mime.startsWith("image/"));
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

    const textAttachments = data.attachments.filter((a) => !a.mime.startsWith("image/"));
    const attachmentNotes = textAttachments.length
      ? `\n\nAnexos não-imagem enviados (conteúdo decodificado):\n` +
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
          data.history.length
            ? "Histórico da conversa:\n" +
              data.history.map((h) => `${h.role === "user" ? "Usuário" : "Agente"}: ${h.content}`).join("\n")
            : "",
          "",
          `SOLICITAÇÃO DO USUÁRIO:\n${instruction}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      ...images.map<ContentBlock>((i) => ({ type: "image_url", image_url: { url: i.dataUrl } })),
    ];

    const answer = await chat([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userBlocks },
    ]);

    const parsed = extractJson<{
      reasoning?: string;
      summary?: string;
      commitMessage?: string;
      needsClarification?: boolean;
      question?: string;
      changes?: { path: string; action?: "upsert" | "delete"; content?: string }[];
    }>(answer);

    if (parsed.needsClarification || !parsed.changes?.length) {
      return {
        applied: false as const,
        reasoning: parsed.reasoning ?? "",
        summary:
          parsed.summary ??
          parsed.question ??
          "Preciso de mais detalhes para alterar o projeto com segurança.",
        imageIntent: intent,
        commit: null,
        changedPaths: [] as string[],
        sanitized: flagged,
      };
    }

    // Validate changes for security
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

    // Invalidate snapshot cache before committing (HEAD will change)
    invalidateSnapshotCache(ref.owner, ref.repo);

    const commit = await commitToMain(
      data.token,
      ref,
      changes as never,
      parsed.commitMessage?.slice(0, 200) || `agente: ${instruction.slice(0, 60)}`,
      snap.branch,
    );

    return {
      applied: true as const,
      reasoning: parsed.reasoning ?? "",
      summary: parsed.summary ?? "Alterações aplicadas.",
      imageIntent: intent,
      commit,
      changedPaths: changes.map((c) => c.path),
      sanitized: flagged,
    };
  });
