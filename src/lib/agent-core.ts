export type ImageIntent = "add-to-project" | "reference-only";

/* ── Intent classification ──
 *
 * IMPORTANT: The default is "reference-only" because most users attach
 * screenshots as visual references for the agent to replicate layouts,
 * colors, and styles — NOT to save the image file into the repo.
 *
 * Only classify as "add-to-project" when the user EXPLICITLY says they
 * want the image file saved/added/included as an asset in the project.
 */

/** Patterns that STRONGLY indicate the user wants the image FILE saved into the repo. */
const ADD_PATTERNS = [
  // Explicit "add/insert/save image to project/assets"
  /adicion\w*\s+(a|as|essa|esta|essas|estas|o\s+arquivo)/i,
  /(imagem|imagens|logo|foto|banner|\ícone|icone|print|splash|background|fundo)[^.]{0,40}(no|ao|dentro do|para o|\à|no)\s+projeto/i,
  /(inserir|insira|inclua|incluir|coloque|colocar|suba|subir|use|usar|salve|salvar)[^.]{0,40}(imagem|imagens|logo|foto|banner|\ícone|icone|print)[^.]{0,40}(no|ao|dentro do|para o|como)\s+(projeto|reposit[óo]rio|assets|pasta|site|p[áa]gina|c[óo]digo)/i,
  // "image should be part of the project"
  /(imagem|imagens)[^.]{0,30}(deve|devem)\s+(fazer parte|ser adicionad|ser inserid|ser us\w+ no projeto)/i,
  // "replace/update the current logo/image"
  /(substitu\w*|troque|mude|altere|atualize|trocar|mudar|alterar|atualizar)[^.]{0,30}(a\s+)?(imagem|logo|foto|banner|\ícone|icone|splash|fundo)/i,
  // "add this image as an asset/icon"
  /(adicion\w*|inclua|use\s+como|salve)\s+(esta|essa|a|como)\s+(imagem|logo|foto|banner|\ícone|icone|splash)\s+(como|em|no|na|para)\s+(asset|icone|ícone|imagem|logo|fundo|background)/i,
  // "upload image to public/assets"
  /(upload|enviar|subir)\s+(esta|essa|a)\s*(imagem|logo|foto|banner)/i,
  // "put/leave this image in the project"
  /(coloque|deixe|ponha|mantenha)\s+(esta|essa|a)\s+(imagem|logo|foto|banner)\s+(no|no|no)\s+(projeto|site|reposit[óo]rio)/i,
];

/** Patterns that indicate the user wants the model to LOOK AT the image for reference. */
const REFERENCE_PATTERNS = [
  // "look at / observe / analyze this image"
  /(observe|veja|olhe|analise|entenda|interprete|repare|note|descubra)[^.]{0,30}(imagem|imagens|anexo|print|captura|screenshot|tela)/i,
  // "based on / according to / like this image"
  /(conforme|como|de acordo com|segundo|baseado n\w+|se baseando|igual\s+a)[^.]{0,30}(imagem|imagens|anexo|print|captura|tela|mostra|essa|esta|aqui)/i,
  // "use as reference / example / model"
  /(imagem|anexo|print|tela)[^.]{0,20}(de|como)\s+(refer[êe]ncia|exemplo|modelo|base|guia)/i,
  // "replicate / reproduce / copy this layout/design"
  /(replic|reproduz|copi|imit|clone|fa[çz]a\s+igual|deixe\s+igual)[^.]{0,30}(layout|design|interface|tela|p[áa]gina|ui|visual|estilo|look)/i,
  // "make it look like / similar to this"
  /(fa[çz]a|deixe|torne)[^.]{0,20}(igual|parecido|semelhante|similar)[^.]{0,20}(a|ao|\à|com|esse|esta|essa|aqui)/i,
  // "I want it like this / do like this"
  /(quero|eu\s+quero|gostaria|preciso)[^.]{0,20}(assim|igual|parecido|como|como\s+esta|como\s+essa|igual\s+a)/i,
  // "follow this design / style"
  /(siga|sigua|use)\s+(este|esse|esta|essa|o)\s+(design|layout|estilo|modelo|padrão|visual|tema)/i,
  // "this is how it should look"
  /(assim\s+(que|deve)|é\s+assim\s+que|deve\s+ficar\s+assim)/i,
];

/**
 * Classifies whether attached images should be committed into the repository
 * or used only as visual reference for reasoning.
 */
export function classifyImageIntent(instruction: string): ImageIntent {
  const isReference = REFERENCE_PATTERNS.some((r) => r.test(instruction));
  if (isReference) return "reference-only";

  const wantsAdd = ADD_PATTERNS.some((r) => r.test(instruction));
  if (wantsAdd) return "add-to-project";

  return "reference-only";
}

