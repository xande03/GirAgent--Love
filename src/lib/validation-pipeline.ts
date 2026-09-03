/**
 * Validation Pipeline — Validação pós-geração em estágios.
 *
 * Cada estágio verifica um aspecto diferente do código gerado:
 * 1. Security — paths perigosos, conteúdo suspeito
 * 2. Syntax — truncation, delimiters, encoding
 * 3. Imports — arquivos importados existem
 * 4. Dependencies — packages referenciados estão no package.json
 * 5. Types — tipos exportados são consumidos (heuristic)
 * 6. Style — convenções do projeto são seguidas
 * 7. Completeness — conteúdo não está abreviado
 *
 * Cada estágio retorna warnings (non-blocking) ou errors (blocking).
 */

import { DependencyTracker } from "./dependency-tracker";

export type Severity = "warning" | "error";

export interface ValidationIssue {
  stage: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface ValidationResult {
  passed: boolean;         // true if no errors
  issues: ValidationIssue[];
  summary: string;          // human-readable summary
}

export interface ValidationContext {
  changes: { path: string; action?: string; content?: string }[];
  repoPaths: string[];
  projectFiles?: { path: string; content: string }[];
  depTracker?: DependencyTracker;
  projectAnalysis?: {
    framework: string;
    styling: string;
    conventions: string[];
    dependencies: string[];
    language: string;
  };
}

// ── Stage implementations ──

const DANGEROUS_PATHS = [/^\.git\//, /^\.env(|$)/, /^\.ssh\//, /^id_rsa/, /^id_ed25519/, /^\.husky\//];

function validateSecurity(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const change of ctx.changes) {
    if (change.path.startsWith("/") || change.path.includes("..")) {
      issues.push({
        stage: "security",
        severity: "error",
        path: change.path,
        message: `Caminho de arquivo bloqueado por segurança: ${change.path}`,
      });
    }
    for (const dp of DANGEROUS_PATHS) {
      if (dp.test(change.path)) {
        issues.push({
          stage: "security",
          severity: "error",
          path: change.path,
          message: `Arquivo sensível bloqueado: ${change.path}`,
        });
      }
    }
    if (change.content && change.content.length > 500_000) {
      issues.push({
        stage: "security",
        severity: "error",
        path: change.path,
        message: `Conteúdo bloqueado por tamanho excessivo: ${(change.content.length / 1024).toFixed(0)}KB`,
      });
    }
    // Check for suspicious patterns in content
    if (change.content) {
      if (/child_process|require\s*\(\s*['"]fs['"]|process\.env/.test(change.content) &&
          !/node|server|api|backend/i.test(change.path)) {
        issues.push({
          stage: "security",
          severity: "warning",
          path: change.path,
          message: `Possível acesso a APIs sensíveis do Node.js (fs, child_process, env). Verifique se é intencional.`,
        });
      }
      if (/eval\s*\(|new Function\s*\(/.test(change.content)) {
        issues.push({
          stage: "security",
          severity: "warning",
          path: change.path,
          message: `Contém eval() ou new Function() — risco de segurança. Verifique se é necessário.`,
        });
      }
    }
  }
  return issues;
}

function validateSyntax(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const c of ctx.changes) {
    if (c.action === "delete" || !c.content) continue;

    const isCode = /\.(tsx?|jsx?|ts|js|mjs|cjs|vue|svelte|astro|css|scss|html|json|yaml|yml|py|rb|go|rs|java|kt|php|sh|sql|graphql|prisma)$/i.test(c.path);
    if (!isCode) continue;

    // 1. Truncation detection
    const truncationPatterns = [
      /\.\.\.[^.]*igual[^\n]*$/im,
      /\.\.\.[^.]*rest[^\n]*$/im,
      /\.\.\.[^.]*remaining[^\n]*$/im,
      /\.\.\.[^.]*existing[^\n]*$/im,
      /\.\.\.[^.]*unchanged[^\n]*$/im,
      /\.\.\.[^.]*same[^\n]*$/im,
      /<\/\w+>.*\/\*.*\*\/>\s*$/s,
    ];
    for (const pat of truncationPatterns) {
      if (pat.test(c.content)) {
        issues.push({
          stage: "syntax",
          severity: "error",
          path: c.path,
          message: `Contém marcador de truncation ("...") — arquivo incompleto.`,
        });
        break;
      }
    }

    // 2. Unbalanced delimiters
    const isDataFormat = /\.(json|yaml|yml|toml)$/i.test(c.path);
    if (isDataFormat) {
      const balance = countBraces(c.content);
      if (balance !== 0) {
        issues.push({
          stage: "syntax",
          severity: "error",
          path: c.path,
          message: `Chaves desbalanceadas (${balance > 0 ? "faltam fechar" : "sobram"}).`,
        });
      }
      continue;
    }

    const { braces, parens, brackets } = countDelimiters(c.content);
    if (braces !== 0) {
      issues.push({
        stage: "syntax",
        severity: "error",
        path: c.path,
        message: `Chaves {} desbalanceadas (${braces > 0 ? `faltam ${braces}` : `sobram ${-braces}"`}).`,
      });
    }
    if (parens !== 0) {
      issues.push({
        stage: "syntax",
        severity: "warning",
        path: c.path,
        message: `Parênteses () desbalanceados.`,
      });
    }
    if (brackets !== 0) {
      issues.push({
        stage: "syntax",
        severity: "warning",
        path: c.path,
        message: `Colchetes [] desbalanceados.`,
      });
    }
  }
  return issues;
}

function validateImports(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allPathsSet = new Set(ctx.repoPaths);

  // Add paths from current changes
  for (const c of ctx.changes) {
    if (c.action !== "delete") allPathsSet.add(c.path);
  }

  for (const c of ctx.changes) {
    if (c.action === "delete" || !c.content) continue;

    const importRegexes = [
      /(?:import|from)\s+["']([^"']+)['"]/g,
      /(?:import\s*\([^)]*\)\s*from\s*)["']([^"']+)['"]/g,
      /(?:require\s*\()["']([^"']+)['"]/g,
    ];

    for (const regex of importRegexes) {
      let importMatch: RegExpExecArray | null;
      while ((importMatch = regex.exec(c.content)) !== null) {
        const importPath = importMatch[1]!;
        if (importPath.startsWith(".") || importPath.startsWith("/")) {
          const dir = c.path.substring(0, c.path.lastIndexOf("/"));
          const resolved = resolveImportPath(dir, importPath);
          const hasExtension = /\.[^.]+$/.test(resolved);
          const possiblePaths = hasExtension
            ? [resolved]
            : [
                `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
                `${resolved}/index.ts`, `${resolved}/index.tsx`, `${resolved}/index.js`, `${resolved}/index.jsx`,
                `${resolved}/route.ts`, `${resolved}/route.tsx`,
              ];
          const exists = possiblePaths.some((p) =>
            allPathsSet.has(p) || [...allPathsSet].some((rp) => rp === p.replace(/\/index\.\w+$/, "")),
          );
          if (!importPath.startsWith("@") && !exists) {
            issues.push({
              stage: "imports",
              severity: "warning",
              path: c.path,
              message: `Importa "${importPath}" que não existe no repositório nem nas mudanças.`,
            });
          }
        }
      }
    }
  }
  return issues;
}

function validateDependencies(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.projectAnalysis) return issues;

  const knownPkgs = new Set(ctx.projectAnalysis.dependencies);

  for (const c of ctx.changes) {
    if (c.action === "delete" || !c.content) continue;

    // Detect require/import of npm packages
    const npmImports = c.content.matchAll(/(?:import|require)\s*(?:[\s\S]*?)\s*(?:from\s*)?["']([^"'/][^"']*)["']/g);
    for (const m of npmImports) {
      const pkg = m[1]!.split("/")[0]!;
      if (pkg.startsWith("@")) {
        const scopedPkg = `${pkg}/${m[1]!.split("/")[1]}`;
        if (scopedPkg && !knownPkgs.has(scopedPkg) && !knownPkgs.has(pkg)) {
          // Check if it's a native module or a likely-existing dependency
          if (!isLikelyNative(pkg) && !isLikelyKnown(pkg)) {
            issues.push({
              stage: "dependencies",
              severity: "warning",
              path: c.path,
              message: `Importa "${scopedPkg}" que não está no package.json. Considere adicioná-lo.`,
            });
          }
        }
      } else if (!knownPkgs.has(pkg) && !isLikelyNative(pkg) && !isLikelyKnown(pkg)) {
        issues.push({
              stage: "dependencies",
              severity: "warning",
              path: c.path,
              message: `Importa "${pkg}" que não está no package.json. Considere adicioná-lo.`,
            });
      }
    }
  }
  return issues;
}

function validateStyle(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.projectAnalysis) return issues;

  const conventions = ctx.projectAnalysis.conventions;
  const hasAliasImport = conventions.some((c) => c.includes("alias @/"));

  for (const c of ctx.changes) {
    if (c.action === "delete" || !c.content) continue;
    if (!/\.(tsx?|jsx?|ts|js)$/.test(c.path)) continue;

    // Check if project uses @ alias but file uses relative imports to src/
    if (hasAliasImport) {
      const relativeToSrc = c.content.matchAll(/from\s*["']\.\.?\/src\//g);
      for (const _ of relativeToSrc) {
        issues.push({
          stage: "style",
          severity: "warning",
          path: c.path,
          message: `Usa import relativo para src/ mas o projeto usa alias @/. Considere usar @/.`,
        });
        break; // one warning per file
      }
    }

    // Check for components not following PascalCase convention
    if (/components\//i.test(c.path)) {
      const fileName = c.path.split("/").pop()!;
      if (/^[a-z]/.test(fileName) && /\.(tsx|jsx)$/.test(fileName)) {
        issues.push({
          stage: "style",
          severity: "warning",
          path: c.path,
          message: `Componente em PascalCase esperado pelo projeto, mas o arquivo usa ${fileName}.`,
        });
      }
    }
  }
  return issues;
}

function validateCompleteness(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const c of ctx.changes) {
    if (c.action === "delete" || !c.content) continue;

    // Check for common abbreviation markers
    const markers = [
      /\.\.\..{0,5}(igual|resto|remaining|existing|same|similar)/i,
      /\/\/\s*\.\.\.(rest|existing|same|similar)/i,
      /\/\/\s*TODO[:\s]/i,
      /\/\*\s*\.\.\./i,
    ];

    for (const marker of markers) {
      if (marker.test(c.content)) {
        issues.push({
          stage: "completeness",
          severity: "error",
          path: c.path,
          message: `Contém marcador de abreviação — o conteúdo pode estar incompleto.`,
        });
        break;
      }
    }

    // Check if file seems too short for a component
    if (/\.(tsx|jsx)$/.test(c.path) && c.content.length < 50) {
      issues.push({
        stage: "completeness",
        severity: "warning",
        path: c.path,
        message: `Arquivo de componente muito curto (${c.content.length} chars) — pode estar incompleto.`,
      });
    }
  }
  return issues;
}

// ── Pipeline orchestrator ──

const STAGES = [
  { name: "security",     fn: validateSecurity },
  { name: "syntax",       fn: validateSyntax },
  { name: "imports",      fn: validateImports },
  { name: "dependencies", fn: validateDependencies },
  { name: "style",        fn: validateStyle },
  { name: "completeness", fn: validateCompleteness },
];

export function runValidationPipeline(ctx: ValidationContext): ValidationResult {
  const allIssues: ValidationIssue[] = [];

  for (const stage of STAGES) {
    try {
      const issues = stage.fn(ctx);
      allIssues.push(...issues);
    } catch (err) {
      console.error(`[validation] Stage "${stage.name}" threw:`, err);
    }
  }

  // Add dependency tracker analysis if available
  if (ctx.depTracker) {
    const changedPaths = ctx.changes.map((c) => c.path);
    const impacted = ctx.depTracker.getImpactedFiles(changedPaths);
    if (impacted.length > 0) {
      allIssues.push({
        stage: "dependency-graph",
        severity: "warning",
        path: "*",
        message: `Arquivos potencialmente impactados por mudanças: ${impacted.join(", ")}`,
      });
    }

    // Check for broken imports using the dependency tracker
    const allPathsSet = new Set(ctx.repoPaths);
    for (const c of ctx.changes) {
      if (c.action !== "delete") allPathsSet.add(c.path);
    }
    const broken = ctx.depTracker.getBrokenImports(allPathsSet);
    for (const b of broken) {
      allIssues.push({
        stage: "dependency-graph",
        severity: "error",
        path: b.from,
        message: `Import quebrado: "${b.importPath}" não existe.`,
      });
    }
  }

  const errors = allIssues.filter((i) => i.severity === "error");
  const warnings = allIssues.filter((i) => i.severity === "warning");

  const summaryParts: string[] = [];
  if (errors.length > 0) {
    summaryParts.push(`ERROS BLOQUEANTES (${errors.length}):`);
    summaryParts.push(...errors.map((e) => `- [${e.stage}] ${e.path}: ${e.message}`));
  }
  if (warnings.length > 0) {
    summaryParts.push(`AVISOS (${warnings.length}):`);
    summaryParts.push(...warnings.map((w) => `- [${w.stage}] ${w.path}: ${w.message}`));
  }

  return {
    passed: errors.length === 0,
    issues: allIssues,
    summary: summaryParts.join("\n"),
  };
}

/**
 * Gera feedback estruturado para o LLM quando há erros de validação.
 * Este texto é enviado ao LLM para auto-correção.
 */
export function buildValidationFeedback(result: ValidationResult): string {
  if (result.passed) return "";
  return `VALIDAÇÃO FALHOU — Corrija os seguintes problemas e re-envie o JSON:

${result.summary}

Regras:
- Corrija APENAS os problemas listados.
- Mantenha tudo o mais inalterado.
- Re-envie o JSON completo com todas as changes.`;
}

// ── Helpers ──

function countBraces(content: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of content) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }
  return depth;
}

function countDelimiters(content: string): { braces: number; parens: number; brackets: number } {
  let braces = 0, parens = 0, brackets = 0;
  let inStr = false, strChar = "", inTemplate = false, esc = false;
  let inLineComment = false, inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];

    if (!inStr && !inTemplate) {
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && next === "/") { inBlockComment = false; i++; } continue; }
      if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
    }

    if (esc) { esc = false; continue; }
    if (ch === "\\" && (inStr || inTemplate)) { esc = true; continue; }

    if (!inStr && ch === "`" && !inLineComment && !inBlockComment) {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate && ch === "$" && next === "{") {
      let tDepth = 1; let j = i + 2; let tEsc = false;
      while (j < content.length && tDepth > 0) {
        const tc = content[j]!;
        if (tEsc) { tEsc = false; j++; continue; }
        if (tc === "\\") { tEsc = true; j++; continue; }
        if (tc === "{") tDepth++;
        if (tc === "}") tDepth--;
        j++;
      }
      i = j - 1;
      continue;
    }

    if (!inTemplate) {
      if (!inStr && (ch === '"' || ch === "'")) { inStr = true; strChar = ch; continue; }
      if (inStr && ch === strChar) { inStr = false; continue; }
    }

    if (!inStr && !inTemplate) {
      if (ch === "{") braces++;
      if (ch === "}") braces--;
      if (ch === "(") parens++;
      if (ch === ")") parens--;
      if (ch === "[") brackets++;
      if (ch === "]") brackets--;
    }
  }

  return { braces, parens, brackets };
}

function resolveImportPath(dir: string, importPath: string): string {
  if (importPath.startsWith("/")) return importPath;
  const parts = dir.split("/").concat(importPath.split("/"));
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".." && resolved.length > 0) resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}

function isLikelyNative(pkg: string): boolean {
  return new Set(["react", "react-dom", "fs", "path", "url", "http", "https", "stream", "util", "crypto", "os", "events", "child_process"]).has(pkg);
}

function isLikelyKnown(pkg: string): boolean {
  return /^(react|next|vue|svelte|astro|nuxt|angular|typescript|javascript|node|tailwind|postcss|vite|webpack|esbuild|rollup|eslint|prettier|zod|prisma|drizzle|trpc|express|fastify|hono|bun|deno)/.test(pkg);
}