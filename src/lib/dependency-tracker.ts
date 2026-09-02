/**
 * Dependency Tracker — Rastreia dependências entre arquivos.
 *
 * Analisa imports/exports para construir um grafo de dependências.
 * Usado para:
 *  1. Detectar quais arquivos são impactados por uma mudança
 *  2. Validação de import consistency (imports quebrados)
 *  3. Fornecer ao LLM a lista de arquivos que precisam atualização
 */

export interface DepNode {
  path: string;
  imports: string[];       // paths que este arquivo importa
  importedBy: string[];    // paths que importam este arquivo
  exports: string[];       // nomes exportados
  reExports: string[];     // re-exports (export { X } from './y')
}

export class DependencyTracker {
  private graph = new Map<string, DepNode>();

  /**
   * Constrói o grafo de dependências a partir da lista de arquivos.
   * Deve ser chamado após cada mudança para manter o grafo atualizado.
   */
  buildGraph(files: { path: string; content: string }[]): void {
    this.graph.clear();

    // First pass: extract all exports
    for (const f of files) {
      const node = this.getOrCreate(f.path);
      node.exports = this.extractExports(f.content, f.path);
      node.reExports = this.extractReExports(f.content);
    }

    // Second pass: extract imports and build edges
    for (const f of files) {
      const imports = this.extractImports(f.content, f.path);
      const node = this.getOrCreate(f.path);
      node.imports = imports;

      // Register reverse dependency
      for (const imp of imports) {
        const target = this.getOrCreate(imp);
        if (!target.importedBy.includes(f.path)) {
          target.importedBy.push(f.path);
        }
      }
    }
  }

  /**
   * Atualiza o grafo incrementalmente (sem reconstruir tudo).
   * Remove arestas antigas do path e re-analiza.
   */
  updateFile(path: string, content: string, allPaths: string[]): void {
    const oldNode = this.graph.get(path);

    // Remove old reverse dependencies
    if (oldNode) {
      for (const imp of oldNode.imports) {
        const target = this.graph.get(imp);
        if (target) {
          target.importedBy = target.importedBy.filter((p) => p !== path);
        }
      }
    }

    // Re-analyze the file
    const node = this.getOrCreate(path);
    node.exports = this.extractExports(content, path);
    node.reExports = this.extractReExports(content);
    node.imports = this.extractImports(content, path);

    // Re-add reverse dependencies
    for (const imp of node.imports) {
      const target = this.getOrCreate(imp);
      if (!target.importedBy.includes(path)) {
        target.importedBy.push(path);
      }
    }
  }

  /**
   * Remove um arquivo do grafo (deletado).
   */
  removeFile(path: string): void {
    const node = this.graph.get(path);
    if (node) {
      // Remove from importers' import lists
      for (const imp of node.imports) {
        const target = this.graph.get(imp);
        if (target) {
          target.importedBy = target.importedBy.filter((p) => p !== path);
        }
      }
      // Remove reverse deps
      for (const importer of node.importedBy) {
        const impNode = this.graph.get(importer);
        if (impNode) {
          impNode.imports = impNode.imports.filter((p) => p !== path);
        }
      }
      this.graph.delete(path);
    }
  }

  /**
   * Retorna todos os arquivos que IMPORTAM o path dado.
   * Se o path for modificado, esses arquivos podem quebrar.
   */
  getDependents(path: string): string[] {
    const node = this.graph.get(path);
    return node?.importedBy ?? [];
  }

