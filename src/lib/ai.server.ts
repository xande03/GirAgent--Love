export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
};

/**
 * Calls the configured LLM (DeepSeek-compatible OpenAI chat completions endpoint).
 * Falls back to a text-only request when the provider rejects image blocks.
 */
export async function chat(messages: ChatMessage[], opts?: { temperature?: number }) {
  const key = process.env["DEEPSEEK_API_KEY"];
  const baseUrl = (process.env["DEEPSEEK_BASE_URL"] ?? "https://api.b.ai/v1").replace(/\/$/, "");
  const model = process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash";
  if (!key) throw new Error("DEEPSEEK_API_KEY não configurada no servidor.");

  const send = async (msgs: ChatMessage[]) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: opts?.temperature ?? 0.2,
        stream: false,
      }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${raw.slice(0, 600)}`);
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Resposta inválida do LLM: ${raw.slice(0, 300)}`);
    }
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("O modelo retornou uma resposta vazia.");
    return text;
  };

  const hasImages = messages.some((m) => Array.isArray(m.content));
  try {
    return await send(messages);
  } catch (err) {
    if (!hasImages) throw err;
    const flattened = messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content
            .map((b) =>
              b.type === "text"
                ? b.text
                : "[imagem de referência anexada — descrição visual indisponível neste modelo]",
            )
            .join("\n\n")
        : m.content,
    })) as ChatMessage[];
    return await send(flattened);
  }
}

/** Extracts the first JSON object from a model answer (handles ```json fences). */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("O modelo não retornou JSON válido.");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
