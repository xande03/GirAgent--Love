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
  FileCode2,
  CheckCircle2,
  AlertTriangle,
  ArrowDown,
  Unplug,
  ChevronDown,
  KeyRound,
  Link2,
} from "lucide-react";

import { connectRepo, runAgent } from "@/lib/agent.functions";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { ComposerAttachments, MessageAttachments } from "@/components/attachment-preview";

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

function Home() {
  const connect = useServerFn(connectRepo);
  const run = useServerFn(runAgent);

  const [token, setToken] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [instruction, setInstruction] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [showRepoInfo, setShowRepoInfo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);


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
    },
  });

  const runMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.content }));
      const lastUserTurn = [...turns].reverse().find((t) => t.role === "user");
      const pendingAttachments = lastUserTurn?.attachments ?? [];
      return run({
        data: {
          token,
          repoUrl,
          instruction: prompt,
          attachments: pendingAttachments.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })),
          history,
        },
      });
    },
    onSuccess: (res) => {
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: res.summary,
          reasoning: res.reasoning,
          changedPaths: res.changedPaths,
          commitUrl: res.commit?.url,
          imageIntent: res.imageIntent,
        },
      ]);
    },
    onError: (err: Error) => {
      setTurns((t) => [...t, { role: "assistant", content: err.message, error: true }]);
    },
  });

  /* Auto-scroll to bottom when new messages arrive */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, runMutation.isPending]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 6);
    const loaded = await Promise.all(
      list.map(
        (file) =>
          new Promise<Attachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: file.name,
                mime: file.type || "application/octet-stream",
                dataUrl: String(reader.result),
                size: file.size,
              });
            reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
            reader.readAsDataURL(file);
          }),
      ),
    );
    setAttachments((prev) => [...prev, ...loaded].slice(0, 6));
  }, []);

  const submit = () => {
    const prompt = instruction.trim();
    if (!prompt || runMutation.isPending) return;
    const currentAttachments = attachments;
    setTurns((t) => [...t, { role: "user", content: prompt, attachments: currentAttachments }]);
    setInstruction("");
    setAttachments([]);
    if (fileInput.current) fileInput.current.value = "";
    runMutation.mutate(prompt);
  };

  const disconnect = () => {
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

        <header className="relative z-10 border-b border-border/50 bg-background/60 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-card/60 backdrop-blur-md">
              <Github className="h-5 w-5 text-primary" />
            </span>
            <ThemeToggle />
          </div>
        </header>

        <div className="relative z-10 flex flex-1 items-center justify-center px-4 py-10">
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

      {/* ── Header ── */}
      <header className="relative z-10 border-b border-border bg-background/80 backdrop-blur-md">
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
              <span>{repo.owner}/{repo.repo}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showRepoInfo ? "rotate-180" : ""}`} />
            </button>

            {/* Disconnect button (mobile: icon only) */}
            <button
              onClick={disconnect}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
              aria-label="Desconectar repositório"
              title="Desconectar"
            >
              <Unplug className="h-4 w-4" />
            </button>

            <ThemeToggle />
          </div>
        </div>

        {/* Repo info dropdown */}
        {showRepoInfo && (
          <div className="border-t border-border bg-card/90 backdrop-blur-sm">
            <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground">
                <div>branch: <span className="text-foreground">{repo.branch}</span></div>
                <div>arquivos: <span className="text-foreground">{repo.totalFiles}</span></div>
                <div>indexados: <span className="text-foreground">{repo.indexedFiles}</span></div>
                <div>head: <span className="text-foreground">{repo.headSha.slice(0, 7)}</span></div>
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
      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
        <div
          className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card"
          style={{ boxShadow: "var(--shadow-panel)" }}
        >
          <div
            ref={chatContainerRef}
            className="relative flex-1 space-y-4 overflow-auto p-4 sm:space-y-5 sm:p-5"
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
            {turns.length === 0 && (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground sm:p-6">
                <p className="mb-2 font-semibold text-foreground">Repositório conectado</p>
                <p className="mb-3 text-xs">
                  <span className="font-mono text-primary">{repo.owner}/{repo.repo}</span> — {repo.indexedFiles} arquivos indexados
                </p>
                <p className="mb-2 font-semibold text-foreground">Como usar</p>
                <ol className="list-inside list-decimal space-y-1 font-mono text-xs">
                  <li>Descreva o que alterar, adicionar ou corrigir.</li>
                  <li>O agente entende a estrutura e garante consistência entre arquivos.</li>
                  <li>Alterações são commitadas direto na main automaticamente.</li>
                  <li>Anexe imagens se precisar (arraste ou clique no clipe).</li>
                </ol>
              </div>
            )}

            {turns.map((t, i) => (
              <article
                key={i}
                className={
                  t.role === "user"
                    ? "ml-auto max-w-[85%] rounded-lg border border-border bg-secondary p-3 sm:p-4"
                    : "max-w-[92%] rounded-lg border border-border bg-background p-3 sm:p-4"
                }
              >
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:text-[11px]">
                  {t.role === "user" ? "você" : "agente"}
                </p>
                <div
                  className={`prose prose-sm max-w-none text-sm leading-relaxed ${t.error ? "text-destructive" : ""}`}
                >
                  <ReactMarkdown>{t.content}</ReactMarkdown>
                </div>

                <MessageAttachments attachments={t.attachments} />

                {t.imageIntent && (
                  <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                    imagens:{" "}
                    {t.imageIntent === "add-to-project"
                      ? "adicionadas ao projeto"
                      : "usadas apenas como referência"}
                  </p>
                )}

                {t.reasoning && (
                  <details className="mt-3 rounded-md border border-border bg-card p-3">
                    <summary className="cursor-pointer font-mono text-[11px] uppercase text-muted-foreground">
                      raciocínio / análise da estrutura
                    </summary>
                    <div className="prose prose-sm mt-2 max-w-none text-xs">
                      <ReactMarkdown>{t.reasoning}</ReactMarkdown>
                    </div>
                  </details>
                )}

                {t.changedPaths && t.changedPaths.length > 0 && (
                  <div className="mt-3 space-y-1 font-mono text-[11px] text-muted-foreground">
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
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary px-3 py-1.5 font-mono text-[11px] text-primary hover:bg-primary/10"
                  >
                    <GitBranch className="h-3 w-3" /> commit enviado para main
                  </a>
                )}
              </article>
            ))}

            {runMutation.isPending && (
              <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> analisando estrutura,
                aplicando mudanças e comitando...
              </p>
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
            className={`shrink-0 border-t p-3 transition-colors sm:p-4 ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
          >
            <ComposerAttachments
              attachments={attachments}
              onRemove={(name) => setAttachments((p) => p.filter((x) => x.name !== name))}
            />

            <div className="flex items-end gap-2">
              <button
                onClick={() => fileInput.current?.click()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary hover:text-primary"
                aria-label="Enviar anexos"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && void addFiles(e.target.files)}
              />
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder="Ex: corrija o hero da home e centralize o título — arraste imagens aqui se precisar"
                className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                onClick={submit}
                disabled={runMutation.isPending || !instruction.trim()}
                className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 sm:px-4"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">Aplicar</span>
              </button>
            </div>
            <p className="mt-2 hidden font-mono text-[11px] text-muted-foreground sm:block">
              arraste e solte arquivos ou imagens aqui · Enter envia · commit automático em main
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