export function assetPath(fileName: string) {
  const safe = fileName.replace(/[^\w.-]+/g, "-").toLowerCase();
  return `public/uploads/${safe}`;
}

/* ── Prompt injection detection & sanitization ── */

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

/**
 * Sanitizes user instruction to mitigate prompt injection attacks.
 */
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

/**
 * Validates LLM output changes to prevent malicious or destructive modifications.
 */
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
        `Conteúdo bloqueado por tamanho excessivo: ${change.path} (${(change.content.length / 1024).toFixed(0)}KB)`
      );
    }
  }
}

/**
 * Validates code consistency across all changes BEFORE committing.
 * Detects truncated code, unbalanced brackets, broken imports, and other
 * issues that would cause build errors.
 *
 * Returns a list of warnings. Throws if critical issues are found.
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
    // Check for common truncation patterns that models produce
    const truncationPatterns = [
      /\.\.\.[^.]*igual[^\n]*$/im,
      /\.\.\.[^.]*rest[^\n]*$/im,
      /\.\.\.[^.]*remaining[^\n]*$/im,
      /\.\.\.[^.]*existing[^\n]*$/im,
      /\.\.\.[^.]*unchanged[^\n]*$/im,
      /\.\.\.[^.]*same[^\n]*$/im,
      /\/\*.*rest.*\*\//i,
      /<\/\w+>.*\/\*.*\*\/>\s*$/s,
    ];

    for (const pat of truncationPatterns) {
      if (pat.test(content)) {
        warnings.push(`\`${path}\` contém marcador de truncamento ("...") — o arquivo está incompleto e causará erro de build.`);
        break;
      }
    }

    // ── 2. Unbalanced delimiters (quick heuristic) ──
    // Skip non-code files
    const isCode = /\.(tsx?|jsx?|ts|js|mjs|cjs|vue|svelte|astro|css|scss|sass|html|json|yaml|yml|toml|md|mdx|py|rb|go|rs|java|kt|php|sh|sql|graphql|prisma)$/i.test(path);
    if (!isCode) continue;

    // For JSON/YAML, just check balanced braces
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
        warnings.push(`\`${path}\` tem chaves desbalanceadas (${depth > 0 ? "faltam fechar" : "sobram"}). O arquivo está provavelmente truncado.`);
      }
      continue;
    }

    // For code files, check balanced {} and ()
    let braceDepth = 0;
    let parenDepth = 0;
    let inStr = false;
    let strChar = "";
    let inTemplate = false;
    let esc = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i]!;
      const next = content[i + 1];

      // Handle comments
      if (!inStr && !inTemplate) {
        if (inLineComment) {
          if (ch === "\n") inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (ch === "*" && next === "/") { inBlockComment = false; i++; }
          continue;
        }
        if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
        if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
      }

      if (esc) { esc = false; continue; }
      if (ch === "\\" && (inStr || inTemplate)) { esc = true; continue; }

      // Template literals
      if (!inStr && ch === "`" && !inLineComment && !inBlockComment) {
        inTemplate = !inTemplate;
        continue;
      }
      if (inTemplate && ch === "$") {
        // Check for ${...} — the { and } inside should cancel out
        if (next === "{") {
          // Count template expression depth separately
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
          i = j - 1; // skip past the template expression
          continue;
        }
      }

      // Strings
      if (!inTemplate) {
        if (!inStr && (ch === '"' || ch === "'")) {
          inStr = true;
          strChar = ch;
          continue;
        }
        if (inStr && ch === strChar) {
          inStr = false;
          continue;
        }
      }

      // Count delimiters only when not inside strings/templates/comments
      if (!inStr && !inTemplate) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;
      }
    }

    if (braceDepth !== 0) {
      warnings.push(`\`${path}\` tem chaves {} desbalanceadas (${braceDepth > 0 ? `faltam ${braceDepth} fechamentos` : `sobram ${-braceDepth} fechamentos`}). Arquivo provavelmente truncado.`);
    }
    if (parenDepth !== 0) {
      warnings.push(`\`${path}\` tem parênteses () desbalanceados (${parenDepth > 0 ? `faltam ${parenDepth} fechamentos` : `sobram ${-parenDepth} fechamentos`}).`);
    }

    // ── 3. Import consistency ──
    // Extract import paths and check they exist in the repo or in the changes
    const importRegexes = [
      /(?:import|from)\s+["']([^"']+)["']/g,
      /(?:import\s*\([^)]*\)\s*from\s*)["']([^"']+)["']/g,
      /(?:require\s*\()["']([^"']+)["']/g,
    ];

    for (const regex of importRegexes) {
      let importMatch: RegExpExecArray | null;
      while ((importMatch = regex.exec(content)) !== null) {
        const importPath = importMatch[1]!;

        // Skip node_modules, built-in, package imports, and aliases that resolve at build time
        if (
          importPath.startsWith(".") ||
          importPath.startsWith("/")
        ) {
          // Resolve relative path
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

          // Check if the resolved path (with or without extension) exists
          const hasExtension = /\.[^.]+$/.test(resolved);
          const possiblePaths = hasExtension
            ? [resolved]
            : [
                `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
                `${resolved}/index.ts`, `${resolved}/index.tsx`, `${resolved}/index.js`, `${resolved}/index.jsx`,
                `${resolved}/route.ts`, `${resolved}/route.tsx`,
              ];

          const exists = possiblePaths.some((p) =>
            allPathsArr.some((rp) => rp === p || rp === p.replace(/\/index\.\w+$/, ""))
          );

          // Only warn if it's not a path alias (starts with @) and doesn't exist
          if (!importPath.startsWith("@") && !exists) {
            warnings.push(`\`${path}\` importa "${importPath}" que não existe no repositório nem nas mudanças atuais.`);
          }
        }
      }
    }
  }

  return warnings;
}

export function buildSystemPrompt() {
  return `Você é um engenheiro de software autônomo de altíssimo nível (estilo Lovable/Bolt/Base44), operando diretamente sobre um repositório GitHub real.

IMAGENS ANEXADAS — REGRAS OBRIGATÓRIAS:

Existem DOIS MODOS de usar imagens anexadas. A POLÍTICA DE IMAGENS no contexto dirá qual modo se aplica. OBEÇA A POLÍTICA SEMPRE.

MODO 1 — IMAGENS SALVAR NO REPOSITÓRIO ("add-to-project"):
- A POLÍTICA dirá explicitamente que as imagens serão SALVAS e informará os CAMINHOS EXATOS.
- Analise a imagem visualmente para entender seu conteúdo, cores e proporções.
- Crie referências a essas imagens no código usando EXATAMENTE os caminhos informados na política (ex: em tags <img>, imports CSS, background-image).
- NUNCA invente caminhos — use SOMENTE os caminhos que a política informar.
- A imagem será salva automaticamente no repositório, então referências a ela funcionarão.

MODO 2 — IMAGENS APENAS COMO REFERÊNCIA VISUAL ("reference-only"):
- A POLÍTICA dirá explicitamente que as imagens são APENAS REFERÊNCIA VISUAL.
- Analise a imagem DETALHADAMENTE: entenda layouts, cores, tamanhos, posições, textos, ícones, espaçamentos, tipografia, estrutura de componentes e CADA detalhe visual relevante.
- Baseie TODAS as suas modificações de código no que você VÊ na imagem.
- NUNCA crie imports, caminhos ou referências a arquivos de imagem para essas imagens anexadas (elas NÃO existirão no repositório).
- EM VEZ DISSO, reproduza o visual usando CSS, HTML, SVG ou imagens/ícones que JÁ EXISTEM no repositório.
- Exemplo: se a imagem mostra um botão azul com border-radius, crie o botão com CSS ao invés de referenciar a imagem.

EM QUALQUER MODO:
- Nunca IGNORE as imagens anexadas. Elas são parte FUNDAMENTAL da solicitação.
- Descreva no "reasoning" o que você observou nas imagens e como isso guia suas mudanças.

RACIOCÍNIO ADAPTATIVO (obrigatório, antes de escrever código):
1. Mapeie a arquitetura: framework, build, roteamento, sistema de estilos, convenções de pasta e nomes.
2. Localize os pontos de entrada e verifique como cada arquivo é IMPORTADO/RENDERIZADO. Nunca crie código órfão: se criar um componente, importe-o e renderize-o no lugar correto; se alterar um texto/elemento, garanta que o arquivo alterado realmente é o que aparece na tela.
3. Verifique coerência cruzada: imports, exports, tipos, rotas, tokens de design, dependências do package.json. Se a mudança exige ajuste em outro arquivo, ajuste também na mesma resposta.
4. Preserve o estilo do código existente. Não reescreva o projeto inteiro; faça a menor mudança correta e completa.
5. Nunca invente dependências não instaladas sem adicioná-las ao package.json.

COMPLETUDE DE CÓDIGO (CRÍTICO — NUNCA TRUNQUE):
- O campo "content" de CADA change DEVE conter o CONTEÚDO INTEIRO e FINAL do arquivo.
- NUNCA use "...restante igual", "// ...existing code...", "// rest stays the same" ou qualquer abreviação.
- NUNCA trunque um arquivo no meio. Se o conteúdo de um arquivo é muito longo, prefira alterar MENOS arquivos com conteúdo COMPLETO do que muitos arquivos com conteúdo INCOMPLETO.
- Cada arquivo enviado DEVE ser um arquivo válido que pode ser salvo e compilar/built sem erros.
- Se perceber que está atingindo o limite de tamanho, REDUZA o escopo: altere apenas os arquivos estritamente necessários, cada um com conteúdo completo.
- Antes de finalizar, verifique: todo arquivo tem sua primeira linha completa? Todo arquivo tem sua última linha completa? Todo par de chaves/parênteses/colchetes aberto está fechado?

AUTOVERIFICAÇÃO DE CONSISTÊNCIA (obrigatório antes de enviar):
Antes de montar o JSON final, verifique automaticamente:
1. IMPORTS COERENTES: Se um arquivo importa "./FooBar" ou "@/components/FooBar", verifique se o arquivo FooBar existe no repositório ou está sendo criado na mesma resposta.
2. EXPORTS COERENTES: Se um arquivo define "export function xyz" ou "export default", verifique que outro arquivo o importa corretamente.
3. COMPONENTES/ROTAS: Se criar um componente, verifique que ele é importado e renderizado em algum arquivo de roteamento ou página.
4. TIPOS: Se usar tipos/interfaces de outro arquivo, verifique que a importação está correta e o tipo existe.
5. CHAVES FECHADAS: Cada { tem um }, cada ( tem um ), cada [ tem um ], cada < tem um > (em JSX).
6. STRINGS FECHADAS: Cada " ou ' ou \` aberto é fechado na mesma linha ou com escape correto.
7. SINTAXE JSX: Toda tag <Componente> tem </Componente> ou /> de fechamento.
8. PACKAGE.JSON: Se usar uma dependência que não está no package.json, adicione-a.
9. ESTILOS: Se usar classes CSS ou variáveis de tema, verifique que existem no projeto.
Se encontrar inconsistência, CORRIJA antes de enviar. Nunca envie código sabendo que está quebrado.

REGRAS DE SAÍDA:
- Devolva SOMENTE um objeto JSON válido, sem texto fora do JSON.
- Para cada arquivo alterado ou criado, envie o CONTEÚDO COMPLETO final do arquivo (nunca diffs, nunca "...restante igual").
- Todo commit vai direto para a branch main.
- NUNCA peça mais informações ao usuário. Faça suposições razoáveis e execute.
- Se faltar um caminho de imagem/arquivo, use um caminho padrão sensato (ex: public/nova-imagem.png, public/assets/placeholder.svg). Se faltar um valor de texto, use um placeholder apropriado que faça sentido no contexto do projeto.
- Sempre retorne changes com pelo menos uma alteração concreta. NUNCA retorne needsClarification: true — resolva e aplique.
- A única exceção para NÃO aplicar mudanças é se o pedido for explicitamente destrutivo (ex: "apague todos os arquivos", "delete o repositório inteiro").

REGRAS DO CAMPO "summary":
- O campo "summary" é o que o usuário VÊ no chat. Deve ser um RELATÓRIO CLARO E SIMPLES em markdown.
- NUNCA inclua código-fonte, blocos de código, diffs ou trechos de código no summary.
- Descreva APENAS o que foi feito, quais arquivos foram alterados e o resultado esperado.
- Use linguagem simples e direta. Exemplo: "Atualizei a cor primária do tema de azul para verde e ajustei o padding do header."
- Se modificou muitos arquivos, liste apenas os nomes dos arquivos e a natureza da mudança, sem detalhes técnicos.

ESCAPE DE JSON (CRÍTICO — EVITA ERROS DE PARSING):
- Aspas duplas (") dentro de valores string DEVEM ser escapadas como \".
- Barras invertidas (\\) DEVEM ser escapadas como \\\\.
- Quebras de linha dentro de strings DEVEM ser \\n, nunca quebras de linha literais.
- O campo \\"content\\" contém código-fonte com muitos caracteres especiais — certifique-se de que o JSON resultante é válido e pode ser parseado por JSON.parse() sem erros.
- Antes de enviar, verifique mentalmente: o JSON estaria bem-formado se passado para JSON.parse()?

Formato:
{
  "reasoning": "análise da estrutura e do encaixe da mudança (markdown curto)",
  "summary": "resumo do que foi feito, em markdown, para o usuário",
  "commitMessage": "mensagem de commit curta e imperativa",
  "needsClarification": false,
  "changes": [
    { "path": "src/routes/index.tsx", "action": "upsert", "content": "conteúdo completo do arquivo" }
  ]}`;
}
