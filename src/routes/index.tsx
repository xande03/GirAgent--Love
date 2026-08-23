a api do deepseek esta respondendo?
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  GitBranch,
  Github,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Trash2,
  FileCode2,
  ImageIcon,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

import { connectRepo, runAgent } from "@/lib/agent.functions";

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
  const fileInput = useRef<HTMLInputElement>(null);

  const connectMutation = useMutation({
    mutationFn: () => connect({ data: { token, repoUrl } }),
    onSuccess: (data) => setRepo(data),
  });

  const runMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.content }));
      return run({
        data: {
          token,
          repoUrl,
          instruction: prompt,
          attachments: attachments.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })),
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
      setAttachments([]);
    },
    onError: (err: Error) => {
      setTurns((t) => [...t, { role: "assistant", content: err.message, error: true }]);
    },
  });

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
    setTurns((t) => [...t, { role: "user", content: prompt, attachments }]);
    setInstruction("");
    runMutation.mutate(prompt);
  };

  return (
    <main className="min-h-screen bg-background font-sans text-foreground">
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{ background: "var(--gradient-hero)" }}
        aria-hidden
      />
      <div className="relative mx-auto w-full max-w-6xl px-5 py-10">
        <header className="mb-10 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-card">
              <Github className="h-5 w-5 text-primary" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">XerifeSwitch Agent</h1>
              <p className="font-mono text-xs text-muted-foreground">
                clone → indexa → raciocina → altera → commit automático em main
              </p>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* Conexão */}
          <aside className="space-y-4">
            <div
              className="rounded-xl border border-border bg-card p-5"
              style={{ boxShadow: "var(--shadow-panel)" }}
            >
              <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <GitBranch className="h-4 w-4 text-primary" /> Conectar repositório
              </h2>
              <label className="mb-1 block font-mono text-xs text-muted-foreground">
                GitHub token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_..."
                className="mb-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
              />
              <label className="mb-1 block font-mono text-xs text-muted-foreground">
                URL do repositório
              </label>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/usuario/repo"
                className="mb-4 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
              />
              <button
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending || token.length < 10 || repoUrl.length < 5}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {connectMutation.isPending ? "Indexando projeto..." : "Clonar e indexar"}
              </button>
              {connectMutation.isError && (
                <p className="mt-3 flex gap-2 text-xs text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {(connectMutation.error as Error).message}
                </p>
              )}
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                O token é usado apenas nesta sessão para ler e comitar. Commits vão sempre para
                <span className="text-primary"> main</span>, sem branches.
              </p>
            </div>

            {repo && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <FileCode2 className="h-4 w-4 text-accent" /> {repo.owner}/{repo.repo}
                </h3>
                <dl className="space-y-1 font-mono text-xs text-muted-foreground">
                  <div>branch padrão: {repo.branch}</div>
                  <div>arquivos: {repo.totalFiles}</div>
                  <div>indexados no contexto: {repo.indexedFiles}</div>
                  <div>head: {repo.headSha.slice(0, 7)}</div>
                </dl>
                <div className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {repo.paths.map((p) => (
                    <div key={p.path} className="truncate">
                      {p.path}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* Chat / agente */}
          <div
            className="flex min-h-[70vh] flex-col rounded-xl border border-border bg-card"
            style={{ boxShadow: "var(--shadow-panel)" }}
          >
            <div className="flex-1 space-y-5 overflow-auto p-5">
              {turns.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                  <p className="mb-2 font-semibold text-foreground">Como funciona</p>
                  <ol className="list-inside list-decimal space-y-1 font-mono text-xs">
                    <li>Conecte o token + URL: o agente lê toda a árvore de arquivos.</li>
                    <li>Descreva o que alterar, adicionar ou corrigir.</li>
                    <li>
                      O agente entende a estrutura, garante que os arquivos "conversem" entre si e
                      comita direto na main.
                    </li>
                    <li>
                      Imagens em anexo só entram no repositório quando você pedir explicitamente;
                      caso contrário são referência visual.
                    </li>
                  </ol>
                </div>
              )}

              {turns.map((t, i) => (
                <article
                  key={i}
                  className={
                    t.role === "user"
                      ? "ml-auto max-w-[85%] rounded-lg border border-border bg-secondary p-4"
                      : "max-w-[92%] rounded-lg border border-border bg-background p-4"
                  }
                >
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t.role === "user" ? "você" : "agente"}
                  </p>
                  <div
                    className={`prose prose-sm max-w-none text-sm leading-relaxed ${t.error ? "text-destructive" : ""}`}
                  >
                    <ReactMarkdown>{t.content}</ReactMarkdown>
                  </div>

                  {t.attachments && t.attachments.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {t.attachments.map((a) => (
                        <span
                          key={a.name}
                          className="flex items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground"
                        >
                          <ImageIcon className="h-3 w-3" /> {a.name}
                        </span>
                      ))}
                    </div>
                  )}

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
            </div>

            {/* Composer */}
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
              className={`border-t p-4 transition-colors ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
            >
              {attachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((a) => (
                    <span
                      key={a.name}
                      className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
                    >
                      {a.mime.startsWith("image/") ? (
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-6 w-6 rounded object-cover"
                        />
                      ) : (
                        <Paperclip className="h-3 w-3" />
                      )}
                      {a.name}
                      <button
                        onClick={() => setAttachments((p) => p.filter((x) => x.name !== a.name))}
                        aria-label={`Remover ${a.name}`}
                      >
                        <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

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
                  disabled={!repo}
                  rows={2}
                  placeholder={
                    repo
                      ? "Ex: corrija o hero da home e centralize o título — arraste imagens aqui se precisar"
                      : "Conecte um repositório para liberar o agente"
                  }
                  className="min-h-10 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  onClick={submit}
                  disabled={!repo || runMutation.isPending || !instruction.trim()}
                  className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" /> Aplicar
                </button>
              </div>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                arraste e solte arquivos ou imagens aqui · Enter envia · commit automático em main
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
