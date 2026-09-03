export type ImageIntent = "add-to-project" | "reference-only";

/* ═══════════════════════════════════════════════════════════════════
   PROJECT CONTEXT ANALYSIS — Auto-detect stack, patterns, conventions
   ═══════════════════════════════════════════════════════════════════ */

export interface ProjectAnalysis {
  framework: string;
  buildTool: string;
  styling: string;
  routing: string;
  stateManagement: string;
  language: string;
  dependencies: string[];
  devDependencies: string[];
  components: { path: string; exports: string[] }[];
  conventions: string[];
  entryPoints: string[];
}

/**
 * Analyzes the repo snapshot to auto-detect project stack, patterns, and conventions.
 * This context is injected into the system prompt so the LLM always works
 * with accurate, up-to-date project knowledge.
 */
export function analyzeProjectContext(files: { path: string; content: string }[]): ProjectAnalysis {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const get = (p: string) => byPath.get(p) ?? "";

  // ── Parse package.json ──
  let pkgDeps: string[] = [];
  let pkgDevDeps: string[] = [];
  let pkgScripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(get("package.json"));
    pkgDeps = Object.keys(pkg.dependencies ?? {});
    pkgDevDeps = Object.keys(pkg.devDependencies ?? {});
    pkgScripts = pkg.scripts ?? {};
  } catch {}
  const allDeps = [...pkgDeps, ...pkgDevDeps];

  // ── Framework detection ──
  let framework = "Desconhecido";
  let buildTool = "Desconhecido";
  let styling = "CSS padrão";
  let routing = "Sem roteamento detectado";
  let stateManagement = "useState/useRef locais";
  let language = "JavaScript";

  if (allDeps.some((d) => /react/.test(d))) {
    framework = "React";
    language = "TypeScript";
    if (allDeps.includes("@tanstack/react-start")) {
      framework += " + TanStack Start (SSR via Nitro)";
      buildTool = "Vite + TanStack Start";
      routing = "TanStack Router (file-based em src/routes/)";
    } else if (allDeps.includes("next")) {
      framework += " + Next.js";
      buildTool = "Turbopack/Webpack";
      routing = allDeps.includes("next") ? "Next.js App Router (app/)" : "Next.js Pages Router (pages/)";
    } else if (allDeps.includes("@remix-run/react")) {
      framework += " + Remix";
      buildTool = "Remix (Vite)";
      routing = "Remix file-based routing";
    } else if (allDeps.includes("astro")) {
      framework += " + Astro";
      buildTool = "Astro (Vite)";
      routing = "Astro file-based routing";
    } else {
      buildTool = allDeps.includes("vite") ? "Vite" : "Webpack/Outro";
      routing = allDeps.includes("@tanstack/react-router") ? "TanStack Router" : "Sem roteamento detectado";
    }
  } else if (allDeps.some((d) => /vue/.test(d))) {
    framework = "Vue";
    language = "TypeScript";
    if (allDeps.includes("nuxt")) {
      framework += " + Nuxt";
      buildTool = "Nuxt (Vite)";
      routing = "Nuxt file-based routing (pages/)";
    } else {
      buildTool = allDeps.includes("vite") ? "Vite" : "Vue CLI";
      routing = allDeps.includes("vue-router") ? "Vue Router" : "Sem roteamento";
    }
  } else if (allDeps.some((d) => /svelte|kit/.test(d))) {
    framework = "Svelte" + (allDeps.includes("@sveltejs/kit") ? " + SvelteKit" : "");
    buildTool = "Vite + SvelteKit";
    routing = "SvelteKit file-based routing";
    language = "TypeScript";
  } else if (allDeps.some((d) => /next/.test(d))) {
    framework = "Next.js";
    buildTool = "Turbopack/Webpack";
    routing = "App Router (app/)";
    language = "TypeScript";
  }

  // Check for TS config
  if (byPath.has("tsconfig.json")) language = "TypeScript";

  // ── Styling detection ──
  if (allDeps.includes("tailwindcss") || byPath.has("tailwind.config.ts") || byPath.has("tailwind.config.js")) {
    const twContent = get("src/app.css") || get("src/index.css") || get("src/styles.css") || "";
    if (twContent.includes("@import") && twContent.includes("tailwindcss")) {
      styling = "Tailwind CSS v4 (utility-first, @import)";
    } else {
      styling = "Tailwind CSS (utility-first)";
    }
  } else if (allDeps.includes("styled-components") || allDeps.some((d) => /@emotion/.test(d))) {
    styling = "CSS-in-JS (styled-components/Emotion)";
  } else if (allDeps.includes("@stitches/react") || allDeps.includes("panda-css")) {
    styling = "CSS-in-JS (Stitches/Panda)";
  } else if (files.some((f) => f.path.endsWith(".module.css") || f.path.endsWith(".module.scss"))) {
    styling = "CSS Modules";
  }

  // ── State management detection ──
  if (allDeps.includes("zustand")) stateManagement = "Zustand";
  else if (allDeps.includes("@tanstack/react-query") || allDeps.includes("@tanstack/react-query")) stateManagement = "TanStack Query (server state) + useState (local)";
  else if (allDeps.includes("jotai")) stateManagement = "Jotai";
  else if (allDeps.includes("redux") || allDeps.includes("@reduxjs/toolkit")) stateManagement = "Redux Toolkit";
  else if (allDeps.includes("mobx")) stateManagement = "MobX";

  // ── Entry points ──
  const entryPoints: string[] = [];
  if (byPath.has("src/routes/index.tsx")) entryPoints.push("src/routes/index.tsx (página principal)");
  else if (byPath.has("src/app/page.tsx")) entryPoints.push("src/app/page.tsx (página principal)");
  else if (byPath.has("src/pages/index.tsx")) entryPoints.push("src/pages/index.tsx (página principal)");
  else if (byPath.has("src/main.tsx")) entryPoints.push("src/main.tsx (entry SSR)");
  else if (byPath.has("src/index.tsx")) entryPoints.push("src/index.tsx (entry)");
  if (byPath.has("src/start.ts")) entryPoints.push("src/start.ts (configuração do servidor TanStack Start)");
  if (byPath.has("src/app.tsx")) entryPoints.push("src/app.tsx (layout raiz)");
  if (byPath.has("src/app/layout.tsx")) entryPoints.push("src/app/layout.tsx (layout raiz)");

  // ── Component detection ──
  const components: { path: string; exports: string[] }[] = [];
  const compFiles = files.filter((f) =>
    /\.(tsx|jsx)$/.test(f.path) &&
    /(components|widgets|ui|layouts|partials)/i.test(f.path),
  );
  for (const f of compFiles) {
    const exports: string[] = [];
    // Extract named exports
    const namedExports = f.content.matchAll(/export\s+(?:function|const|class)\s+(\w+)/g);
    for (const m of namedExports) exports.push(m[1]!);
    // Extract default export
    if (/export\s+default\s+function\s+(\w+)/.test(f.content)) {
      const dm = f.content.match(/export\s+default\s+function\s+(\w+)/);
      if (dm) exports.push(dm[1]! + " (default)");
    }
    if (/export\s+default\s+/.test(f.content) && !/export\s+default\s+function/.test(f.content)) {
      exports.push("default (componente anônimo)");
    }
    components.push({ path: f.path, exports });
  }

  // ── Convention detection ──
  const conventions: string[] = [];
  // Check naming patterns
  const hasPascalCase = files.some((f) => /\/[A-Z][a-z]+[A-Z]/.test(f.path));
  const hasKebabCase = files.some((f) => /[a-z]+-[a-z]+/.test(f.path));
  const hasSnakeCase = files.some((f) => /[a-z]+_[a-z]+/.test(f.path));
  if (hasPascalCase) conventions.push("Componentes/arquivos: PascalCase");
  else if (hasKebabCase) conventions.push("Arquivos: kebab-case");
  else if (hasSnakeCase) conventions.push("Arquivos: snake_case");

  // Check import alias
  if (files.some((f) => /from\s+["']@(?!types)/.test(f.content))) {
    conventions.push("Imports: alias @/ para src/");
  }

  // Check for specific patterns
  if (files.some((f) => f.content.includes("useServerFn"))) conventions.push("Server functions: useServerFn (TanStack Start)");
  if (files.some((f) => f.content.includes("useMutation"))) conventions.push("Data fetching: TanStack React Query (useMutation)");
  if (files.some((f) => f.content.includes("createFileRoute"))) conventions.push("Rotas: createFileRoute (TanStack Router)");
  if (allDeps.includes("zod")) conventions.push("Validação: Zod schemas");
  if (allDeps.includes("lucide-react")) conventions.push("Ícones: lucide-react");
  if (allDeps.includes("react-markdown")) conventions.push("Markdown: react-markdown");

  return {
    framework,
    buildTool,
    styling,
    routing,
    stateManagement,
    language,
    dependencies: pkgDeps,
    devDependencies: pkgDevDeps,
    components,
    conventions,
    entryPoints,
  };
}

/**
 * Formats the project analysis into a concise text block for the system prompt.
 */
export function formatAnalysisForPrompt(a: ProjectAnalysis): string {
  const lines: string[] = [
    "ANÁLISE AUTOMÁTICA DO PROJETO:",
    `- Framework: ${a.framework}`,
    `- Build: ${a.buildTool}`,
    `- Estilos: ${a.styling}`,
    `- Roteamento: ${a.routing}`,
    `- Estado: ${a.stateManagement}`,
    `- Linguagem: ${a.language}`,
  ];

  if (a.dependencies.length > 0) {
    lines.push(`- Dependências: ${a.dependencies.join(", ")}`);
  }

  if (a.entryPoints.length > 0) {
    lines.push(`- Pontos de entrada: ${a.entryPoints.join(", ")}`);
  }

  if (a.components.length > 0) {
    lines.push("", "COMPONENTES EXISTENTES (reutilize ANTES de criar novos):", "");
    for (const c of a.components) {
      const expStr = c.exports.length > 0 ? ` → ${c.exports.join(", ")}` : "";
      lines.push(`- ${c.path}${expStr}`);
    }
  }

  if (a.conventions.length > 0) {
    lines.push("", "CONVENÇÕES DETECTADAS (SIGA estas convenções):", "");
    for (const conv of a.conventions) {
      lines.push(`- ${conv}`);
    }
  }

  return lines.join("\n");
}


/* ═══════════════════════════════════════════════════════════════════
   INTENT CLASSIFICATION
   ═══════════════════════════════════════════════════════════════════ */

const ADD_PATTERNS = [
  /adicion\w*\s+(a|as|essa|esta|essas|estas|o\s+arquivo)/i,
  /(imagem|imagens|logo|foto|banner|ícone|icone|print|splash|background|fundo)[^.]{0,40}(no|ao|dentro do|para o|à|no)\s+projeto/i,
  /(inserir|insira|inclua|incluir|coloque|colocar|suba|subir|use|usar|salve|salvar)[^.]{0,40}(imagem|imagens|logo|foto|banner|ícone|icone|print)[^.]{0,40}(no|ao|dentro do|para o|como)\s+(projeto|reposit[óo]rio|assets|pasta|site|p[áa]gina|c[óo]digo)/i,
  /(imagem|imagens)[^.]{0,30}(deve|devem)\s+(fazer parte|ser adicionad|ser inserid|ser us\w+ no projeto)/i,
  /(substitu\w*|troque|mude|altere|atualize|trocar|mudar|alterar|atualizar)[^.]{0,30}(a\s+)?(imagem|logo|foto|banner|ícone|icone|splash|fundo)/i,
  /(adicion\w*|inclua|use\s+como|salve)\s+(esta|essa|a|como)\s+(imagem|logo|foto|banner|ícone|icone|splash)\s+(como|em|no|na|para)\s+(asset|icone|ícone|imagem|logo|fundo|background)/i,
  /(upload|enviar|subir)\s+(esta|essa|a)\s*(imagem|logo|foto|banner)/i,
  /(coloque|deixe|ponha|mantenha)\s+(esta|essa|a)\s+(imagem|logo|foto|banner)\s+(no|no|no)\s+(projeto|site|reposit[óo]rio)/i,
];

const REFERENCE_PATTERNS = [
  /(observe|veja|olhe|analise|entenda|interprete|repare|note|descubra)[^.]{0,30}(imagem|imagens|anexo|print|captura|screenshot|tela)/i,
  /(conforme|como|de acordo com|segundo|baseado n\w+|se baseando|igual\s+a)[^.]{0,30}(imagem|imagens|anexo|print|captura|tela|mostra|essa|esta|aqui)/i,
  /(imagem|anexo|print|tela)[^.]{0,20}(de|como)\s+(refer[êe]ncia|exemplo|modelo|base|guia)/i,
  /(replic|reproduz|copi|imit|clone|fa[çz]a\s+igual|deixe\s+igual)[^.]{0,30}(layout|design|interface|tela|p[áa]gina|ui|visual|estilo|look)/i,
  /(fa[çz]a|deixe|torne)[^.]{0,20}(igual|parecido|semelhante|similar)[^.]{0,20}(a|ao|à|com|esse|esta|essa|aqui)/i,
  /(quero|eu\s+quero|gostaria|preciso)[^.]{0,20}(assim|igual|parecido|como|como\s+esta|como\s+essa|igual\s+a)/i,
  /(siga|sigua|use)\s+(este|esse|esta|essa|o)\s+(design|layout|estilo|modelo|padrão|visual|tema)/i,
  /(assim\s+(que|deve)|é\s+assim\s+que|deve\s+ficar\s+assim)/i,
];

export function classifyImageIntent(instruction: string): ImageIntent {
  if (REFERENCE_PATTERNS.some((r) => r.test(instruction))) return "reference-only";
  if (ADD_PATTERNS.some((r) => r.test(instruction))) return "add-to-project";
  return "reference-only";
}

export function assetPath(fileName: string) {
  const safe = fileName.replace(/[^\w.-]+/g, "-").toLowerCase();
  return `public/uploads/${safe}`;
}


/* ═══════════════════════════════════════════════════════════════════
   PROMPT INJECTION DETECTION & SANITIZATION
   ═══════════════════════════════════════════════════════════════════ */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+(now|no\s+longer)\s+/i,
  /system\s*:\s*"?/i,
  /\{[\s\S]*?"role"\s*:\s*"system"/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|prompt|training)/i,
  /new\s+(instructions?|rules?|prompt)\s*:/i,
  /override\s+(the\s+)?(system|previous|above|current)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /act\s+as\s+(if\s+you\s+(are|were)|a\s+different)/i,
  /disregard\s+(your|the|all)\s+(instructions?|rules?|training)/i,
  /jailbreak/i,
  /\bDAN\b.*\bmode\b/i,
  / Role:.*[\r\n]/i,
];

