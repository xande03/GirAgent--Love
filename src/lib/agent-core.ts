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
  if (wantsAdd && isReference) return "add-to-project";
  return "reference-only";
}

export function assetPath(fileName: string) {
  const safe = fileName.replace(/[^\w.-]+/g, "-").toLowerCase();
  return `public/uploads/${safe}`;
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

Formato:
{
  "reasoning": "análise da estrutura e do encaixe da mudança (markdown curto)",
  "summary": "resumo do que foi feito, em markdown, para o usuário",
  "commitMessage": "mensagem de commit curta e imperativa",
  "needsClarification": false,
  "question": "pergunta apenas se needsClarification for true",
  "changes": [
    { "path": "src/routes/index.tsx", "action": "upsert", "content": "conteúdo completo do arquivo" }
  ]
}

Se o pedido for ambíguo ou destrutivo demais, retorne needsClarification: true, changes: [] e uma pergunta objetiva.`;
}