  /**
   * Retorna TODOS os arquivos impactados transitivamente.
   * Se A importa B e B importa C, modificar C afeta B e A.
   */
  getTransitiveDependents(path: string): string[] {
    const visited = new Set<string>();
    const queue = [path];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this.graph.get(current);
      if (node) {
        for (const dep of node.importedBy) {
          if (!visited.has(dep)) queue.push(dep);
        }
      }
    }
    visited.delete(path); // remove self
    return [...visited];
  }

  /**
   * Para uma lista de mudanças, retorna quais arquivos fora da lista
   * podem ser impactados (imports quebrados, tipos removidos, etc.)
   */
  getImpactedFiles(changedPaths: string[]): string[] {
    const impacted = new Set<string>();
    for (const path of changedPaths) {
      for (const dep of this.getTransitiveDependents(path)) {
        if (!changedPaths.includes(dep)) {
          impacted.add(dep);
        }
      }
    }
    return [...impacted];
  }

  /**
   * Verifica se há imports quebrados (importando path que não existe).
   */
  getBrokenImports(allPaths: Set<string>): { from: string; importPath: string }[] {
    const broken: { from: string; importPath: string }[] = [];
    for (const [path, node] of this.graph) {
      for (const imp of node.imports) {
        if (!allPaths.has(imp) && !this.graph.has(imp)) {
          broken.push({ from: path, importPath: imp });
        }
      }
    }
    return broken;
  }

  /**
   * Gera resumo textual do dependency graph para o prompt.
   */
  getDependencySummary(changedPaths?: string[]): string {
    if (changedPaths && changedPaths.length > 0) {
      const impacted = this.getImpactedFiles(changedPaths);
      if (impacted.length > 0) {
        return `DEPENDÊNCIAS IMPACTADAS (arquivos que importam algo que foi mudado e podem precisar de atualização):
${impacted.map((p) => `- ${p}`).join("\n")}`;
      }
    }
    return "";
  }

  getNode(path: string): DepNode | undefined {
    return this.graph.get(path);
  }

  getAllNodes(): DepNode[] {
    return [...this.graph.values()];
  }

  // ── Private helpers ──

  private getOrCreate(path: string): DepNode {
    let node = this.graph.get(path);
    if (!node) {
      node = { path, imports: [], importedBy: [], exports: [], reExports: [] };
      this.graph.set(path, node);
    }
    return node;
  }

  private extractImports(content: string, filePath: string): string[] {
    const imports: string[] = [];
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));

    const patterns = [
      // import X from './path'  |  import { X } from './path'
      /import\s+(?:[^;]*?)\s+from\s+["']([^"']+)["']/g,
      // import './path' (side-effect)
      /import\s+["']([^"']+)["']/g,
      // require('./path')
      /require\s*\(\s*["']([^"']+)["']\s*\)/g,
      // dynamic import()
      /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const raw = match[1]!;
        if (raw.startsWith(".") || raw.startsWith("/")) {
          const resolved = this.resolvePath(dir, raw);
          if (!imports.includes(resolved)) imports.push(resolved);
        }
      }
    }

    return imports;
  }

  private extractExports(content: string, filePath: string): string[] {
    const exports: string[] = [];

    // export function X
    // export const X
    // export class X
    let m: RegExpExecArray | null;
    const namedExport = /export\s+(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/g;
    while ((m = namedExport.exec(content)) !== null) {
      if (!exports.includes(m[1]!)) exports.push(m[1]!);
    }

    // export default function X  |  export default class X
    const defaultExport = /export\s+default\s+(?:function|class)\s+(\w+)/g;
    while ((m = defaultExport.exec(content)) !== null) {
      if (!exports.includes(m[1]!)) exports.push(m[1]!);
    }

    // export { X, Y }  (but not re-exports with 'from')
    const braceExport = /export\s*\{([^}]+)\}(?!\s*from)/g;
    while ((m = braceExport.exec(content)) !== null) {
      const names = m[1]!.split(",").map((s) => s.trim().replace(/\s+as\s+\w+$/, ""));
      for (const name of names) {
        if (name && !exports.includes(name)) exports.push(name);
      }
    }

    return exports;
  }

  private extractReExports(content: string): string[] {
    const reExports: string[] = [];
    const pattern = /export\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      if (!reExports.includes(m[1]!)) reExports.push(m[1]!);
    }
    return reExports;
  }

  private resolvePath(dir: string, importPath: string): string {
    if (importPath.startsWith("/")) return importPath;
    const parts = dir.split("/").concat(importPath.split("/"));
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === ".." && resolved.length > 0) resolved.pop();
      else if (part !== "." && part !== "") resolved.push(part);
    }
    return resolved.join("/");
  }
}

/**
 * Component Registry — Catálogo de componentes disponíveis no projeto.
 *
 * Construído a partir da análise do projeto, fornece ao LLM
 * informações ricas sobre componentes reutilizáveis.
 */
export interface ComponentEntry {
  path: string;
  name: string;
  isDefault: boolean;
  props?: string[];        // nomes de props detectados (heurística)
  hasChildren: boolean;    // se usa children
  description?: string;   // extraído do JSDoc ou primeira linha
  category: string;        // ui, layout, form, data, etc.
}

export class ComponentRegistry {
  private components = new Map<string, ComponentEntry[]>();

  /**
   * Escaneia os arquivos do projeto e registra componentes.
   */
  build(files: { path: string; content: string }[]): void {
    this.components.clear();
    for (const f of files) {
      if (!/\.(tsx|jsx)$/i.test(f.path)) continue;
      if (!/(components|widgets|ui|layouts|partials)/i.test(f.path)) continue;

      const entries = this.extractComponents(f);
      for (const entry of entries) {
        const existing = this.components.get(entry.name) ?? [];
        existing.push(entry);
        this.components.set(entry.name, existing);
      }
    }
  }

