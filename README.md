# AI Code Weaver

crie uma pagina web para desenvolvedores de projeto do GitHub. O objetivo é gerenciar, manipular, modificar e corrigir projetos do GitHub conforme a necessidade do usuário (solicitadas) a partir de agente de ia. O projeto deve ser clonado a partir do token de usuário e url do repositório. A partir disso o agente irá reconhecer todo o projeto e seus arquivos.. Após isso irá ser liberado um imput para usuários informarem o que deseja ser alterado, adicionado ou corrigido, e então o agente entrará em cena para modificar o projeto de forma que seja em "mian" e nao branch". O  arquivo principal sendo modificado. O comit com o "get push main" deve ser automático. Deve conter botão de enviar anexos com drag-dop 

1. entenda as diferenças do envio de imagem pelo usuário. Somente quando o usuário solicitar que a imagem deve fazer parte do projeto ou adicionada ao projeto, que o agente pode enfim adicionar ao projeto. Se o usuário enviar uma mensagem e com ela, em anexo uma imagem, dizendo pro exemplo "observe na imagem..." ou "entenda a imagem em anexo..." ou "faça conforme mostra a imagem..." e entre outros tipos; se baseando nesta proposta, a imagem não deve ser inserida no projeto e sim, entendida como referencia para algum raciocínio ou solicitação do usuário 

2, quando o agente reproduzir uma mudança conforme o usuário solicito, o agente deve observar e entender a estrutura ou o contexto do projeto e dos arquivos, para que um "converse" com o outros. Ex: uma frase de "olá mundo" está em uma arquivo index.tsx para ser mostrada na área principal do layout, porém ela não está sendo referenciada ou está posta em um local desapropriado ou sem concordância nenhuma com os demais arquivos . Por isso deve ser entendia toda a estrutura 

3. melhore o motor gráfico (LLM) para que aja semelhante aos motores gráficos e ambientes de desenvolvimento de VIBECOER como a Lovable, [Bolt.new](http://Bolt.new), Base44 entre outros . Usando o raciocínio e redes neurais adaptativas 

chave api deepseek v4 flash: sk-ipr1olqfhj5q3f722x8egejwafiofgrl
url: https://api.b.ai/v1

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/fce7e8ad-5d66-46b5-9fd2-d01092af9188).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
