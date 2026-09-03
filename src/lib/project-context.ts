/**
 * Project Context Store — Persistência de contexto do projeto entre solicitações.
 *
 * Mantém em memória (com TTL) e opcionalmente em disco:
 *  - Análise completa do projeto (framework, deps, conventions)
 *  - Dependency graph (conexões entre arquivos)
 *  - Component registry (componentes disponíveis para reuso)
 *  - Histórico de mudanças da sessão (actions, commits, rollbacks)
 *  - Resumo compacto para injeção no prompt do LLM
 *
 * Isso garante que o agente NÃO perca o contexto do projeto
 * entre solicitações seguidas, mesmo se o snapshot cache expirar.
 */

import { analyzeProjectContext, type ProjectAnalysis } from "./agent-core";
import { DependencyTracker, ComponentRegistry, type DepNode, type ComponentEntry } from "./dependency-tracker";
import { VirtualFileSystem, getVfs, type VfsAction, type RollbackPoint } from "./virtual-fs";

// ── Types ──

export interface ProjectContextSnapshot {
  owner: string;
  repo: string;
  branch: string;
  headSha: string;

  /** Timestamp da última atualização deste contexto */
  lastUpdated: number;

  /** Análise do projeto (framework, deps, conventions, etc.) */
  analysis: ProjectAnalysis;

  /** Número de arquivos no snapshot */
  fileCount: number;

  /** Número de paths no repo (incluindo binários skipados) */
  totalPaths: number;

  /** Resumo compacto da arquitetura para injeção no prompt */
  architectureSummary: string;

  /** Conexões entre arquivos (imports/exports) — compactado para o prompt */
  fileConnections: string[];

  /** Componentes disponíveis para reuso */
  availableComponents: ComponentEntry[];

  /** Histórico de mudanças desta sessão */
  sessionHistory: SessionAction[];

  /** Rollback points disponíveis */
  rollbackPoints: RollbackPoint[];
}

export interface SessionAction {
  id: string;
  timestamp: number;
  instruction: string;
  changedPaths: string[];
  commitSha?: string | undefined;
  commitUrl?: string | undefined;
  validationPassed: boolean;
  validationWarnings?: number | undefined;
  impactedDeps?: string[] | undefined;
}

// ── Context Store ──

const _contextStore = new Map<string, ProjectContextSnapshot>();
const CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 minutes — bem maior que o snapshot cache

/**
 * Obtém o contexto persistido do projeto, ou null se expirado/inexistente.
 */
export function getProjectContext(owner: string, repo: string): ProjectContextSnapshot | null {
  const key = `${owner}/${repo}`;
  const ctx = _contextStore.get(key);
  if (!ctx) return null;

  // Check TTL
  if (Date.now() - ctx.lastUpdated > CONTEXT_TTL_MS) {
    _contextStore.delete(key);
    return null;
  }

  return ctx;
}

/**
 * Constrói e armazena o contexto completo do projeto a partir do snapshot.
 * Deve ser chamado após obter/refresh o snapshot do GitHub.
 *
 * @returns O contexto construído (também armazenado internamente)
 */
