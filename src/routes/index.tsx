import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  GitBranch,
  Github,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ArrowDown,
  LogOut,
  ChevronDown,
  KeyRound,
  Link2,
  BrainCircuit,
  Upload,
  User,
  Bot,
  Download,
  EyeOff,
  ExternalLink,
  Monitor,
  Smartphone,
  Globe,
  RefreshCw,
  X,
  ImagePlus,
  Eye,
} from "lucide-react";

import { connectRepo } from "@/lib/agent.functions";

import { ComposerAttachments, MessageAttachments } from "@/components/attachment-preview";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/* ── Image handling helpers ── */
const MAX_IMG_DIM = 1600;
const IMG_QUALITY = 0.82;
/** Formats kept byte-exact (vector / animated / already efficient). */
const PASSTHROUGH_IMAGE_MIMES = new Set([
  "image/svg+xml",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function withExtension(name: string, mime: string) {
  const ext = EXT_BY_MIME[mime];
  if (!ext) return name;
  const base = name.replace(/\.[^./\\]+$/, "") || "imagem";
  return `${base}.${ext}`;
}

function supportsCanvasType(type: string) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL(type).startsWith(`data:${type}`);
  } catch {
    return false;
  }
}

function readAsDataUrl(file: File) {
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("Falha ao ler o arquivo"));
    r.readAsDataURL(file);
  });
}

/** Normalizes any bitmap image into a web-safe format, preserving transparency. */
function compressImage(file: File): Promise<{ dataUrl: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement("canvas");
        let { naturalWidth: width, naturalHeight: height } = img;
        if (!width || !height) throw new Error("dimensões inválidas");
        if (width > MAX_IMG_DIM || height > MAX_IMG_DIM) {
          const scale = MAX_IMG_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);

        const hasAlpha = /png|webp|avif|heic|heif|svg/.test(file.type);
        let outMime =
          file.type === "image/webp" && supportsCanvasType("image/webp")
            ? "image/webp"
            : hasAlpha
              ? "image/png"
              : "image/jpeg";
        let dataUrl = canvas.toDataURL(outMime, IMG_QUALITY);
        if (!dataUrl.startsWith(`data:${outMime}`)) {
          outMime = "image/png";
          dataUrl = canvas.toDataURL("image/png");
        }
        resolve({ dataUrl, mime: outMime });
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Falha ao processar imagem"));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Falha ao decodificar imagem"));
    };
    img.src = url;
  });
}

async function readFileAsAttachment(file: File): Promise<Attachment> {
  const type = file.type || "application/octet-stream";
  const isImage = type.startsWith("image/");
  const fallbackName = file.name || `anexo-${Date.now()}.${type.split("/")[1] ?? "bin"}`;

  if (isImage && !PASSTHROUGH_IMAGE_MIMES.has(type)) {
    try {
      const { dataUrl, mime } = await compressImage(file);
      return { name: withExtension(fallbackName, mime), mime, dataUrl, size: file.size };
    } catch {
      // Fall through to raw read so nothing is silently dropped.
    }
  }

  const dataUrl = await readAsDataUrl(file);
  return {
    name: isImage ? withExtension(fallbackName, type) : fallbackName,
    mime: type,
    dataUrl,
    size: file.size,
  };
}


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "XerifeSwitch — Agente IA para repositórios GitHub" },
      {
        name: "description",
        content:
          "Conecte seu token e repositório GitHub, descreva o que precisa e o agente de IA analisa, altera e comita direto na main.",
      },
      { property: "og:title", content: "XerifeSwitch — Agente IA para repositórios GitHub" },
      {
        property: "og:description",
        content:
          "Agente de IA que entende todo o projeto, aplica correções e faz commit automático na branch main.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

type Attachment = { name: string; mime: string; dataUrl: string; size: number };

type Turn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  changedPaths?: string[];
  commitUrl?: string | undefined;
  imageIntent?: "add-to-project" | "reference-only";
  attachments?: Attachment[];
  error?: boolean;
};

type RepoState = Awaited<ReturnType<typeof connectRepo>>;

