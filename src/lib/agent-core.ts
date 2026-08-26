export type ImageIntent = "add-to-project" | "reference-only";

const ADD_PATTERNS = [
  /adicion\w*\s+(a|as|essa|esta|essas|estas|a\s+imagem|as\s+imagens|o\s+arquivo)/i,
  /(imagem|imagens|logo|foto|banner|ícone|icone|print)[^.]{0,40}(no|ao|dentro do|para o|à)\s+projeto/i,
  /(inserir|insira|inclua|incluir|coloque|colocar|suba|subir|use|usar|salve|salvar)[^.]{0,40}(imagem|imagens|logo|foto|banner|ícone|icone)[^.]{0,40}(no|ao|dentro do|para o|como)\s+(projeto|repositório|repositorio|assets|pasta|site|página|pagina|código|codigo)/i,
  /(imagem|imagens)[^.]{0,30}(deve|devem)\s+(fazer parte|ser adicionad|ser inserid|ser us\w+ no projeto)/i,
];

const REFERENCE_PATTERNS = [
  /(observe|veja|olhe|analise|entenda|interprete|repare|note)[^.]{0,30}(imagem|imagens|anexo|print|captura)/i,
  /(conforme|como|de acordo com|segundo|baseado n\w+|se baseando)[^.]{0,30}(imagem|imagens|anexo|print|captura|mostra)/i,
  /(imagem|anexo)[^.]{0,20}(de|como)\s+(refer[êe]ncia|exemplo|modelo)/i,
];

/**
 * Decides whether attached images should be committed into the repository or
 * used only as visual reference for reasoning. Reference wins ties.
 */
export function classifyImageIntent(instruction: string): ImageIntent {
  const wantsAdd = ADD_PATTERNS.some((r) => r.test(instruction));
  const isReference = REFERENCE_PATTERNS.some((r) => r.test(instruction));
  if (wantsAdd && !isReference) return "add-to-project";
  if (wantsAdd && isReference) return "reference-only";
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
  const DANGEROUS_PATHS = [/^\.git\//, /^\.env(\.|$)/, /^\.ssh\//, /^id_rsa/, /^id_ed25519/];
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

Formato:
{
  "reasoning": "análise da estrutura e do encaixe da mudança (markdown curto)",
  "summary": "resumo do que foi feito, em markdown, para o usuário",
  "commitMessage": "mensagem de commit curta e imperativa",
  "needsClarification": false,
  "changes": [
    { "path": "src/routes/index.tsx", "action": "upsert", "content": "conteúdo completo do arquivo" }
  ]
}`;
}