export function buildProjectContext(
  owner: string,
  repo: string,
  branch: string,
  headSha: string,
  files: { path: string; content: string }[],
  totalPaths: number,
): ProjectContextSnapshot {
  const key = `${owner}/${repo}`;

  // ── Análise do projeto ──
  const analysis = analyzeProjectContext(files);

  // ── Dependency graph ──
  const depTracker = new DependencyTracker();
  depTracker.buildGraph(files);
  const allNodes = depTracker.getAllNodes();

  // ── Component registry ──
  const compRegistry = new ComponentRegistry();
  compRegistry.build(files);
  const availableComponents = compRegistry.getAll();

  // ── VFS: carregar snapshot se não existir ──
  const vfs = getVfs(owner, repo);
  const existingCtx = _contextStore.get(key);
  if (!existingCtx || existingCtx.headSha !== headSha) {
    // Snapshot mudou — recarregar VFS
    vfs.loadSnapshot(files, headSha);
  }

  // ── Construir resumo de arquitetura ──
  const architectureSummary = buildArchitectureSummary(analysis, files, allNodes);

  // ── Construir conexões entre arquivos (compacto) ──
  const fileConnections = buildFileConnections(allNodes);

  // ── Preservar histórico de sessão existente ──
  const sessionHistory = existingCtx?.sessionHistory ?? [];
  const rollbackPoints = vfs.getRollbackPoints();

  const ctx: ProjectContextSnapshot = {
    owner,
    repo,
    branch,
    headSha,
    lastUpdated: Date.now(),
    analysis,
    fileCount: files.length,
    totalPaths,
    architectureSummary,
    fileConnections,
    availableComponents,
    sessionHistory,
    rollbackPoints,
  };

  _contextStore.set(key, ctx);
  return ctx;
}

/**
 * Atualiza o contexto após uma mudança ser aplicada.
 * Deve ser chamado após commit bem-sucedido.
 */
