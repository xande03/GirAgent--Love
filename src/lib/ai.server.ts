export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
};

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes
const REQUEST_TIMEOUT_WITH_IMAGES_MS = 240_000; // 4 minutes for vision requests
const DEFAULT_MAX_TOKENS = 16_384;

function getLlmConfig() {
  const key = process.env["DEEPSEEK_API_KEY"];
  const baseUrl = (process.env["DEEPSEEK_BASE_URL"] ?? "https://api.b.ai/v1").replace(/\/$/, "");
  const model = process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash";
  if (!key) throw new Error("DEEPSEEK_API_KEY não configurada no servidor. Defina a variável de ambiente e reinicie.");
  return { key, baseUrl, model };
}

/**
 * Calls the configured LLM (DeepSeek-compatible OpenAI chat completions endpoint).
 * Falls back to a text-only request when the provider rejects image blocks.
 */
export async function chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) {
  const { key, baseUrl, model } = getLlmConfig();
  const hasImages = messages.some((m) => Array.isArray(m.content));
  const timeoutMs = hasImages ? REQUEST_TIMEOUT_WITH_IMAGES_MS : REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

/**
 * Streams the LLM response chunk by chunk using SSE protocol.
 * Yields text deltas as they arrive from the provider.
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number },
): AsyncGenerator<string, void, undefined> {
  const { key, baseUrl, model } = getLlmConfig();
  const hasImages = messages.some((m) => Array.isArray(m.content));
  const timeoutMs = hasImages ? REQUEST_TIMEOUT_WITH_IMAGES_MS : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), timeoutMs);

  const sendStream = async function* (msgs: ChatMessage[]) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: opts?.temperature ?? 0.2,
        max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
      }),
    });

    if (!res.ok) {
      const raw = await res.text();
      const errMsg = raw.slice(0, 600);
      if (res.status === 401) throw new Error(`API key inválida ou expirada (HTTP 401).`);
      if (res.status === 429) throw new Error(`Rate limit atingido (HTTP 429). Aguarde e tente novamente.`);
      if (res.status === 400) throw new Error(`Requisição inválida ao modelo (HTTP 400): ${errMsg}`);
      throw new Error(`LLM ${res.status}: ${errMsg}`);
    }

    if (!res.body) throw new Error("Resposta sem corpo para streaming.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;

          try {
            const json = JSON.parse(payload);
            const content = json?.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Skip malformed SSE data chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  try {
    if (!hasImages) {
      yield* sendStream(messages);
    } else {
      // Try with images first
      try {
        yield* sendStream(messages);
      } catch (err) {
        // Reset timeout for the fallback attempt so it gets a full window
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        // Fallback: strip images and retry
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
        yield* sendStream(flattened);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Extracts the first JSON object from a model answer (handles ```json fences). */
export function extractJson<T>(text: string): T {
  // Strategy 1: Try fenced JSON blocks
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const result = tryParseJson(fenced[1]!.trim());
    if (result !== undefined) return result as T;
  }

  // Strategy 2: Try the full text
  const fullResult = tryParseJson(text.trim());
  if (fullResult !== undefined) return fullResult as T;

  // Strategy 3: Extract by brace matching (handles nested objects correctly)
  const extracted = extractByBraceMatching(text);
  if (extracted) {
    const result = tryParseJson(extracted);
    if (result !== undefined) return result as T;
  }

  // Strategy 4: Try to fix common issues and re-parse
  const fixed = tryFixAndParse(text);
  if (fixed !== undefined) return fixed as T;

  throw new Error("O modelo não retornou JSON válido.");
}

/** Attempts JSON.parse and returns the result, or undefined on failure. */
function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

/** Extracts a top-level JSON object by counting brace depth, properly handling strings and escapes. */
function extractByBraceMatching(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Repairs potentially broken JSON from LLM output and parses it.
 * Handles: unterminated strings, unbalanced braces, trailing commas, and
 * content that got truncated mid-stream.
 */
function tryFixAndParse(text: string): unknown {
  const candidate = text.trim();
  const start = candidate.indexOf('{');
  if (start === -1) return undefined;

  let jsonStr = candidate.slice(start);
  
  // Walk the JSON tracking state, repairing as we go
  let depth = 0;       // brace depth
  let arrDepth = 0;    // bracket depth
  let inStr = false;
  let strCh = '';
  let esc = false;
  let lastGoodIndex = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i]!;
    
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    
    if (inStr) {
      if (ch === strCh) inStr = false;
      continue;
    }
    
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0 && arrDepth === 0) { lastGoodIndex = i; break; }
    }
    else if (ch === '[') arrDepth++;
    else if (ch === ']') {
      arrDepth--;
    }
  }

  if (lastGoodIndex !== -1) {
    // Found a balanced top-level object — use it
    jsonStr = jsonStr.slice(0, lastGoodIndex + 1);
  } else {
    // Unbalanced — repair by closing whatever is open
    // First, close any unterminated string
    if (inStr) {
      jsonStr += strCh; // close the string with the matching quote
    }
    // Close remaining arrays and objects
    const closeBrackets = ']'.repeat(Math.max(0, arrDepth));
    const closeBraces = '}'.repeat(Math.max(0, depth));
    jsonStr += closeBrackets + closeBraces;
  }

  // Fix trailing commas before } or ]
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Last resort: try removing content after the last complete key-value pair
    // Find last "}," or "}" at depth 1 and truncate there
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      const truncated = jsonStr.slice(0, lastComplete + 1) + '}';
      // Fix trailing commas again after truncation
      const fixed = truncated.replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(fixed); } catch { /* give up */ }
    }
    return undefined;
  }
}
