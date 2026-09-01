import { z } from "zod";

import type { ContentBlock } from "./ai.server";
import type { ImageIntent } from "./agent-core";

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
  // Explicit image intent from the client (overrides heuristic classification)
  imageIntent: z.enum(["add-to-project", "reference-only"]).optional(),
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
  const { chatStream, extractJson, describeImage } = await import("./ai.server");
  const { classifyImageIntent, buildSystemPrompt, assetPath, sanitizeInstruction, validateChanges, validateChangesConsistency } =
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
        // Use explicit client intent if provided, otherwise fall back to heuristic
        const intent: ImageIntent = body.imageIntent ?? classifyImageIntent(instruction);

        // Log image details for debugging
        if (images.length > 0) {
          console.log(`[agent-stream] ${images.length} imagem(ns) recebida(s):`, images.map((i) => `${i.name} (${i.mime}, ~${Math.round((i.dataUrl.length * 3) / 4 / 1024)}KB)`).join(', '));
          console.log(`[agent-stream] Intent de imagem: ${intent}`);
        }

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
            ? "MODO: Nenhuma imagem foi anexada."
            : intent === "add-to-project"
              ? `MODO: SALVAR NO REPOSITÓRIO ("add-to-project").
Foram anexadas ${images.length} imagem(ns) que SERÃO SALVAS no repositório.
Os caminhos exatos de cada imagem (USE EXATAMENTE ESTES):
${images.map((img) => `- ${assetPath(img.name)}`).join("\n")}
Regras:
- Analise a descrição da imagem abaixo e entenda seu conteúdo.
- Crie referências a essas imagens no código usando EXATAMENTE os caminhos acima.
- Pode usar em tags <img src="...">, imports CSS, background-image: url(...), etc.
- NUNCA invente ou assuma outros caminhos de imagem.
- A imagem será salva automaticamente pelo sistema.`
              : `MODO: APENAS REFERÊNCIA VISUAL ("reference-only").
Foram anexadas ${images.length} imagem(ns) como REFERÊNCIA VISUAL.
Regras:
- Analise a descrição detalhada da imagem abaixo: layouts, cores, posições, textos, ícones, espaçamentos, tipografia, sombras, gradientes, bordas, tamanhos.
- Baseie TODAS as modificações no que está descrito.
- NUNCA crie imports, caminhos ou referências a arquivos de imagem para essas imagens (elas NÃO existirão no repositório).
- EM VEZ DISSO, reproduza o visual usando CSS, HTML, SVG, inline styles, emojis ou assets que JÁ EXISTEM no repositório.
- Exemplo: se a descrição menciona um botão azul arredondado, crie o botão com classes CSS — NÃO tente importar a imagem.`;

        // ── Vision model pre-processing ──
        // If VISION_MODEL is set, describe images with it BEFORE sending to the main model.
        // This allows text-only models (like deepseek-v4-flash) to "see" images via descriptions.
        let imageDescriptions: string[] = [];
        let usedVisionPreprocessing = false;
        const visionModel = process.env["VISION_MODEL"];

        if (images.length > 0 && visionModel) {
          console.log(`[agent-stream] VISION_MODEL="${visionModel}" configurada. Descrevendo ${images.length} imagem(ns) com modelo de visão...`);

          imageDescriptions = await Promise.all(
            images.map(async (img) => {
              try {
                const desc = await describeImage(img.dataUrl, img.name);
                return `--- DESCRIÇÃO DA IMAGEM "${img.name}" (${img.mime}) ---\n${desc}\n--- FIM DA DESCRIÇÃO ---`;
              } catch (visionErr) {
                const msg = (visionErr as Error).message;
                console.error(`[agent-stream] Falha ao descrever imagem "${img.name}": ${msg}`);
                return `--- IMAGEM "${img.name}" ---\n(Falha ao descrever: ${msg.slice(0, 200)})\n--- FIM ---`;
              }
            }),
          );

          usedVisionPreprocessing = true;
          console.log(`[agent-stream] Descrições de ${imageDescriptions.length} imagem(ns) obtidas. Total: ${imageDescriptions.reduce((s, d) => s + d.length, 0)} chars.`);
        }

        // Build user message blocks
        // If vision pre-processing was used, include descriptions in text (no image_url blocks)
        // If not, include image_url blocks for the main model to process directly
        const visionDescriptionsText =
          imageDescriptions.length > 0
            ? `\n\nDESCRIÇÕES DAS IMAGENS ANEXADAS (geradas por modelo de visão "${visionModel}"):\n${imageDescriptions.join("\n\n")}`
            : "";

        const userBlocks: ContentBlock[] = [
          {
            type: "text",
            text: [
              repoContext,
              attachmentNotes,
              "",
              `POLÍTICA DE IMAGENS: ${imagePolicy}`,
              visionDescriptionsText,
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
          // Only include image_url blocks if vision pre-processing was NOT used
          // (i.e., let the main model try to process images directly)
          ...(usedVisionPreprocessing
            ? []
            : images.map<ContentBlock>((i) => ({ type: "image_url", image_url: { url: i.dataUrl } }))),
        ];

        // Phase 2: Stream LLM response
        send("phase", JSON.stringify({ phase: "thinking" }));

        // Track whether images were stripped by the LLM API (model doesn't support vision)
        let imagesStripped = false;
        let imageFallbackReason = "";

        let fullText = "";
        for await (const chunk of chatStream([
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userBlocks },
        ], {
          onImageFallback: (reason) => {
            imagesStripped = true;
            imageFallbackReason = reason;
            console.warn(`[agent-stream] Imagens removidas pelo fallback do LLM: ${reason}`);
          },
        })) {
          fullText += chunk;
          send("chunk", JSON.stringify({ text: chunk }));
        }

        // If images were stripped, warn the user immediately
        if (imagesStripped && images.length > 0) {
          console.error(`[agent-stream] O modelo '${process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash"}' NÃO suporta imagens. Imagens foram removidas antes do envio ao LLM.`);
          send(
            "warning",
            JSON.stringify({
              message: `O modelo de IA atual (DeepSeek V4 Flash) não conseguiu processar as ${images.length} imagem(ns) anexada(s). A solicitação foi enviada sem as imagens — o agente não pôde vê-las. Motivo: ${imageFallbackReason.slice(0, 200)}`,
              imagesDropped: true,
            }),
          );
        }

        // Parse the complete response
        let parsed;
        try {
          parsed = extractJson<{
            reasoning?: string;
            summary?: string;
            commitMessage?: string;
            needsClarification?: boolean;
            question?: string;
            changes?: { path: string; action?: "upsert" | "delete"; content?: string }[];
          }>(fullText);
        } catch {
          // JSON parsing failed — try to extract all fields via regex as robust fallback
          const fallback = extractAllFieldsFallback(fullText);
          if (fallback && fallback.changes.length > 0) {
            parsed = fallback;
          } else {
            // Log raw response for server-side debugging
            console.error("[agent-stream] Unparseable LLM response:", fullText.slice(0, 2000));
            // Truly unparseable — return friendly message with a snippet
            const summary = extractFieldFromText(fullText, 'summary');
            const snippet = fullText.slice(0, 300).replace(/\n/g, ' ');
            send(
              "result",
              JSON.stringify({
                applied: false,
                reasoning: extractFieldFromText(fullText, 'reasoning') ?? "",
                summary: summary || `O modelo gerou uma resposta que não pôde ser processada como JSON.\n\nTrecho recebido:\n> ${snippet}\n\nTente reformular a solicitação de forma mais direta.`,
                imageIntent: intent,
                commit: null,
                changedPaths: [],
                sanitized: flagged,
              }),
            );
            send("phase", JSON.stringify({ phase: "done" }));
            return;
          }
        }

        if (!parsed.changes?.length) {
          send(
            "result",
            JSON.stringify({
              applied: false,
              reasoning: parsed.reasoning ?? "",
              summary:
                parsed.summary ??
                "Não foi possível gerar alterações para essa solicitação. Tente reformular com mais detalhes sobre o que deseja.",
              imageIntent: intent,
              commit: null,
              changedPaths: [],
              sanitized: flagged,
            }),
          );
          send("phase", JSON.stringify({ phase: "done" }));
          return;
        }

        // Validate changes (security + size)
        validateChanges(parsed.changes);

        // If we had images but they were stripped, the response is likely wrong — warn clearly
        if (imagesStripped && images.length > 0 && intent === "add-to-project") {
          console.error("[agent-stream] Imagens para 'add-to-project' foram removidas — commit cancelado.");
          send(
            "result",
            JSON.stringify({
              applied: false,
              reasoning: parsed.reasoning ?? "",
              summary: `**Imagens não puderam ser processadas.** O modelo atual (DeepSeek V4 Flash) não suporta recebimento de imagens. As ${images.length} imagem(ns) anexada(s) não foram enviadas ao agente.\n\n**Solução:** Descreva textualmente o que deseja (ex: "crie um logo azul circular com texto 'Xerife' em branco") em vez de enviar a imagem.\n\nMotivo técnico: ${imageFallbackReason.slice(0, 300)}`,
              imageIntent: intent,
              commit: null,
              changedPaths: [],
              sanitized: flagged,
            }),
          );
          send("phase", JSON.stringify({ phase: "done" }));
          return;
        }

        // Validate code consistency (truncation, broken imports, unbalanced brackets)
        const consistencyWarnings = validateChangesConsistency(parsed.changes, snap.paths);
        const criticalWarnings = consistencyWarnings.filter((w) =>
          /truncad|incompleto|desbalancead|não existe/i.test(w),
        );

        if (criticalWarnings.length > 0) {
          console.error("[agent-stream] Code consistency check failed:", criticalWarnings);
          send(
            "result",
            JSON.stringify({
              applied: false,
              reasoning: parsed.reasoning ?? "",
              summary: `**Código gerado com inconsistências detectadas** — commit cancelado para evitar build quebrado.\n\nProblemas encontrados:\n${criticalWarnings.map((w) => `- ${w}`).join("\n")}\n\nTente reformular a solicitação de forma mais específica ou com escopo menor.`,
              imageIntent: intent,
              commit: null,
              changedPaths: parsed.changes!.map((c) => c.path),
              sanitized: flagged,
            }),
          );
          send("phase", JSON.stringify({ phase: "done" }));
          return;
        }

        // Log non-critical warnings but proceed
        if (consistencyWarnings.length > 0) {
          console.warn("[agent-stream] Non-critical consistency warnings:", consistencyWarnings);
        }

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

        // Phase 3: Commit (with retry — guarantees push)
        send("phase", JSON.stringify({ phase: "committing" }));
        invalidateSnapshotCache(ref.owner, ref.repo);

        let commitResult: { sha: string; url: string; branch: string } | null = null;
        let commitError: string | null = null;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            commitResult = await commitToMain(
              body.token,
              ref,
              changes as never,
              parsed.commitMessage?.slice(0, 200) || `agente: ${instruction.slice(0, 60)}`,
              snap.branch,
            );
            commitError = null;
            break; // success
          } catch (commitErr) {
            const msg = (commitErr as Error).message ?? String(commitErr);
            commitError = msg;
            console.error(`[agent-stream] Commit attempt ${attempt}/${maxRetries} failed:`, msg);
            if (attempt < maxRetries) {
              // Wait before retry (1s, 2s, ...)
              await new Promise((r) => setTimeout(r, attempt * 1000));
            }
          }
        }

        if (!commitResult) {
          // Commit failed after all retries — report the error but tell user changes were generated
          send(
            "result",
            JSON.stringify({
              applied: false,
              reasoning: parsed.reasoning ?? "",
              summary: `As alterações foram geradas com sucesso, mas **não foi possível commitar** no GitHub após ${maxRetries} tentativas.\n\nErro: ${commitError}\n\nTente novamente — o agente vai reenviar as mudanças.`,
              report: buildReport(parsed.changes!, parsed.summary),
              imageIntent: intent,
              commit: null,
              changedPaths: changes.map((c) => c.path),
              sanitized: flagged,
            }),
          );
          send("phase", JSON.stringify({ phase: "done" }));
          return;
        }

        send(
          "result",
          JSON.stringify({
            applied: true,
            reasoning: parsed.reasoning ?? "",
            summary: parsed.summary ?? "Alterações aplicadas.",
            report: buildReport(parsed.changes!, parsed.summary),
            imageIntent: intent,
            commit: commitResult,
            changedPaths: changes.map((c) => c.path),
            sanitized: flagged,
          }),
        );
        send("phase", JSON.stringify({ phase: "done" }));
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        // Translate cryptic abort errors into user-friendly messages
        if (errMsg.includes("aborted") || errMsg.includes("AbortError")) {
          send("error", JSON.stringify({ message: "A requisição ao modelo de IA excedeu o tempo limite. Tente novamente com uma descrição mais curta ou sem imagens." }));
        } else {
          send("error", JSON.stringify({ message: errMsg }));
        }
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