type StreamPhase = "snapshot" | "thinking" | "committing" | "done";

type AgentResult = {
  applied: boolean;
  reasoning: string;
  summary: string;
  report?: string;
  imageIntent: "add-to-project" | "reference-only";
  commit: { sha: string; url: string; branch: string } | null;
  changedPaths: string[];
  sanitized: boolean;
};

const PHASE_LABELS: Record<StreamPhase, string> = {
  snapshot: "Lendo repositório...",
  thinking: "Analisando e gerando mudanças...",
  committing: "Aplicando e comitando...",
  done: "",
};

/* ── Preview platforms ── */
type PreviewPlatform = {
  name: string;
  icon: typeof Monitor;
  url: (owner: string, repo: string) => string;
  description: string;
};

const PREVIEW_PLATFORMS: PreviewPlatform[] = [
  {
    name: "StackBlitz",
    icon: Monitor,
    url: (o, r) => `https://stackblitz.com/github/${o}/${r}`,
    description: "Preview completo com hot-reload",
  },

  {
    name: "GitHub Codespaces",
    icon: ExternalLink,
    url: (o, r) => `https://codespaces.new/${o}/${r}`,
    description: "Ambiente de desenvolvimento completo",
  },
  {
    name: "Vercel",
    icon: Globe,
    url: (o, r) => `https://vercel.com/new/clone?repository-url=https://github.com/${o}/${r}`,
    description: "Deploy instantâneo",
  },
  {
    name: "Netlify",
    icon: Globe,
    url: (o, r) => `https://app.netlify.com/start/deploy?repository=https://github.com/${o}/${r}`,
    description: "Deploy e preview com Netlify",
  },
];

/* ── Download helper ── */
async function downloadRepoZip(token: string, repoUrl: string, branch: string) {
  try {
    const res = await fetch("/api/download-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, repoUrl, branch }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Erro desconhecido" }));
      alert(`Erro ao baixar: ${err.error}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+?)"/)?.[1] ?? "projeto.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Erro ao baixar: ${(err as Error).message}`);
  }
}

/* ── Session persistence keys ── */
const SESSION_KEY = "xerife-session";
const LAST_REPO_KEY = "xerife-last-repo";
const PREVIEW_URL_KEY = "xerife-preview-url";

function saveSession(token: string, repoUrl: string, repo: NonNullable<RepoState>, previewUrl?: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, repoUrl, repo, previewUrl }));
    localStorage.setItem(LAST_REPO_KEY, repoUrl);
    if (previewUrl) localStorage.setItem(PREVIEW_URL_KEY, previewUrl);
  } catch {}
}

function loadSession(): { token: string; repoUrl: string; repo: RepoState } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem(PREVIEW_URL_KEY); } catch {}
}

function getLastRepoUrl(): string | null {
  try { return localStorage.getItem(LAST_REPO_KEY); } catch { return null; }
}

function getSavedPreviewUrl(): string | null {
  try { return localStorage.getItem(PREVIEW_URL_KEY); } catch { return null; }
}

