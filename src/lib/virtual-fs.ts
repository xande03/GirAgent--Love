/**
 * Virtual File System — Versionamento em memória com rollback points.
 *
 * Mantém um log completo de todas as operações realizadas em cada sessão,
 * permitindo rastrear o que foi feito e, se necessário, gerar diffs para rollback.
 *
 * NOTA: Os commits reais vão para o GitHub via git. Este VFS existe para:
 *  1. Manter contexto completo entre turnos da conversa
 *  2. Gerar rollback points (SHA antes + SHA depois)
 *  3. Rastrear dependências impactadas por cada mudança
 *  4. Prover histórico para o Feedback Loop
 */

export interface VfsFile {
   path: string;
   content: string;
  lastModified: number; // timestamp
  version: number;      // incrementa a cada upsert
}

export type VfsActionType = "create" | "modify" | "delete";

export interface VfsAction {
  id: string;
  type: VfsActionType;
  path: string;
  timestamp: number;
  /** Conteúdo ANTES da mudança (undefined para create) */
  previousContent?: string;
  /** Conteúdo DEPOIS da mudança (undefined para delete) */
  newContent?: string;
  /** SHA do commit antes da operação */
  beforeSha?: string;
  /** SHA do commit depois da operação */
  afterSha?: string;
  /** Instruction que gerou esta mudança */
  instruction?: string;
  /** Arquivos dependentes detectados */
  impactedDependencies?: string[];
}

export interface RollbackPoint {
  sha: string;
  timestamp: number;
  instruction: string;
  actionCount: number;
  changedPaths: string[];
}

export class VirtualFileSystem {
  private files = new Map<string, VfsFile>();
  private actions: VfsAction[] = [];
  private rollbackPoints: RollbackPoint[] = [];
  private versionCounter = 0;

  /**
   * Popula o VFS com um snapshot do repositório (estado inicial).
   */
  loadSnapshot(files: { path: string; content: string }[], headSha: string): void {
    this.files.clear();
    this.versionCounter = 0;
    for (const f of files) {
      this.files.set(f.path, {
        path: f.path,
        content: f.content,
        lastModified: Date.now(),
        version: 0,
      });
    }
    // Register initial rollback point
    this.rollbackPoints.push({
      sha: headSha,
      timestamp: Date.now(),
      instruction: "[snapshot inicial]",
      actionCount: 0,
      changedPaths: [],
    });
  }