export function sanitizeInstruction(input: string): { clean: string; flagged: boolean } {
  let flagged = false;
  let clean = input;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(clean)) {
      flagged = true;
      clean = clean.replace(pattern, "[bloqueado: tentativa de injeção removida]");
    }
  }
  if (clean.length > 10_000) {
    clean = clean.slice(0, 10_000) + "\n\n[instrução truncada: limite de 10.000 caracteres]";
    flagged = true;
  }
  return { clean, flagged };
}


/* ═══════════════════════════════════════════════════════════════════
   VALIDATION — Security, consistency, and code quality
   ═══════════════════════════════════════════════════════════════════ */

export function validateChanges(
  changes: { path: string; action?: string; content?: string }[],
): void {
  const DANGEROUS_PATHS = [/^\.git\//, /^\.env(|$)/, /^\.ssh\//, /^id_rsa/, /^id_ed25519/];
  for (const change of changes) {
    if (change.path.startsWith("/") || change.path.includes("..")) {
      throw new Error(`Caminho de arquivo bloqueado por segurança: ${change.path}`);
    }
    for (const dp of DANGEROUS_PATHS) {
      if (dp.test(change.path)) {
        throw new Error(`Arquivo sensível bloqueado: ${change.path}`);
      }
    }
    if (change.content && change.content.length > 500_000) {
      throw new Error(
        `Conteúdo bloqueado por tamanho excessivo: ${change.path} (${(change.content.length / 1024).toFixed(0)}KB)`,
      );
    }
  }
}

/**
 * Validates code consistency across all changes BEFORE committing.
 * Detects truncated code, unbalanced brackets, broken imports,
 * missing types, and other issues that would cause build errors.
 */
export function validateChangesConsistency(
  changes: { path: string; action?: string; content?: string }[],
  repoPaths: { path: string }[],
): string[] {
  const warnings: string[] = [];
  const upserted = new Map<string, string>();
  const pathSet = new Set(repoPaths.map((p) => p.path));

  for (const c of changes) {
    if (c.action === "delete" || !c.content) continue;
    upserted.set(c.path, c.content);
    pathSet.add(c.path);
  }

  const allPathsArr = [...pathSet];

  for (const [path, content] of upserted) {
    // ── 1. Truncation detection ──
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
      if (pat.test(content)) {
        warnings.push(`\`${path}\` contém marcador de truncamento ("...") — arquivo incompleto.`);
        break;
      }
    }

    // ── 2. File ends mid-statement ──
    const trimmed = content.trimEnd();
    if (trimmed.length > 50) {
      const lastChar = trimmed[trimmed.length - 1]!;
      const isCode = /\.(tsx?|jsx?|ts|js|mjs|cjs|vue|svelte|astro|css|scss|html|json|yaml|yml|py|rb|go|rs|java|kt|php|sh|sql|graphql|prisma)$/i.test(path);
      if (isCode && lastChar !== "," && lastChar !== "}" && lastChar !== ")" && lastChar !== "]" && lastChar !== ";" && lastChar !== "`" && lastChar !== ">" && lastChar !== "/" && lastChar !== "'" && lastChar !== "\n") {
        // Check if it looks like it was cut off (no closing bracket/brace/semicolon)
        const openBraces = (trimmed.match(/\{/g) || []).length;
        const closeBraces = (trimmed.match(/\}/g) || []).length;
        if (openBraces !== closeBraces) {
          warnings.push(`\`${path}\` parece estar cortado no final — verifique se está completo.`);
        }
      }
    }

    // ── 3. Unbalanced delimiters ──
    const isCode = /\.(tsx?|jsx?|ts|js|mjs|cjs|vue|svelte|astro|css|scss|sass|html|json|yaml|yml|toml|md|mdx|py|rb|go|rs|java|kt|php|sh|sql|graphql|prisma)$/i.test(path);
    if (!isCode) continue;

    const isDataFormat = /\.(json|yaml|yml|toml)$/i.test(path);
    if (isDataFormat) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (const ch of content) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (inStr) { if (ch === "\"") inStr = false; continue; }
        if (ch === "\"") { inStr = true; continue; }
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth !== 0) {
        warnings.push(`\`${path}\` tem chaves desbalanceadas (${depth > 0 ? "faltam fechar" : "sobram"}).`);
      }
      continue;
    }

    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let inStr = false;
    let strChar = "";
    let inTemplate = false;
    let esc = false;
    let inLineComment = false;
    let inBlockComment = false;

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
        let tDepth = 1;
        let j = i + 2;
        let tEsc = false;
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
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;
        if (ch === "[") bracketDepth++;
        if (ch === "]") bracketDepth--;
      }
    }

    if (braceDepth !== 0) warnings.push(`\`${path}\` chaves {} desbalanceadas (${braceDepth > 0 ? `faltam ${braceDepth}` : `sobram ${-braceDepth}`}).`);
    if (parenDepth !== 0) warnings.push(`\`${path}\` parênteses () desbalanceados.`);
    if (bracketDepth !== 0) warnings.push(`\`${path}\` colchetes [] desbalanceados.`);

    // ── 4. Import consistency ──
    const importRegexes = [
      /(?:import|from)\s+["']([^"']+)["']/g,
      /(?:import\s*\([^)]*\)\s*from\s*)["']([^"']+)["']/g,
      /(?:require\s*\()["']([^"']+)["']/g,
    ];

    for (const regex of importRegexes) {
      let importMatch: RegExpExecArray | null;
      while ((importMatch = regex.exec(content)) !== null) {
        const importPath = importMatch[1]!;
        if (importPath.startsWith(".") || importPath.startsWith("/")) {
          const dir = path.substring(0, path.lastIndexOf("/"));
          let resolved = importPath;
          if (importPath.startsWith("./") || importPath.startsWith("../")) {
            const parts = dir.split("/").concat(importPath.split("/"));
            const resolvedParts: string[] = [];
            for (const part of parts) {
              if (part === ".." && resolvedParts.length > 0) resolvedParts.pop();
              else if (part !== "." && part !== "") resolvedParts.push(part);
            }
            resolved = resolvedParts.join("/");
          }
          const hasExtension = /\.[^.]+$/.test(resolved);
          const possiblePaths = hasExtension
            ? [resolved]
            : [
                `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
                `${resolved}/index.ts`, `${resolved}/index.tsx`, `${resolved}/index.js`, `${resolved}/index.jsx`,
                `${resolved}/route.ts`, `${resolved}/route.tsx`,
              ];
          const exists = possiblePaths.some((p) =>
            allPathsArr.some((rp) => rp === p || rp === p.replace(/\/index\.\w+$/, "")),
          );
          if (!importPath.startsWith("@") && !exists) {
            warnings.push(`\`${path}\` importa "${importPath}" que não existe no repositório nem nas mudanças.`);
          }
        }
      }
    }

    // ── 5. JSX tag balance (for TSX/JSX) ──
    if (/\.(tsx|jsx)$/i.test(path)) {
      // Simple heuristic: count opening vs closing JSX tags for custom components
      // Skip intrinsic elements (div, span, etc.) and self-closing tags
      const jsxOpenTags = content.match(/<(?!\/|!|\w)([A-Z][\w]*)\b[^/]*>/g) || [];
      const jsxCloseTags = content.match(/<\/([A-Z][\w]*)\s*>/g) || [];
      const selfClosing = content.match(/<(?!\/|!|\w)([A-Z][\w]*)\b[^/]*\/>/g) || [];
      const openCount = jsxOpenTags.length - selfClosing.length;
      const closeCount = jsxCloseTags.length;
      // This is a rough heuristic, only warn if significantly off
      if (openCount > 0 && Math.abs(openCount - closeCount) > 2) {
        warnings.push(`\`${path}\` pode ter tags JSX desbalanceadas (${openCount} abertas vs ${closeCount} fechadas, ${selfClosing.length} self-closing).`);
      }
    }
  }

  return warnings;
}