export function updateContextAfterChange(
  owner: string,
  repo: string,
  instruction: string,
  changedPaths: string[],
  commitSha?: string,
  commitUrl?: string,
  validationPassed?: boolean,
  validationWarnings?: number,
  impactedDeps?: string[],
): void {
  const key = `${owner}/${repo}`;
  const ctx = _contextStore.get(key);
  if (!ctx) return;

  // Adicionar ação ao histórico
  const action: SessionAction = {
    id: `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    instruction,
    changedPaths,
    commitSha,
    commitUrl,
    validationPassed: validationPassed ?? true,
    validationWarnings,
    impactedDeps,
  };

  ctx.sessionHistory.push(action);

  // Manter no máximo 50 ações no histórico
  if (ctx.sessionHistory.length > 50) {
    ctx.sessionHistory = ctx.sessionHistory.slice(-50);
  }

  // Atualizar rollback points do VFS
  const vfs = getVfs(owner, repo);
  ctx.rollbackPoints = vfs.getRollbackPoints();

  ctx.lastUpdated = Date.now();
  _contextStore.set(key, ctx);
}

/**
 * Atualiza o dependency graph e component registry após mudanças.
 * Chamado quando novos arquivos são adicionados ao VFS.
 */
export function refreshProjectStructure(
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
): void {
  const key = `${owner}/${repo}`;
  const ctx = _contextStore.get(key);
  if (!ctx) return;

  // Re-analisar
  const analysis = analyzeProjectContext(files);

  // Re-construir dependency graph
  const depTracker = new DependencyTracker();
  depTracker.buildGraph(files);
  const allNodes = depTracker.getAllNodes();

  // Re-construir component registry
  const compRegistry = new ComponentRegistry();
  compRegistry.build(files);

  // Atualizar contexto
  ctx.analysis = analysis;
  ctx.architectureSummary = buildArchitectureSummary(analysis, files, allNodes);
  ctx.fileConnections = buildFileConnections(allNodes);
  ctx.availableComponents = compRegistry.getAll();
  ctx.fileCount = files.length;
  ctx.lastUpdated = Date.now();

  _contextStore.set(key, ctx);
}

/**
 * Gera o bloco de contexto enriquecido para injeção no prompt do sistema.
 * Este é o texto que vai DENTRO do system prompt para garantir que
 * o LLM sempre tenha conhecimento completo do projeto.
 */
export function buildContextBlock(ctx: ProjectContextSnapshot): string {
  const sections: string[] = [];

  // ── Arquitetura do projeto ──
  sections.push(`═══ ARQUITETURA DO PROJETO ═══
${ctx.architectureSummary}`);

  // ── Conexões entre arquivos (top 40 mais conectados) ──
  if (ctx.fileConnections.length > 0) {
    sections.push(`═══ CONEXÕES ENTRE ARQUIVOS (imports/exports) ═══
${ctx.fileConnections.slice(0, 40).join("\n")}
${ctx.fileConnections.length > 40 ? `(... e mais ${ctx.fileConnections.length - 40} conexões)` : ""}`);
  }

  // ── Componentes disponíveis para reuso ──
  if (ctx.availableComponents.length > 0) {
    const compLines = ctx.availableComponents.slice(0, 30).map((c) => {
      const propsStr = c.props?.length ? ` → props: ${c.props.join(", ")}` : "";
      const childrenStr = c.hasChildren ? " [children]" : "";
      return `- <${c.name}> (${c.path})${propsStr}${childrenStr}`;
    });
    sections.push(`═══ COMPONENTES DISPONÍVEIS (reutilize ANTES de criar novos) ═══
${compLines.join("\n")}
${ctx.availableComponents.length > 30 ? `(... e mais ${ctx.availableComponents.length - 30} componentes)` : ""}`);
  }

  // ── Histórico de mudanças desta sessão ──
  if (ctx.sessionHistory.length > 0) {
    const recentActions = ctx.sessionHistory.slice(-8);
    const historyLines = recentActions.map((a) => {
      const pathsStr = a.changedPaths.length <= 3
        ? a.changedPaths.join(", ")
        : `${a.changedPaths.slice(0, 3).join(", ")} +${a.changedPaths.length - 3} mais`;
      const validStr = a.validationPassed ? "✓" : "✗";
      const depStr = a.impactedDeps?.length ? ` → impactou: ${a.impactedDeps.join(", ")}` : "";
      return `- [${validStr}] "${a.instruction.slice(0, 60)}" → ${pathsStr}${depStr}`;
    });
    sections.push(`═══ HISTÓRICO DE MUDANÇAS DESTA SESSÃO ═══
${historyLines.join("\n")}
(Total: ${ctx.sessionHistory.length} ações nesta sessão)`);
  }

  // ── Rollback points ──
  if (ctx.rollbackPoints.length > 1) {
    const rpLines = ctx.rollbackPoints.slice(-5).map((rp, i) => {
      const label = i === 0 ? "inicial" : `"${rp.instruction.slice(0, 40)}"`;
      return `- ${rp.sha.slice(0, 7)} (${label}, ${rp.actionCount} mudanças)`;
    });
    sections.push(`═══ PONTOS DE ROLLBACK DISPONÍVEIS ═══
${rpLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Gera resumo compacto das dependências impactadas por mudanças propostas.
 * Para incluir no prompt quando o LLM precisa decidir quais arquivos alterar.
 */
export function buildImpactAnalysis(
  ctx: ProjectContextSnapshot,
  changedPaths: string[],
  allRepoPaths: string[],
): string {
  const depTracker = new DependencyTracker();

  // Reconstruir graph minimal a partir das conexões armazenadas
  // (não temos o graph completo aqui, mas temos as conexões como strings)
  // Em vez disso, usamos análise heurística baseada nos paths
  const impacted = new Set<string>();

  // Para cada path modificado, encontrar arquivos que importam ele
  for (const changedPath of changedPaths) {
    for (const conn of ctx.fileConnections) {
      if (conn.includes(changedPath) && !changedPaths.some(p => conn.startsWith(p))) {
        // Esta conexão menciona o arquivo modificado — o outro arquivo pode ser impactado
        const match = conn.match(/^(\S+)/);
        if (match && !changedPaths.includes(match[1]!)) {
          impacted.add(match[1]!);
        }
      }
    }
  }

  if (impacted.size === 0) return "";

  const lines: string[] = [
    "⚠️ ANÁLISE DE IMPACTO — Os seguintes arquivos podem precisar de atualização:",
  ];
  for (const p of impacted) {
    if (allRepoPaths.includes(p)) {
      lines.push(`  - ${p} (importa algo que foi modificado)`);
    }
  }

  return lines.join("\n");
}

// ── Private helpers ──

function buildArchitectureSummary(
  analysis: ProjectAnalysis,
  files: { path: string; content: string }[],
  depNodes: DepNode[],
): string {
  const lines: string[] = [];

  // Stack info
  lines.push(`Framework: ${analysis.framework}`);
  lines.push(`Build Tool: ${analysis.buildTool}`);
  lines.push(`Styling: ${analysis.styling}`);
  lines.push(`Routing: ${analysis.routing}`);
  lines.push(`State Management: ${analysis.stateManagement}`);
  lines.push(`Language: ${analysis.language}`);

  // Key dependencies
  const keyDeps = analysis.dependencies.filter((d) =>
    /^(react|next|vue|svelte|tanstack|tailwind|prisma|drizzle|trpc|zod|shadcn|radix)/i.test(d)
  );
  if (keyDeps.length > 0) {
    lines.push(`Dependências-chave: ${keyDeps.join(", ")}`);
  }

  // Conventions
  if (analysis.conventions.length > 0) {
    lines.push(`Convenções: ${analysis.conventions.join("; ")}`);
  }

  // Entry points
  if (analysis.entryPoints.length > 0) {
    lines.push(`Entry points: ${analysis.entryPoints.join(", ")}`);
  }

  // Directory structure (compact)
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts.length > 1) {
      dirs.add(parts.slice(0, -1).join("/"));
    }
  }
  const dirTree = buildCompactDirTree([...dirs]);
  lines.push(`\nEstrutura de diretórios:\n${dirTree}`);

  // Most-connected files (hub files)
  const hubs = depNodes
    .filter((n) => n.importedBy.length >= 2)
    .sort((a, b) => b.importedBy.length - a.importedBy.length)
    .slice(0, 10);
  if (hubs.length > 0) {
    lines.push(`\nArquivos mais importados (hubs):`);
    for (const h of hubs) {
      lines.push(`  - ${h.path} ← importado por ${h.importedBy.length} arquivos`);
    }
  }

  return lines.join("\n");
}

function buildFileConnections(nodes: DepNode[]): string[] {
  const lines: string[] = [];

  for (const node of nodes) {
    if (node.imports.length === 0 && node.importedBy.length === 0) continue;

    // Only include files with meaningful connections
    const localImports = node.imports.filter((imp) =>
      !imp.startsWith("node:") && !imp.startsWith("react") && !imp.startsWith("@radix-ui")
    );
    if (localImports.length === 0 && node.importedBy.length === 0) continue;

    const importStr = localImports.length > 0
      ? ` → importa: ${localImports.map(p => p.split("/").pop()).join(", ")}`
      : "";
    const importedByStr = node.importedBy.length > 0 && node.importedBy.length <= 5
      ? ` ← importado por: ${node.importedBy.map(p => p.split("/").pop()).join(", ")}`
      : node.importedBy.length > 5
        ? ` ← importado por ${node.importedBy.length} arquivos`
        : "";

    lines.push(`${node.path}${importStr}${importedByStr}`);
  }

  return lines;
}

function buildCompactDirTree(dirs: string[]): string {
  // Build a tree structure and render it compactly
  const root: Record<string, any> = {};
  for (const dir of dirs.sort()) {
    const parts = dir.split("/");
    let current = root;
    for (const part of parts) {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
  }

  const lines: string[] = [];
  renderTree(root, "", lines, 0, 3); // max depth 3
  return lines.join("\n");
}

function renderTree(
  node: Record<string, any>,
  prefix: string,
  lines: string[],
  depth: number,
  maxDepth: number,
): void {
  if (depth >= maxDepth) return;
  const entries = Object.entries(node).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, children] of entries) {
    const hasChildren = Object.keys(children).length > 0;
    lines.push(`${prefix}${name}/`);
    if (hasChildren) {
      renderTree(children, `${prefix}  `, lines, depth + 1, maxDepth);
    }
  }
}