  /**
   * Aplica mudanças ao VFS, registrando cada ação com versionamento.
   * Retorna as ações registradas para que o caller possa commitar no GitHub.
   */
  applyChanges(
    changes: { path: string; action?: "upsert" | "delete"; content?: string }[],
    opts?: { instruction?: string; beforeSha?: string; afterSha?: string; impactedDeps?: string[] },
  ): VfsAction[] {
    const newActions: VfsAction[] = [];

    for (const change of changes) {
      const actionType: VfsActionType = change.action === "delete"
        ? "delete"
        : this.files.has(change.path)
          ? "modify"
          : "create";

      const previous = this.files.get(change.path);
      const action: VfsAction = {
        id: `vfs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: actionType,
        path: change.path,
        timestamp: Date.now(),
        previousContent: previous?.content,
        newContent: change.action !== "delete" ? change.content : undefined,
        beforeSha: opts?.beforeSha,
        afterSha: opts?.afterSha,
        instruction: opts?.instruction,
        impactedDependencies: opts?.impactedDeps,
      };

      if (change.action === "delete") {
        this.files.delete(change.path);
      } else if (change.content !== undefined) {
        this.versionCounter++;
        this.files.set(change.path, {
          path: change.path,
          content: change.content,
          lastModified: Date.now(),
          version: this.versionCounter,
        });
      }

      this.actions.push(action);
      newActions.push(action);
    }

    // Register rollback point if we have a SHA
    if (opts?.afterSha) {
      this.rollbackPoints.push({
        sha: opts.afterSha,
        timestamp: Date.now(),
        instruction: opts.instruction ?? "",
        actionCount: newActions.length,
        changedPaths: changes.map((c) => c.path),
      });
    }

    return newActions;
  }

  // ── Queries ──

  getFile(path: string): VfsFile | undefined {
    return this.files.get(path);
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  getAllPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  getFiles(): VfsFile[] {
    return [...this.files.values()];
  }

  /** Retorna todos os arquivos no formato esperado pelo analyzeProjectContext. */
  toFileArray(): { path: string; content: string }[] {
    return this.getFiles().map((f) => ({ path: f.path, content: f.content }));
  }

  // ── History ──

  getActions(): VfsAction[] {
    return [...this.actions];
  }

  /** Retorna apenas as ações da última operação (último rollback point). */
  getLastOperationActions(): VfsAction[] {
    if (this.rollbackPoints.length < 2) return [];
    const lastRp = this.rollbackPoints[this.rollbackPoints.length - 1]!;
    const prevRp = this.rollbackPoints[this.rollbackPoints.length - 2]!;
    return this.actions.filter(
      (a) => a.timestamp >= prevRp.timestamp && a.timestamp <= lastRp.timestamp,
    );
  }

  getRollbackPoints(): RollbackPoint[] {
    return [...this.rollbackPoints];
  }

  getLastRollbackPoint(): RollbackPoint | undefined {
    return this.rollbackPoints[this.rollbackPoints.length - 1];
  }

  getActionCount(): number {
    return this.actions.length;
  }

  /** Gera um resumo textual das mudanças para o prompt de contexto. */
  getContextSummary(): string {
    if (this.actions.length === 0) return "";
    const recent = this.actions.slice(-20); // last 20 actions
    const lines: string[] = ["HISTÓRICO DE MUDANÇAS DA SESSÃO (ações recentes):", ""];
    for (const a of recent) {
      const verb = a.type === "create" ? "Criado" : a.type === "delete" ? "Removido" : "Modificado";
      const sizeInfo = a.newContent
        ? ` (${(a.newContent.length / 1024).toFixed(1)}KB)`
        : "";
      lines.push(`- ${verb}: \`${a.path}\`${sizeInfo}`);
    }
    if (this.actions.length > 20) {
      lines.push(`(e mais ${this.actions.length - 20} ações anteriores)`);
    }
    return lines.join("\n");
  }

  /**
   * Gera diff resumido entre o estado atual e o snapshot inicial.
   * Útil para mostrar ao usuário o que mudou na sessão.
   */
  getSessionDiff(): { created: string[]; modified: string[]; deleted: string[] } {
    const initialPaths = new Set(
      this.rollbackPoints[0]
        ? [] // snapshot paths — we'd need to store them
        : [],
    );
    // Since we don't track initial paths separately, use actions
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const seen = new Set<string>();

    for (const a of this.actions) {
      if (a.type === "create" && !seen.has(a.path)) {
        created.push(a.path);
        seen.add(a.path);
      } else if (a.type === "delete") {
        deleted.push(a.path);
        seen.delete(a.path);
      } else if (a.type === "modify") {
        if (!seen.has(a.path)) {
          modified.push(a.path);
          seen.add(a.path);
        }
      }
    }

    return { created, modified, deleted };
  }
}

/**
 * Gerenciador de instâncias VFS por sessão (owner/repo).
 * Cada par owner/repo tem seu próprio VFS com contexto isolado.
 */
const _vfsInstances = new Map<string, VirtualFileSystem>();

export function getVfs(owner: string, repo: string): VirtualFileSystem {
  const key = `${owner}/${repo}`;
  let vfs = _vfsInstances.get(key);
  if (!vfs) {
    vfs = new VirtualFileSystem();
    _vfsInstances.set(key, vfs);
  }
  return vfs;
}

export function destroyVfs(owner: string, repo: string): void {
  _vfsInstances.delete(`${owner}/${repo}`);
}

export function resetVfs(owner: string, repo: string): void {
  const vfs = new VirtualFileSystem();
  _vfsInstances.set(`${owner}/${repo}`, vfs);
}