/* ═══════════════════════════════════════════════════════
   SYSTEM PROMPT — 4-phase + Style Enforcer + Context Engine
   ═══════════════════════════════════════════════════════ */

export interface SystemPromptContext {
  analysis?: ProjectAnalysis;
  componentRegistrySummary?: string;
  dependencySummary?: string;
  sessionHistory?: string;
  validationFeedback?: string;
  /** Contexto enriquecido do ProjectContextStore (arquitetura, conexões, histórico, rollback) */
  enrichedContext?: string;
  /** Análise de impacto das mudanças propostas */
  impactAnalysis?: string | undefined;
  /** Resumo compacto de mudanças anteriores (para manter contexto em prompts longos) */
  previousChangesSummary?: string | undefined;
}

export function buildSystemPrompt(ctx?: SystemPromptContext): string {
  const contextBlock = ctx?.analysis ? `\n\n${formatAnalysisForPrompt(ctx.analysis)}\n` : "";
  const componentBlock = ctx?.componentRegistrySummary ? `\n\n${ctx.componentRegistrySummary}\n` : "";
  const dependencyBlock = ctx?.dependencySummary ? `\n\n${ctx.dependencySummary}\n` : "";
  const historyBlock = ctx?.sessionHistory ? `\n\n${ctx.sessionHistory}\n` : "";
  const validationBlock = ctx?.validationFeedback ? `\n\n${ctx.validationFeedback}\n` : "";
  const enrichedBlock = ctx?.enrichedContext ? `\n\n${ctx.enrichedContext}\n` : "";
  const impactBlock = ctx?.impactAnalysis ? `\n\n${ctx.impactAnalysis}\n` : "";
  const prevChangesBlock = ctx?.previousChangesSummary ? `\n\nMUDANÇAS ANTERIORES (resumo compacto — não refaça o que já foi feito):\n${ctx.previousChangesSummary}\n` : "";

  return `Você é o GIR AGENT — um ORQUESTRADOR MULTI-AGENTE de engenharia de software que opera diretamente sobre um repositório GitHub real. Você combina a precisão de um desenvolvedor sênior com 15+ anos de experiência e a eficiência de um time completo.

SEU PAPEL:
- Analisa projetos inteiros, entende a arquitetura e o contexto completo.
- Gera código de PRODUÇÃO seguindo rigorosamente os padrões do projeto.
- Valida suas próprias mudanças antes de commitar.
- Mantém contexto entre interações — nunca esquece o que fez antes.
- Detecta e evita regressões, imports quebrados e dependências faltantes.
- CONSULTE a seção ARQUITETURA DO PROJETO e CONEXÕES ENTRE ARQUIVOS antes de cada mudança.
- VERIFIQUE o histórico de mudanças para não refazer algo já implementado.
- Ao modificar um arquivo, verifique quais OUTROS arquivos importam ele (CONEXÕES) e atualize se necessário.
${contextBlock}${enrichedBlock}${componentBlock}${dependencyBlock}${impactBlock}${prevChangesBlock}${historyBlock}
IMAGENS ANEXADAS — REGRAS OBRIGATÓRIAS:

Existem DOIS MODOS de usar imagens anexadas. A POLÍTICA DE IMAGENS no contexto dirá qual modo se aplica. OBEÇA A POLÍTICA SEMPRE.
As imagens podem ser fornecidas de DUAS FORMAS:
1. Diretamente como blocos de imagem (se o modelo suporta visão) — analise o que você VÊ.
2. Como DESCRIÇÕES TEXTUAIS geradas por um modelo de visão separado — analise o que está DESCRITO.
Em qualquer caso, trate as informações visuais como FUNDAMENTAIS para a solicitação.

MODO 1 — SALVAR NO REPOSITÓRIO ("add-to-project"):
- A POLÍTICA informará os CAMINHOS EXATOS das imagens.
- Analise a imagem/descrição e crie referências usando EXATAMENTE esses caminhos.
- A imagem será salva automaticamente — referências funcionarão.

MODO 2 — APENAS REFERÊNCIA VISUAL ("reference-only"):
- Analise a imagem/descrição DETALHADAMENTE: layouts, cores, posições, textos, ícones, espaçamentos, tipografia.
- Baseie TODAS as modificações no que observou.
- NUNCA crie imports/caminhos para essas imagens — reproduza o visual com CSS, HTML, SVG ou assets existentes.

EM QUALQUER MODO: Nunca IGNORE imagens/descrições. Descreva no "reasoning" o que observou.

${validationBlock}
PROCESSO OBRIGATÓRIO DE 4 FASES (NÃO pule nenhuma fase):

═══ FASE 1 — ANÁLISE PROFUNDA (antes de QUALQUER código) ═══
1. Leia a solicitação COMPLETA do usuário — cada palavra importa.
2. Identifique a INTENÇÃO REAL: feature, bugfix, refatoração, estilo, infraestrutura?
3. Liste TODOS os arquivos que precisam ser criados ou modificados.
4. Para cada arquivo, mapeie:
   - Dependências internas (outros arquivos do projeto)
   - Dependências externas (pacotes npm)
   - Tipos/interfaces que precisam ser criados ou atualizados
5. Verifique o REGISTRO DE COMPONENTES — pode reutilizar algo?
6. Verifique o HISTÓRICO DE MUDANÇAS — já fez algo relacionado?
7. Verifique DEPENDÊNCIAS IMPACTADAS — quem vai quebrar?
8. Determine se precisa de novas dependências no package.json.
9. Defina o ESCOPO EXATO — prefira mudanças pequenas e COMPLETAS a mudanças grandes e truncadas.
10. Se o escopo for muito grande (>5 arquivos ou >300 linhas total), REDUZA: quebre em subtarefas.

═══ FASE 2 — PLANEJAMENTO DETALHADO (campo "plan") ═══
Liste EXPLICITAMENTE:
- Arquivos a CRIAR (caminho completo + propósito de cada um)
- Arquivos a MODIFICAR (caminho + o que muda em cada um)
- Dependências a ADICIONAR ao package.json (com versão se possível)
- Componentes do REGISTRO a REUTILIZAR (nome + por quê)
- Tipos/interfaces que precisam ser criados
- Arquivos que podem ser IMPACTADOS indiretamente
- Riscos identificados e mitigação
- Ordem de implementação (dependências primeiro)

═══ FASE 3 — IMPLEMENTAÇÃO (escreva o código) ═══
REGRAS DE ESTILO — OBRIGATÓRIO seguir:
- Use OS MESMOS padrões detectados acima (framework, build tool, styling, routing, estado).
- Use a MESMA linguagem do projeto (se o projeto é TypeScript, NÃO use JavaScript).
- Mantenha NOMENCLATURA consistente: se o projeto usa PascalCase para componentes, faça o mesmo.
- Se o projeto usa alias @/ para imports, use @/ ao invés de caminhos relativos.
- Use os MESMOS ícones (lucide-react) e bibliotecas (zod, react-markdown, etc.).
- SIGA AS CONVENÇÕES DETECTADAS rigorosamente.

REGRAS DE IMPLEMENTAÇÃO:
- Cada arquivo no "content" deve ter CONTEÚDO INTEIRO e FINAL — JAMAIS abrevie.
- Inclua TRATAMENTO DE ERROS adequado (try-catch, validações, fallbacks).
- Se criar um componente, IMPORTE-O e RENDERIZE-O no local correto.
- Se alterar um tipo/interface, atualize TODOS os consumidores.
- Se adicionar uma dependência, adicione ao package.json com versão.
- Use TYPESCRIPT STRICT — tipos explícitos, sem "any" desnecessário.
- Prefira COMPOSIÇÃO sobre herança.
- Mantenha COMPONENTES PEQUENOS (< 200 linhas) — divida se necessário.
- Use NOMES DESCRITIVOS — sem abreviações obscuras.

═══ FASE 4 — VALIDAÇÃO INTERNA (verifique TUDO antes de enviar) ═══
CHECKLIST OBRIGATÓRIO (passe por CADA item):
□ Todo IMPORT tem um arquivo correspondente no repositório ou nas mudanças?
□ Todo EXPORT é consumido por algum arquivo?
□ Todo COMPONENTE criado é importado e renderizado em algum lugar?
□ Todas as CHAVES {} estão balanceadas (incluindo strings e comentários)?
□ Todos os PARÊNTESES () estão balanceados?
□ Todos os COLCHETES [] estão balanceados?
□ Todas as STRINGS estão fechadas (aspas duplas e simples)?
□ O package.json inclui novas dependências?
□ Nenhum arquivo foi TRUNCADO (sem "...", "restante igual", etc.)?
□ A primeira e última linha de cada arquivo estão completas?
□ Tipos/interfaces referenciados existem?
□ O JSON final é válido (teste mentalmente com JSON.parse)?
Se QUALQUER item falhar, CORRIJA antes de enviar. NÃO envie JSON inválido.

COMPLETUDE DE CÓDIGO (CRÍTICO):
- O campo "content" de CADA change DEVE conter o CONTEÚDO INTEIRO e FINAL do arquivo.
- NUNCA use "...restante igual", "// ...existing code..." ou qualquer abreviação.
- NUNCA trunque. Se o arquivo é longo, reduza o escopo em vez de truncar.
- Antes de finalizar: primeira linha completa? Última linha completa? Delimitadores balanceados?

REGRAS DE SAÍDA:
- Devolva SOMENTE um objeto JSON válido, sem texto fora do JSON.
- Todo commit vai direto para a branch main.
- NUNCA peça mais informações. Faça suposições razoáveis e execute.
- Sempre retorne changes com pelo menos uma alteração concreta. NUNCA retorne needsClarification: true.
- A única exceção é se o pedido for explicitamente destrutivo.

REGRAS DO CAMPO "summary":
- Relatório CLARO em markdown, SEM código-fonte nem blocos de código.
- Descreva APENAS o que foi feito e o resultado esperado.
- Linguagem simples e direta.

ESCAPE DE JSON (CRÍTICO — EVITA ERROS DE PARSING):
- Aspas duplas dentro de valores string: escape como \".
- Barras invertidas: escape como \\\
- Quebras de linha em strings: use \n.
- O campo "content" tem código-fonte com caracteres especiais — o JSON final DEVE ser parseável por JSON.parse().

FORMATO DE RESPOSTA (JSON obrigatório):
{
  "reasoning": "FASE 1 — ANÁLISE: [descrição completa: intenção, arquivos, dependências, componentes, escopo, riscos]",
  "plan": ["1. Criar/modificar X", "2. Atualizar imports em Y", "3. Adicionar dep Z ao package.json"],
  "summary": "Resumo claro em markdown SEM código.",
  "commitMessage": "msg curta e imperativa",
  "next_steps": ["Sugestão 1 de próximo passo", "Sugestão 2"],
  "changes": [
    { "path": "src/exemplo.tsx", "action": "upsert", "content": "conteúdo COMPLETO do arquivo" }
  ]
}

REGRAS FINAIS:
- O campo "plan" deve listar as ações planejadas (array de strings curtas).
- O campo "next_steps" deve sugerir 2-3 próximos passos.
- O campo "reasoning" deve documentar a FASE 1 COMPLETA.
- Nunca quebre funcionalidades existentes.
- Reutilize componentes ANTES de criar novos — consulte o REGISTRO DE COMPONENTES.
- Cada arquivo no "changes" deve ter CONTEÚDO COMPLETO.
- Se receber feedback de VALIDAÇÃO FALHOU, corrija os problemas e re-envie o JSON.`;
}
