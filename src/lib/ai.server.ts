export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
};

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Calls the configured LLM (DeepSeek-compatible OpenAI chat completions endpoint).
 * Falls back to a text-only request when the provider rejects image blocks.
 */
export async function chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) {
  const key = process.env["DEEPSEEK_API_KEY"];
  const baseUrl = (process.env["DEEPSEEK_BASE_URL"] ?? "https://api.b.ai/v1").replace(/\/$/, "");
  const model = process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash";
  if (!key) throw new Error("DEEPSEEK_API_KEY não configurada no servidor. Defina a variável de ambiente e reinicie.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const send = async (msgs: ChatMessage[]) => {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature: opts?.temperature ?? 0.2,
          max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: false,
        }),
      });

      if (!res.ok) {
        const raw = await res.text();
        const errMsg = raw.slice(0, 600);
        if (res.status === 401) throw new Error(`API key inválida ou expirada (HTTP 401). Verifique DEEPSEEK_API_KEY.`);
        if (res.status === 429) throw new Error(`Rate limit atingido (HTTP 429). Aguarde alguns segundos e tente novamente.`);
        if (res.status === 400) throw new Error(`Requisição inválida ao modelo (HTTP 400): ${errMsg}`);
        throw new Error(`LLM ${res.status}: ${errMsg}`);
      }

      const raw = await res.text();
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Resposta inválida do LLM (não é JSON): ${raw.slice(0, 300)}`);
      }

      if (data.error) {
        const msg = data.error.message ?? JSON.stringify(data.error);
        throw new Error(`Erro do modelo: ${msg}`);
      }

      const choice = data?.choices?.[0];
      if (!choice) throw new Error(`O modelo não retornou choices. Resposta: ${raw.slice(0, 300)}`);

      const text: string = choice.message?.content ?? "";
      if (!text) throw new Error("O modelo retornou uma resposta vazia.");

      const finishReason = choice.finish_reason;
      if (finishReason === "length") {
        throw new Error(
          "A resposta do modelo foi truncada por limite de tokens. Tente ser mais específico ou reduza o escopo da solicitação.",
        );
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
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
