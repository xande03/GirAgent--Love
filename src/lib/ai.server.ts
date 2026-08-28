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
    let lastFinishReason: string | null = null;

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
          if (payload === "[DONE]") {
            // Stream ended — check if truncated
            if (lastFinishReason === "length") {
              throw new Error(
                "A resposta do modelo foi truncada por limite de tokens. Tente ser mais específico ou reduza o escopo da solicitação.",
              );
            }
            return;
          }

          try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            const content = choice?.delta?.content;
            if (content) yield content;
            // Track finish reason from any chunk
            if (choice?.finish_reason) {
              lastFinishReason = choice.finish_reason;
            }
          } catch (err) {
            // If it's our truncation error, re-throw it
            if (err instanceof Error && err.message.includes("truncada")) throw err;
            // Otherwise skip malformed SSE data chunks
          }
        }
      }
      // If the stream ended without [DONE], still check truncation
      if (lastFinishReason === "length") {
        throw new Error(
          "A resposta do modelo foi truncada por limite de tokens. Tente ser mais específico ou reduza o escopo da solicitação.",
        );
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

/** Extracts the first JSON object from a model answer (handles ```json fences, malformed output, unescaped quotes in code, etc.). */
export function extractJson<T>(text: string): T {
  // Strategy 1: Try fenced JSON blocks directly
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const trimmed = fenced[1]!.trim();
    let result = tryParseJson(trimmed);
    if (result !== undefined) return result as T;
    // Fenced block exists but invalid — try repairing it
    result = tryRepairAndParse(trimmed);
    if (result !== undefined) return result as T;
  }

  // Strategy 2: Try the full text directly
  let fullResult = tryParseJson(text.trim());
  if (fullResult !== undefined) return fullResult as T;

  // Strategy 3: Extract by brace matching (handles surrounding text)
  const extracted = extractByBraceMatching(text);
  if (extracted) {
    let result = tryParseJson(extracted);
    if (result !== undefined) return result as T;
    // Extracted but invalid — try repairing
    result = tryRepairAndParse(extracted);
    if (result !== undefined) return result as T;
  }

  // Strategy 4: Repair the full text (handles unescaped quotes in code content)
  const repaired = tryRepairAndParse(text.trim());
  if (repaired !== undefined) return repaired as T;

  // Strategy 5: Last resort — close truncation and try
  const closed = tryCloseAndParse(text);
  if (closed !== undefined) return closed as T;

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

/**
 * Core repair strategy: fixes unescaped quotes inside JSON string values.
 * Uses lookahead heuristic — a `"` inside a string is a delimiter only if
 * followed by `,`, `}`, `]`, `:`, or end-of-string. Otherwise it's content.
 */
function tryRepairAndParse(jsonStr: string): unknown {
  const start = jsonStr.indexOf('{');
  if (start === -1) return undefined;
  let src = jsonStr.slice(start);

  // Walk and rebuild, fixing unescaped quotes inside strings
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // Handle escape sequences — pass through verbatim
    if (ch === '\\' && i + 1 < src.length) {
      out += ch + src[i + 1]!;
      i += 2;
      continue;
    }

    // Start of a JSON string
    if (ch === '"') {
      out += ch;
      i++;
      // Read string content, fixing unescaped quotes
      while (i < src.length) {
        const c = src[i]!;

        // Escape sequence inside string — pass through
        if (c === '\\' && i + 1 < src.length) {
          out += c + src[i + 1]!;
          i += 2;
          continue;
        }

        if (c === '"') {
          // Lookahead: is this a real string terminator?
          // A real terminator is followed by: , } ] : or whitespace+one_of_those
          let j = i + 1;
          while (j < src.length && src[j] === ' ') j++;
          const nextChar = j < src.length ? src[j] : '';
          if (nextChar === ',' || nextChar === '}' || nextChar === ']' || nextChar === ':' || j >= src.length) {
            // Real string terminator
            out += c;
            i++;
            break;
          } else {
            // Unescaped quote inside string content — escape it
            out += '\\"';
            i++;
          }
        } else {
          out += c;
          i++;
        }
      }
      continue;
    }

    out += ch;
    i++;
  }

  // Try parsing the repaired string
  let result = tryParseJson(out);
  if (result !== undefined) return result;

  // Fix trailing commas and try again
  const fixed = out.replace(/,\s*([}\]])/g, '$1');
  result = tryParseJson(fixed);
  if (result !== undefined) return result;

  return undefined;
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

/** Last resort: close unterminated strings/braces and try to parse. */
function tryCloseAndParse(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let jsonStr = text.slice(start);

  let depth = 0;
  let arrDepth = 0;
  let inStr = false;
  let strCh = '';
  let esc = false;
  let lastGoodIndex = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i]!;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) { if (ch === strCh) inStr = false; continue; }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0 && arrDepth === 0) { lastGoodIndex = i; break; }
    }
    else if (ch === '[') arrDepth++;
    else if (ch === ']') arrDepth--;
  }

  if (lastGoodIndex !== -1) {
    jsonStr = jsonStr.slice(0, lastGoodIndex + 1);
  } else {
    if (inStr) jsonStr += strCh;
    jsonStr += ']'.repeat(Math.max(0, arrDepth));
    jsonStr += '}'.repeat(Math.max(0, depth));
  }

  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  // Try direct parse
  let result = tryParseJson(jsonStr);
  if (result !== undefined) return result;

  // Try truncating to last complete change
  const lastComplete = jsonStr.lastIndexOf('},');
  if (lastComplete > 0) {
    const truncated = jsonStr.slice(0, lastComplete + 1) + '}';
    const fixed = truncated.replace(/,\s*([}\]])/g, '$1');
    result = tryParseJson(fixed);
    if (result !== undefined) return result;
  }

  return undefined;
}