  /**
   * Busca componentes por nome (fuzzy match).
   */
  search(query: string): ComponentEntry[] {
    const q = query.toLowerCase();
    const results: ComponentEntry[] = [];
    for (const [, entries] of this.components) {
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(q)) {
          results.push(entry);
        }
      }
    }
    return results;
  }

  /**
   * Retorna todos os componentes categorizados.
   */
  getAll(): ComponentEntry[] {
    const all: ComponentEntry[] = [];
    for (const [, entries] of this.components) {
      all.push(...entries);
    }
    return all;
  }

  /**
   * Gera resumo textual para o prompt do sistema.
   */
  getPromptSummary(): string {
    const all = this.getAll();
    if (all.length === 0) return "";
    const lines: string[] = [
      "REGISTRO DE COMPONENTES (reutilize ANTES de criar novos):",
      "",
    ];
    for (const c of all) {
      const propsStr = c.props?.length ? ` → props: ${c.props.join(", ")}` : "";
      const childrenStr = c.hasChildren ? " [aceita children]" : "";
      const descStr = c.description ? ` — ${c.description}` : "";
      lines.push(`- <${c.name}> (${c.path})${propsStr}${childrenStr}${descStr}`);
    }
    return lines.join("\n");
  }

  private extractComponents(file: { path: string; content: string }): ComponentEntry[] {
    const entries: ComponentEntry[] = [];
    const category = this.categorize(file.path);
    const description = this.extractDescription(file.content);

    // Named function exports: export function Button(...)  or  export const Button = () =>
    const namedFunc = /export\s+function\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = namedFunc.exec(file.content)) !== null) {
      const name = m[1]!;
      entries.push({
        path: file.path,
        name,
        isDefault: false,
        props: this.extractProps(file.content, name),
        hasChildren: this.hasChildrenProp(file.content, name),
        description,
        category,
      });
    }

    // Named const exports: export const Button = () =>  or  export const Button = function()
    const namedConst = /export\s+(?:const|let)\s+(\w+)\s*=\s*(?:\(([^)]*)\)|function)/g;
    while ((m = namedConst.exec(file.content)) !== null) {
      const name = m[1]!;
      if (entries.some((e) => e.name === name)) continue;
      entries.push({
        path: file.path,
        name,
        isDefault: false,
        props: this.extractProps(file.content, name),
        hasChildren: this.hasChildrenProp(file.content, name),
        description,
        category,
      });
    }

    // Default exports: export default function X  |  export default X
    const defaultFunc = /export\s+default\s+function\s+(\w+)/g;
    while ((m = defaultFunc.exec(file.content)) !== null) {
      const name = m[1]!;
      entries.push({
        path: file.path,
        name,
        isDefault: true,
        props: this.extractProps(file.content, name),
        hasChildren: this.hasChildrenProp(file.content, name),
        description,
        category,
      });
    }

    return entries;
  }

  private categorize(path: string): string {
    if (/ui\//i.test(path)) return "ui";
    if (/form/i.test(path)) return "form";
    if (/layout/i.test(path)) return "layout";
    if (/data|table|chart/i.test(path)) return "data";
    if (/nav|header|footer|sidebar|menu/i.test(path)) return "navigation";
    if (/modal|dialog|sheet|drawer/i.test(path)) return "overlay";
    return "component";
  }

  private extractDescription(content: string): string {
    // Try JSDoc
    const jsdoc = content.match(/\/\*\*([^*]|(\*(?!\/)))*\*\/\s*(?:export\s+)?/);
    if (jsdoc) {
      const text = jsdoc[0]!.replace(/\/\*\*|\*\/|\*/g, "").trim();
      if (text.length > 5 && text.length < 200) return text;
    }
    return "";
  }

  private extractProps(content: string, componentName: string): string[] {
    // Find the function/component body and look for destructured props
    const funcMatch = new RegExp(
      `(?:function\s+${componentName}|(?:const|let|var)\s+${componentName}\s*=\s*(?:\([^)]*\)\s*=>|function\s*\([^)]*\)))` +
      `[\\s\\S]*?\\{\\s*([^}]+)\\s*\\}`,
      "m"
    );
    const match = content.match(funcMatch);
    if (!match) return [];
    return match[1]!
      .split(",")
      .map((p) => p.trim().split(":")[0]!.split("=")[0]!.trim())
      .filter((p) => p && !p.startsWith("..."));
  }

  private hasChildrenProp(content: string, componentName: string): boolean {
    const funcBody = new RegExp(
      `${componentName}[\\s\\S]*?\\{[\\s\\S]*?return[\\s\\S]`,
      "m"
    );
    const match = content.match(funcBody);
    if (!match) return false;
    return /children|Children|props\.children/.test(match[0]!);
  }
}
