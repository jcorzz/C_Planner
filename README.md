# C_Planner

Primeiro protótipo da visão global do time, com a Tabela do Time como tela inicial.

## Executar

Com Node.js instalado e disponível no `PATH`:

```powershell
npm install
npm run dev
```

`npm run desktop` abre a versão compilada no Electron. Para gerar o instalador Windows, use o incremento padrão de melhoria/hotfix (`c`):

```powershell
npm run package:win
```

## Rotina de liberação

Toda alteração segue este fluxo: alinhar e confirmar o escopo; implementar e validar tecnicamente; gerar a build portátil; testar os critérios de aceite no computador; aguardar aprovação explícita; e somente então preparar a versão e o instalador.

Para gerar ou atualizar a versão portátil de teste:

```powershell
npm run desktop:test
```

Feche a versão de teste que estiver aberta antes de executar o comando. Depois, execute `teste-local-atualizado/win-unpacked/C_Planner.exe`. Mantenha toda a pasta `win-unpacked` junto; não copie apenas o `.exe`. Reexecute o comando para atualizar a cópia de teste. Esse fluxo não cria instalador nem incrementa a versão.

A build portátil usa um perfil de dados separado em `%APPDATA%/C_Planner-Teste`; seus testes não devem alterar os dados do C_Planner instalado. O perfil de teste é preservado entre atualizações da pasta portátil. Não apague esse perfil durante a rotina.

Teste os critérios de aceite combinados e os fluxos diretamente relacionados à alteração. Se houver falha, ajuste o desenvolvimento, gere novamente a build portátil e repita a validação. Registre a aprovação antes de iniciar a publicação.

O número da versão segue `a.b.c`: `a` para mudanças arquiteturais, `b` para novas funcionalidades e `c` para melhorias ou hotfixes. O comando padrão incrementa `c`; use estes comandos quando a entrega for uma nova funcionalidade ou mudança arquitetural:

```powershell
npm run package:win:minor
npm run package:win:major
```

Cada comando atualiza a versão em `package.json` e `package-lock.json` antes de empacotar. Após a aprovação do teste, determine o incremento adequado, atualize `changelog.json` com a versão resultante e as alterações liberadas, e execute o comando de empacotamento correspondente. O instalador recebe essa versão no nome, por exemplo `release/C_Planner Setup 0.1.1.exe`; o executável unpacked fica em `release/win-unpacked/C_Planner.exe`.

## Atualização automática e GitHub Releases

O aplicativo instalado verifica atualizações do repositório público `jcorzz/C_Planner` ao iniciar e baixa versões publicadas em segundo plano. Quando o download terminar, o aplicativo pede confirmação para reiniciar e instalar. Se a verificação falhar, ele continua funcionando com os dados atuais e mostra um aviso. Builds de desenvolvimento e a versão portátil de teste não verificam atualizações.

Antes de instalar uma atualização, o aplicativo grava uma cópia JSON de todas as chaves do armazenamento local em `backups` dentro do perfil de dados do C_Planner. O perfil e o identificador do aplicativo permanecem estáveis entre versões; os backups não são removidos automaticamente.

Após testar e aprovar uma versão, atualize `changelog.json`, incremente a versão com o comando apropriado e envie as alterações. Crie e envie uma tag que corresponda exatamente à versão em `package.json`, no formato `v<versão>` (por exemplo, `v1.0.0`). A GitHub Action em `.github/workflows/release.yml` gera o instalador Windows e publica no Release os arquivos necessários para o atualizador. A tag deve apontar para o commit que contém a versão correspondente.

## Changelog

As notas publicadas ficam em `changelog.json`. Adicione uma entrada por versão, com a data de publicação e uma lista de alterações:

```json
[
	{
		"version": "0.1.1",
		"date": "2026-11-25",
		"changes": ["Resumo da alteração liberada"]
	}
]
```

A tela acessada pelo botão de histórico no topo mostra as notas em ordem decrescente e somente a versão instalada. Essa informação é fornecida pelo aplicativo Electron; no navegador comum, ela não está disponível.

## O que já pode ser testado

- Cadastro e edição de projetos e entregáveis.
- Exclusão de projetos com confirmação, remoção de dados exclusivos e transferência de atividades compartilhadas.
- Fases próprias por projeto, com entregáveis associados e Backlog sempre no fim da sequência.
- Registro editável do início real da atividade, preenchido automaticamente quando ela entra em andamento.
- Fluxograma com o início do plano à esquerda e faixas apenas para fases planejadas; itens em Backlog ficam fora do fluxograma.
- Atividades compartilhadas entre fases aparecem em cada faixa correspondente, mantendo um único registro.
- Filtro de fase após selecionar projeto e agrupamento da tabela por projeto/fase.
- Atividades executadas pelo time interno, com alocação opcional de pessoas, ou por um ou mais times externos cadastrados em Configurações.
- Filtro de time na tabela e identificação resumida dos times externos nos blocos do fluxograma.
- Cada atividade pode ser associada a um ou mais entregáveis; reutilizar uma atividade em outro entregável é uma ação explícita de compartilhamento.
- Exclusão confirmada de atividades pela tabela e pelo bloco do fluxograma.
- Fluxograma em branco até selecionar explicitamente o projeto e o entregável do plano.
- Arraste blocos diretamente; segure Espaço e arraste o canvas para navegar.
- Use o botão azul “+” ao lado de um bloco para criar a próxima atividade conectada.
- Reabrir o plano mantém as posições manuais; “Organizar” aplica o layout automático novamente.
- Filtros por projeto, pessoa, status e data, além de agrupamento por pessoa.
- Exportação e importação de backup JSON.
- Importação de feriados a partir de arquivos `.ics`.
- Navegação inicial entre tabela, projetos, pessoas, notificações e configurações.

## Limites deste protótipo

Os dados ficam no armazenamento local do Electron e podem ser apagados ao limpar os dados do aplicativo. A persistência atual ainda não usa um banco de dados estruturado. O próximo trabalho funcional inclui cálculo automático de datas com dependências e disponibilidade, estimativas PERT por pessoa, histórico de replanejamento e notificações.

Datas de feriados são importadas de eventos de dia inteiro em `.ics`; a prévia completa do calendário e suporte a recorrências serão refinados na etapa de calendário.

O audit do npm reporta vulnerabilidades em dependências de desenvolvimento/empacotamento. A correção automática sugerida exige alterações fora das versões principais atuais e deve ser avaliada antes de atualizar.