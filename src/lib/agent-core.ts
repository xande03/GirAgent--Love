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
  /adicione?.*(imagem|imagens|logo|foto|banner|icones|icones?|splash|fundo|background|arquivo).*(no|ao|dentro do|para o|à|na).*(projeto|reposit[óo]rio|assets|pasta|site|p[áa]gina|c[óo]digo)/i,
  /(inserir|insira|inclua|incluir|coloque|colocar|suba|subir|salve|salvar).*(imagem|imagens|logo|foto|banner|icones?|splash).*(no|ao|para o|como|na).*(projeto|reposit[óo]rio|assets|pasta|site|p[áa]gina)/i,
  // "image should be part of the project"
  /(imagem|imagens).*(deve|devem).*(fazer parte|ser adicionad|ser inserid|ser usad[ao] no projeto)/i,
  // "replace/update the current logo/image"
  /(substitua|troque|mude|altere|atualize|trocar|mudar|alterar|atualizar).{0,30}(a\s+)?(logo|imagem|foto|banner|icones?|splash|fundo)/i,
  // "add this image as an asset/icon"
  /(adicione?|inclua|use\s+como|salve)\s+(esta|essa|a|como)\s+(imagem|logo|foto|banner|icones?|splash)\s+(como|em|no|na|para)\s+(asset|icone|ícone|imagem|logo|fundo|background)/i,
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
  /(fa[çz]a|deixe|torne)[^.]{0,20}(igual|parecido|semelhante|similar)[^.]{0,20}(a|ao|à|com|esse|esta|essa|aqui)/i,
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
 *
 * Strategy:
 *  1. If the user EXPLICITLY describes using the image as reference → reference-only
 *  2. If the user EXPLICITLY says to add/insert/save the image → add-to-project
 *  3. Default → reference-only (most users attach screenshots to show what they want)
 */
export function classifyImageIntent(instruction: string): ImageIntent {
  // 1. Check for explicit reference patterns first
  const isReference = REFERENCE_PATTERNS.some((r) => r.test(instruction));
  if (isReference) return "reference-only";

  // 2. Check for explicit add patterns
  const wantsAdd = ADD_PATTERNS.some((r) => r.test(instruction));
  if (wantsAdd) return "add-to-project";

  // 3. Default: reference-only
  //    Most users attach screenshots/screens to show what they want visually.
  //    Only classify as "add" when there's an EXPLICIT instruction to save the file.
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
 * Returns the cleaned instruction and whether anything was flagged.
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

  // Limit instruction length to prevent context overflow
  if (clean.length > 10_000) {
    clean = clean.slice(0, 10_000) + "\n\n[instrução truncada: limite de 10.000 caracteres]";
    flagged = true;
  }

  return { clean, flagged };
}

/**
 * Validates LLM output changes to prevent malicious or destructive modifications.
 * Throws if any change is suspicious.
 */
export function validateChanges(
  changes: { path: string; action?: string; content?: string }[],
): void {
  const DANGEROUS_PATHS = [/^\.git\//, /^\.env(|$)/, /^\.ssh\//, /^id_rsa/, /^id_ed25519/];
  for (const change of changes) {
    // Block path traversal
    if (change.path.startsWith("/") || change.path.includes("..")) {
      throw new Error(`Caminho de arquivo bloqueado por segurança: ${change.path}`);
    }
    // Block sensitive files
    for (const dp of DANGEROUS_PATHS) {
      if (dp.test(change.path)) {
        throw new Error(`Arquivo sensível bloqueado: ${change.path}`);
      }
    }
    // Block excessively large content (>500KB per file)
    if (change.content && change.content.length > 500_000) {
      throw new Error(
        `Conteúdo bloqueado por tamanho excessivo: ${change.path} (${(change.content.length / 1024).toFixed(0)}KB)`
      );
    }
  }
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