function Home() {
  const connect = useServerFn(connectRepo);

  const [token, setToken] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [instruction, setInstruction] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imageIntent, setImageIntent] = useState<"reference-only" | "add-to-project">("reference-only");
  const [dragging, setDragging] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [showRepoInfo, setShowRepoInfo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showPreviewMenu, setShowPreviewMenu] = useState<false | 'input'>(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [showPreviewPanel, setShowPreviewPanel] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const externalUrlRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>("done");
  const [streamText, setStreamText] = useState("");

  // Restore session on mount (prevents unexpected disconnect on remount/hydration)
  const sessionRestored = useRef(false);
  if (!sessionRestored.current) {
    sessionRestored.current = true;
    const saved = loadSession();
    if (saved) {
      // Use functional updates to avoid overwriting if already set (SSR hydration)
      setToken((cur) => cur || saved.token);
      setRepoUrl((cur) => cur || saved.repoUrl);
      setRepo((cur) => cur || saved.repo);
    }
    // Restore preview URL from localStorage
    const savedPreview = getSavedPreviewUrl();
    if (savedPreview) {
      setPreviewUrl(savedPreview);
      setShowPreviewPanel(true);
    }
  }

  /* Save preview URL to localStorage when changed */
  useEffect(() => {
    try {
      if (previewUrl) {
        localStorage.setItem(PREVIEW_URL_KEY, previewUrl);
      } else {
        localStorage.removeItem(PREVIEW_URL_KEY);
      }
    } catch {}
  }, [previewUrl]);

  /* Pre-fill last repo URL on connect screen */
  const [suggestedRepo, setSuggestedRepo] = useState("");
  useEffect(() => {
    if (!repo) {
      const last = getLastRepoUrl();
      if (last) setSuggestedRepo(last);
    }
  }, [repo]);

  /* Detect if user scrolled up from bottom */
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 80);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const connectMutation = useMutation({
    mutationFn: () => connect({ data: { token, repoUrl } }),
    onSuccess: (data) => {
      setRepo(data);
      setShowRepoInfo(false);
      saveSession(token, repoUrl, data, previewUrl || undefined);
    },
  });

  /* Auto-scroll to bottom when new messages arrive or streaming text changes */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, streamText.length > 0 ? streamText.slice(-1) : null]);

  /* Auto-refresh preview iframe when a new commit is applied */
  useEffect(() => {
    if (!showPreviewPanel || !previewUrl) return undefined;
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn?.commitUrl) return undefined;
    // Small delay so Netlify/Vercel has time to rebuild
    const t = setTimeout(() => setPreviewKey((k) => k + 1), 3000);
    return () => clearTimeout(t);
  }, [turns.length, showPreviewPanel, previewUrl]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 6);
    const loaded = await Promise.all(list.map(readFileAsAttachment));
    setAttachments((prev) => [...prev, ...loaded].slice(0, 6));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) {
            const key = `${f.name}:${f.type}:${f.size}`;
            if (!seen.has(key)) {
              seen.add(key);
              files.push(f);
            }
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const submitStream = useCallback(
    async (prompt: string) => {
      if (isStreaming) return;
      const currentAttachments = attachments;

      // Add user turn immediately
      setTurns((t) => [...t, { role: "user", content: prompt, attachments: currentAttachments }]);
      setInstruction("");
      setAttachments([]);
      if (fileInput.current) fileInput.current.value = "";

      // Reset image intent to default after sending
      setImageIntent("reference-only");

      // Start streaming
      setIsStreaming(true);
      setStreamPhase("snapshot");
      setStreamText("");

      const abort = new AbortController();
      abortRef.current = abort;

      const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.content }));

      try {
        const res = await fetch("/api/agent-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            repoUrl,
            instruction: prompt,
            attachments: currentAttachments.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })),
            history,
            ...(currentAttachments.some((a) => a.mime?.startsWith("image/"))
              ? { imageIntent }
              : {}),
          }),
          signal: abort.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "Erro desconhecido");
          setTurns((t) => [...t, { role: "assistant", content: `Erro HTTP ${res.status}: ${errText}`, error: true }]);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setTurns((t) => [...t, { role: "assistant", content: "Resposta sem corpo para streaming.", error: true }]);
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let resultData: AgentResult | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const event of events) {
            const lines = event.split("\n");
            let eventType = "";
            let eventData = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              if (line.startsWith("data: ")) eventData = line.slice(6);
            }

            if (eventType === "phase") {
              try {
                const { phase } = JSON.parse(eventData);
                setStreamPhase(phase as StreamPhase);
              } catch {}
            } else if (eventType === "chunk") {
              try {
                const { text } = JSON.parse(eventData);
                setStreamText((prev) => prev + text);
              } catch {}
            } else if (eventType === "result") {
              try {
                resultData = JSON.parse(eventData) as AgentResult;
              } catch {}
            } else if (eventType === "error") {
              try {
                const { message } = JSON.parse(eventData);
                setTurns((t) => [...t, { role: "assistant", content: message, error: true }]);
              } catch {}
            }
          }
        }

        // Process any remaining data in the buffer (last event may not end with \n\n)
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          let eventType = "";
          let eventData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }
          if (eventType === "result") {
            try {
              resultData = JSON.parse(eventData) as AgentResult;
            } catch {}
          } else if (eventType === "error") {
            try {
              const { message } = JSON.parse(eventData);
              setTurns((t) => [...t, { role: "assistant", content: message, error: true }]);
            } catch {}
          } else if (eventType === "phase") {
            try {
              const { phase } = JSON.parse(eventData);
              setStreamPhase(phase as StreamPhase);
            } catch {}
          }
        }

        // Add the final result as a turn — use report (clean) instead of summary (may contain code)
        if (resultData) {
          setTurns((t) => [
            ...t,
            {
              role: "assistant",
              content: resultData.report || resultData.summary,
              reasoning: resultData.reasoning,
              changedPaths: resultData.changedPaths,
              commitUrl: resultData.commit?.url,
              imageIntent: resultData.imageIntent,
            },
          ]);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setTurns((t) => [...t, { role: "assistant", content: (err as Error).message, error: true }]);
        }
      } finally {
        setIsStreaming(false);
        setStreamPhase("done");
        setStreamText("");
        abortRef.current = null;
      }
    },
    [isStreaming, attachments, token, repoUrl, turns],
  );

  const submit = () => {
    const prompt = instruction.trim();
    if (!prompt || isStreaming) return;
    void submitStream(prompt);
  };

  const disconnect = () => {
    if (abortRef.current) abortRef.current.abort();
    clearSession();
    setRepo(null);
    setTurns([]);
  };

  /* ═══════════════════════════════════════════
     STEP 1 — Connect screen (before repo)
     ═══════════════════════════════════════════ */
  if (!repo) {
    return (
      <main className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
        {/* Background image */}
        <div
          className="pointer-events-none fixed inset-0 z-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url(/robot-bg.png)" }}
          aria-hidden
        />
        {/* Frosted glass overlay */}
        <div
          className="pointer-events-none fixed inset-0 z-0"
          style={{
            backgroundColor: "var(--bg-frost)",
            backdropFilter: "blur(28px) saturate(150%)",
            WebkitBackdropFilter: "blur(28px) saturate(150%)",
          }}
          aria-hidden
        />

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-card/60 backdrop-blur-md">
              <Github className="h-5.5 w-5.5 text-primary" />
            </span>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">XerifeSwitch Agent</h1>
          </div>

          <div
            className="w-full max-w-sm space-y-3 rounded-3xl border border-border/50 bg-card/60 p-6 shadow-2xl backdrop-blur-2xl sm:p-8"
          >
            <div className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/40 px-4 py-3 backdrop-blur-sm">
              <KeyRound className="h-4.5 w-4.5 shrink-0 text-primary" />
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_..."
                className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>

            <div className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/40 px-4 py-3 backdrop-blur-sm">
              <Link2 className="h-4.5 w-4.5 shrink-0 text-primary" />
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/usuario/repo"
                className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Last repo suggestion */}
            {suggestedRepo && !repoUrl && (
              <button
                type="button"
                onClick={() => setRepoUrl(suggestedRepo)}
                className="flex w-full items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-2.5 text-xs font-mono text-primary transition-colors hover:bg-primary/10 hover:border-primary/40"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{suggestedRepo}</span>
                <span className="ml-auto shrink-0 text-primary/60">usar</span>
              </button>
            )}

            <button
              onClick={() => connectMutation.mutate()}
              disabled={connectMutation.isPending || token.length < 10 || repoUrl.length < 5}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground transition-all hover:shadow-lg hover:shadow-primary/20 disabled:opacity-40"
            >
              {connectMutation.isPending ? (
                <Loader2 className="h-4.5 w-4.5 animate-spin" />
              ) : (
                <Sparkles className="h-4.5 w-4.5" />
              )}
            </button>

            {connectMutation.isError && (
              <div className="flex items-center gap-2 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive backdrop-blur-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{(connectMutation.error as Error).message}</span>
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  /* ═══════════════════════════════════════════
     STEP 2 — Chat screen (after repo connected)
     ═══════════════════════════════════════════ */
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background font-sans text-foreground">
      {/* Background image */}
      <div
        className="pointer-events-none fixed inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url(/robot-bg.png)" }}
        aria-hidden
      />
      {/* Frosted glass overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundColor: "var(--bg-frost)",
          backdropFilter: "blur(28px) saturate(150%)",
          WebkitBackdropFilter: "blur(28px) saturate(150%)",
        }}
        aria-hidden
      />

      {/* ── Header ── */}
      <header className="z-30 shrink-0 border-b border-border bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card sm:h-10 sm:w-10">
              <Github className="h-4 w-4 text-primary sm:h-5 sm:w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold tracking-tight sm:text-xl lg:text-2xl">
                XerifeSwitch Agent
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Repo badge */}
            <button
              onClick={() => setShowRepoInfo((v) => !v)}
              className="hidden items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary sm:flex"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              <span>
                {repo.owner}/{repo.repo}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showRepoInfo ? "rotate-180" : ""}`}
              />
            </button>

            {/* Download ZIP button */}
            <button
              onClick={async () => {
                setDownloading(true);
                await downloadRepoZip(token, repoUrl, repo.branch);
                setDownloading(false);
              }}
              disabled={downloading}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-primary hover:text-primary hover:shadow-sm active:scale-95 disabled:opacity-40"
              aria-label="Baixar projeto como ZIP"
              title="Baixar repositório completo como ZIP"
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">Baixar</span>
            </button>

            {/* Preview toggle + inline URL input */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowPreviewPanel((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all hover:shadow-sm active:scale-95 ${
                  showPreviewPanel
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:border-primary hover:text-primary"
                }`}
                aria-label={showPreviewPanel ? "Ocultar preview" : "Mostrar preview"}
                title={showPreviewPanel ? "Ocultar preview ao lado" : "Mostrar preview ao lado do chat"}
              >
                {showPreviewPanel ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                <span className="hidden lg:inline">Preview</span>
              </button>

              {showPreviewPanel && (
                <div className="hidden md:flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1">
                  <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <input
                    type="url"
                    value={previewUrl}
                    onChange={(e) => setPreviewUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (previewUrl.trim()) {
                          setPreviewUrl(previewUrl.trim());
                          setShowPreviewPanel(true);
                        }
                      }
                    }}
                    placeholder="https://seu-site.netlify.app"
                    className="w-40 lg:w-52 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/40"
                  />
                  {previewUrl && (
                    <button
                      onClick={() => setPreviewKey((k) => k + 1)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-primary"
                      title="Recarregar preview"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Platform deploy links (dropdown) */}
            <div className="relative">
              <button
                onClick={() => setShowPreviewMenu((v) => v ? false : 'input')}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-primary hover:text-primary hover:shadow-sm active:scale-95"
                aria-label="Plataformas de deploy"
                title="Abrir em plataformas de deploy"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">Deploy</span>
                <ChevronDown className={`h-3 w-3 transition-transform ${showPreviewMenu ? "rotate-180" : ""}`} />
              </button>

              {showPreviewMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowPreviewMenu(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-border bg-card p-1.5 shadow-xl backdrop-blur-md">
                    <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Plataformas de deploy
                    </p>
                    {/* Link Externo — inline URL input */}
                    <div className="px-2.5 py-2">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Link2 className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">Link Externo</div>
                          <div className="text-[11px] text-muted-foreground">Cole a URL de preview do seu site</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/60 px-2 py-1.5">
                        <Globe className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                        <input
                          type="url"
                          value={previewUrl}
                          ref={externalUrlRef}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const val = (e.target as HTMLInputElement).value.trim();
                              if (val) {
                                setPreviewUrl(val);
                                setShowPreviewPanel(true);
                                setShowPreviewMenu(false);
                              }
                            }
                          }}
                          placeholder="https://seu-site.netlify.app"
                          className="flex-1 min-w-0 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/40"
                          onFocus={() => setShowPreviewMenu('input')}
                        />
                        <button
                          onClick={() => {
                            const val = externalUrlRef.current?.value.trim();
                            if (val) {
                              setPreviewUrl(val);
                              setShowPreviewPanel(true);
                              setShowPreviewMenu(false);
                            }
                          }}
                          className="shrink-0 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground transition-all hover:brightness-110 active:scale-95"
                        >
                          Preview
                        </button>
                      </div>
                    </div>

                    <div className="my-1 border-t border-border" />

                    {PREVIEW_PLATFORMS.map((platform) => {
                      const Icon = platform.icon;
                      return (
                        <a
                          key={platform.name}
                          href={platform.url(repo.owner, repo.repo)}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={() => setShowPreviewMenu(false)}
                          className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground">{platform.name}</div>
                            <div className="text-[11px] text-muted-foreground">{platform.description}</div>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <ThemeToggle />

            {/* Disconnect button */}
            <button
              onClick={disconnect}
              className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive transition-all hover:border-destructive/60 hover:bg-destructive/10 hover:shadow-sm hover:shadow-destructive/10 active:scale-95"
              aria-label="Desconectar repositório"
              title="Desconectar repositório e voltar ao painel inicial"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Desconectar</span>
            </button>
          </div>
        </div>

        {/* Repo info dropdown */}
        {showRepoInfo && (
          <div className="border-t border-border bg-card/90 backdrop-blur-sm">
            <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground">
                <div>
                  branch: <span className="text-foreground">{repo.branch}</span>
                </div>
                <div>
                  arquivos: <span className="text-foreground">{repo.totalFiles}</span>
                </div>
                <div>
                  indexados: <span className="text-foreground">{repo.indexedFiles}</span>
                </div>
                <div>
                  head: <span className="text-foreground">{repo.headSha.slice(0, 7)}</span>
                </div>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer font-mono text-[11px] uppercase text-muted-foreground hover:text-foreground">
                  ver arquivos indexados
                </summary>
                <div className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {repo.paths.map((p) => (
                    <div key={p.path} className="truncate">
                      {p.path}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </div>
        )}
      </header>

      {/* ── Chat ── */}
      <div className={`relative z-10 flex min-h-0 w-full flex-1 gap-3 px-4 py-4 sm:px-6 sm:py-6 ${showPreviewPanel && previewUrl ? "" : "max-w-7xl mx-auto"}`}>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card"
          style={{ boxShadow: "var(--shadow-panel)" }}
        >
          <div
            ref={chatContainerRef}
            className="relative min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain p-4 [-webkit-overflow-scrolling:touch] sm:space-y-5 sm:p-5"
          >
            {/* Scroll-to-bottom FAB */}
            {showScrollBtn && (
              <button
                onClick={() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" })}
                className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm transition-all hover:bg-accent hover:text-accent-foreground"
                aria-label="Rolar para baixo"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Nova mensagem
              </button>
            )}
            {turns.length === 0 && !isStreaming && (
              <div className="rounded-lg border border-dashed border-border p-4 text-[15px] text-muted-foreground sm:p-6">
                <p className="mb-2 font-semibold text-foreground">Repositório conectado</p>
                <p className="mb-3 text-xs">
                  <span className="font-mono text-primary">
                    {repo.owner}/{repo.repo}
                  </span>{" "}
                  — {repo.indexedFiles} arquivos indexados
                </p>
                <p className="mb-2 font-semibold text-foreground">Como usar</p>
                <ol className="list-inside list-decimal space-y-1 font-mono text-xs">
                  <li>Descreva o que alterar, adicionar ou corrigir.</li>
                  <li>O agente entende a estrutura e garante consistência entre arquivos.</li>
                  <li>Alterações são commitadas direto na main automaticamente.</li>
                  <li>Anexe imagens se precisar (arraste, clique no clipe ou Ctrl+V).</li>
                </ol>
              </div>
            )}

            {turns.map((t, i) => (
              <div
                key={i}
                className={`flex gap-2.5 sm:gap-3 ${t.role === "user" ? "flex-row-reverse" : "flex-row"}`}
              >
                {/* Avatar */}
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white sm:h-8 sm:w-8 ${
                    t.role === "user"
                      ? "bg-gradient-to-br from-primary/80 to-primary shadow-sm shadow-primary/25"
                      : t.error
                        ? "bg-gradient-to-br from-destructive/80 to-destructive shadow-sm shadow-destructive/25"
                        : "bg-gradient-to-br from-chart-4 to-accent shadow-sm shadow-accent/20"
                  }`}
                >
                  {t.role === "user" ? (
                    <User className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  )}
                </div>

                {/* Bubble */}
                <div
                  className={`max-w-[82%] sm:max-w-[78%] ${
                    t.role === "user"
                      ? "rounded-2xl rounded-tr-sm border-0 bg-primary text-primary-foreground shadow-md shadow-primary/15 px-3.5 py-2.5 sm:px-4 sm:py-3"
                      : t.error
                        ? "rounded-2xl rounded-tl-sm border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 sm:px-4 sm:py-3"
                        : "rounded-2xl rounded-tl-sm border border-border bg-secondary/50 px-3.5 py-2.5 sm:px-4 sm:py-3"
                  }`}
                >
                  <p
                    className={`mb-1.5 text-[10px] font-semibold uppercase tracking-wider sm:text-[11px] ${
                      t.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
                    }`}
                  >
                    {t.role === "user" ? "Você" : "Agente"}
                  </p>
                  <div
                    className={`prose prose-sm max-w-none text-[15px] leading-relaxed ${t.error ? "text-destructive" : ""} ${t.role === "user" ? "prose-invert" : ""}`}
                  >
                    <ReactMarkdown>{t.content}</ReactMarkdown>
                  </div>

                  <MessageAttachments attachments={t.attachments} />

                  {t.imageIntent === "add-to-project" && (
                    <p className="mt-2 font-mono text-[11px] text-primary/80">
                      imagens adicionadas ao projeto
                    </p>
                  )}

                  {t.reasoning && (
                    <details className="mt-3 rounded-lg border border-border/60 bg-background/60 p-2.5">
                      <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
                        raciocínio / análise
                      </summary>
                      <div className="prose prose-sm mt-2 max-w-none text-xs">
                        <ReactMarkdown>{t.reasoning}</ReactMarkdown>
                      </div>
                    </details>
                  )}

                  {t.changedPaths && t.changedPaths.length > 0 && (
                    <div className="mt-2.5 space-y-1 font-mono text-[11px] text-muted-foreground">
                      {t.changedPaths.map((p) => (
                        <div key={p} className="flex items-center gap-2">
                          <CheckCircle2 className="h-3 w-3 text-primary" /> {p}
                        </div>
                      ))}
                    </div>
                  )}

                  {t.commitUrl && (
                    <a
                      href={t.commitUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/8 px-3 py-1.5 font-mono text-[11px] font-medium text-primary transition-colors hover:bg-primary/15"
                    >
                      <GitBranch className="h-3 w-3" /> commit na main
                    </a>
                  )}
                </div>
              </div>
            ))}

            {/* ── Streaming progress indicator ── */}
            {isStreaming && (
              <div className="flex gap-2.5 sm:gap-3">
                {/* Agent avatar */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-chart-4 to-accent text-white shadow-sm shadow-accent/20 sm:h-8 sm:w-8">
                  <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </div>
                <div className="max-w-[82%] sm:max-w-[78%] rounded-2xl rounded-tl-md border border-primary/30 bg-primary/5 px-3.5 py-2.5 sm:px-4 sm:py-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary sm:text-[11px]">
                    Agente
                  </p>
                  {/* Phase indicator */}
                  <div className="flex items-center gap-2 mb-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    <span className="text-xs font-medium text-primary">
                      {PHASE_LABELS[streamPhase]}
                    </span>
                    {streamPhase === "thinking" && (
                      <BrainCircuit className="h-3.5 w-3.5 text-primary/60" />
                    )}
                    {streamPhase === "committing" && (
                      <Upload className="h-3.5 w-3.5 text-primary/60" />
                    )}
                    {streamPhase === "snapshot" && (
                      <Github className="h-3.5 w-3.5 text-primary/60" />
                    )}
                  </div>
                  {/* Streaming text preview */}
                  {streamText && (
                    <div className="rounded-lg border border-border/50 bg-card/50 p-2.5">
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                        {streamText}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Anchor for auto-scroll */}
            <div ref={chatEndRef} />
          </div>

          {/* ── Composer ── */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
            }}
            onPaste={handlePaste}
            className={`shrink-0 border-t border-border/50 p-3 transition-all sm:p-4 ${dragging ? "bg-primary/5 border-primary/40" : ""}`}
          >
            <ComposerAttachments
              attachments={attachments}
              onRemove={(name) => setAttachments((p) => p.filter((x) => x.name !== name))}
            />

            {/* Image intent selector — only shown when images are attached */}
            {attachments.some((a) => a.mime?.startsWith("image/")) && (
              <div className="mb-2.5 flex items-center gap-2">
                <span className="shrink-0 text-[11px] font-medium text-muted-foreground">Imagens:</span>
                <button
                  type="button"
                  onClick={() => setImageIntent("reference-only")}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
                    imageIntent === "reference-only"
                      ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <Eye className="h-3 w-3" />
                  Referência visual
                </button>
                <button
                  type="button"
                  onClick={() => setImageIntent("add-to-project")}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
                    imageIntent === "add-to-project"
                      ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <ImagePlus className="h-3 w-3" />
                  Salvar no projeto
                </button>
              </div>
            )}

            <div
              className={`flex items-end gap-2 rounded-2xl border bg-background/60 px-2 py-2 backdrop-blur-md transition-all sm:gap-2.5 sm:px-3 sm:py-2.5 ${dragging ? "border-primary/50 shadow-lg shadow-primary/10" : "border-border/40 focus-within:border-primary/40 focus-within:shadow-lg focus-within:shadow-primary/5"}`}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && void addFiles(e.target.files)}
              />

              <button
                onClick={() => fileInput.current?.click()}
                className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/40 transition-all hover:bg-accent/50 hover:text-primary active:scale-90"
                aria-label="Anexar arquivos"
                title="Anexar (Ctrl+V para colar)"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>

              <div className="relative min-w-0 flex-1">
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={1}
                  placeholder="Descreva o que alterar, adicionar ou corrigir..."
                  className="block w-full min-h-[2rem] max-h-40 resize-none bg-transparent py-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/35"
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 160) + "px";
                  }}
                />
              </div>

              <button
                onClick={submit}
                disabled={isStreaming || !instruction.trim()}
                className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/25 transition-all hover:shadow-lg hover:shadow-primary/35 hover:brightness-110 active:scale-90 disabled:opacity-20 disabled:shadow-none disabled:brightness-100"
              >
                {isStreaming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* ── Preview panel ── */}
        {showPreviewPanel && previewUrl && (
          <div className="hidden md:flex w-[45%] min-w-[320px] max-w-[700px] flex-col rounded-2xl border border-border bg-card overflow-hidden" style={{ boxShadow: "var(--shadow-panel)" }}>
            {/* Preview header bar */}
            <div className="flex items-center gap-2 border-b border-border bg-background/60 px-3 py-2">
              <Monitor className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">{previewUrl}</span>
              <button
                onClick={() => setPreviewKey((k) => k + 1)}
                className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-primary"
                title="Recarregar preview"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-primary"
                title="Abrir em nova aba"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
              <button
                onClick={() => setShowPreviewPanel(false)}
                className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                title="Fechar preview"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {/* iframe */}
            <div className="relative flex-1 bg-white dark:bg-gray-50">
              {!previewUrl && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  <div className="text-center px-4">
                    <Monitor className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
                    <p>Cole a URL do seu site</p>
                    <p className="text-xs mt-1">(ex: https://meu-site.netlify.app)</p>
                  </div>
                </div>
              )}
              {previewUrl && (
                <iframe
                  key={previewKey}
                  ref={previewIframeRef}
                  src={previewUrl}
                  className="absolute inset-0 h-full w-full border-0"
                  title="Preview do projeto"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  loading="lazy"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