/**
 * Builds a clean, user-friendly report of applied changes (no code shown).
 */
function buildReport(changes: { path: string; action?: string; content?: string }[], summary?: string): string {
  const lines: string[] = [];

  if (summary) {
    lines.push(summary);
    lines.push("");
  }

  lines.push(`**${changes.length} arquivo(s) modificado(s):**`);
  lines.push("");

  for (const c of changes) {
    const action = c.action === "delete" ? "Removido" : "Criado/Atualizado";
    const content = c.content ?? "";
    const sizeKB = (content.length / 1024).toFixed(1);
    lines.push(`- \`${c.path}\` — ${action} (${sizeKB} KB)`);
  }

  return lines.join("\n");
}

/**
 * Robust regex-based fallback that extracts all fields (including changes with content)
 * from potentially broken JSON text. This ensures commit/push still happens even when
 * the JSON parser fails due to unescaped characters in code content.
 */
function extractAllFieldsFallback(text: string): {
  reasoning?: string;
  summary?: string;
  commitMessage?: string;
  changes: { path: string; action?: "upsert" | "delete"; content?: string }[];
} | null {
  const reasoning = extractFieldFromText(text, 'reasoning') ?? undefined;
  const summary = extractFieldFromText(text, 'summary') ?? undefined;
  const commitMessage = extractFieldFromText(text, 'commitMessage') ?? undefined;

  const changes: { path: string; action?: "upsert" | "delete"; content?: string }[] = [];

  // Find all change paths
  const pathActionRegex = /"path"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pathActionRegex.exec(text)) !== null) {
    const p = m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    paths.push(p);
  }

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const pathPos = text.indexOf(`"path"`, text.indexOf(path));

    // Determine action
    const afterPath = text.slice(pathPos);
    const actionMatch = afterPath.match(/"action"\s*:\s*"(upsert|delete)"/);
    const action = (actionMatch?.[1] as "upsert" | "delete") ?? "upsert";

    // Find content start
    const contentMatch = afterPath.match(/"content"\s*:\s*"/);
    if (!contentMatch || action === "delete") {
      changes.push({ path, action });
      continue;
    }

    const contentStart = pathPos + contentMatch.index! + contentMatch[0]!.length;
    // Extract content by finding the matching closing quote (handling escapes)
    let j = contentStart;
    let contentStr = "";
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === '\\' && j + 1 < text.length) {
        contentStr += ch + text[j + 1]!;
        j += 2;
        continue;
      }
      if (ch === '"') {
        // Check if this is a real terminator
        let k = j + 1;
        while (k < text.length && text[k] === ' ') k++;
        const nextCh = k < text.length ? text[k] : '';
        if (nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === '') {
          break;
        }
        contentStr += ch;
        j++;
        continue;
      }
      contentStr += ch;
      j++;
    }

    // Unescape the content
    const content = contentStr
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    changes.push({ path, action, content });
  }

  if (changes.length === 0) return null;
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(commitMessage !== undefined ? { commitMessage } : {}),
    changes,
  };
}

/**
 * Regex-based fallback to extract a string field value from potentially broken JSON.
 * Handles escaped quotes and \n within the value.
 */
function extractFieldFromText(text: string, field: string): string | null {
  // Match "field": "..." handling escaped quotes and newlines
  const regex = new RegExp(
    `"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.|\\\\"|(?:"(?=[^,}\\]])))*)"`,
    's',
  );
  const match = text.match(regex);
  if (!match) return null;
  // Unescape common JSON escapes
  return match[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
