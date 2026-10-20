# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Este projeto usa [SemVer](https://semver.org/lang/pt-BR/).

**Como atualizar:** a distribuição é por tag do GitHub, sem npm. Atualizar é
mudar a tag no seu `package.json` de propósito e rodar os testes — nunca
acontece sozinho.

```bash
npm i -D github:rafaspol/vibecora-agent-handoff#<tag-ou-commit-revisado>
```

## [0.5.1] — 2026-10-20

### Corrigido

- Conciliação da abertura local-first com as melhorias públicas de isolamento de
  operações do ledger, persistência/recuperação de candidatos e evidências de
  integração, preservadas nesta versão.
- `start` dispensa consultas de PRs e release com `origin` local ou ausente por
  padrão. `start.externalSources` aceita `auto`, `always` e `never`; relatório
  informa a política e testes exercem as chamadas e sua ausência.
- Leitura compatível de composições históricas no ledger, preservadas como
  `legacyIntegration` / `legacy-unverified`, sem certificar prova nova.
- Documentado o procedimento para manter cópias vendorizadas rastreáveis e sem
  alterações locais silenciosas.

## [0.5.0] — 2026-09-24

Construída sobre a 0.4.2, na mesma linha.

### Adicionado

- Proveniência da aprovação. `task approve` passa a gravar quem registrou
  (`recordedBy`) e a base da aprovação (`approvalBasis`): `document` para
  `ledger:<caminho>` (conferido no ledger na hora), `delegation` para as
  referências de `tasks.delegationRefs`, e `conversation` para o resto. O
  `task list` e o `BOARD.md` marcam as aprovações declaradas. Aprovações
  antigas são classificadas pelo prefixo e aparecem como anteriores à
  proveniência.
- `tasks.delegationRefs` na configuração.

### Alterado

- **Quebra:** aprovação de base `conversation` exige `--approval-summary` (até
  280 caracteres) com a decisão do condutor. Sem ele, `task approve` falha.

### Compatibilidade

- Versões anteriores leem o ledger com os campos novos sem erro (o reducer
  antigo ignora campos que não conhece), mas não os mostram.

## [0.4.2] — 2026-09-24

Construída sobre a 0.4.1, na mesma linha.

### Corrigido

- A CLI saía com `process.exit` logo depois de escrever, e em pipe o Node
  escreve de forma assíncrona: `task list --json | …` entregava só os
  primeiros 64 KB e virava JSON inválido. Agora a saída espera `stdout` e
  `stderr` confirmarem a escrita; um leitor que fecha cedo (`| head`) não
  prende o processo, e os códigos de saída não mudam.

## [0.4.1] — 2026-09-24

Construída sobre a 0.4.0. Não inclui o que a `main` acumulou depois da 0.4.0
e ainda não foi publicado (candidato recuperável antes de `ready`, integração
equivalente, isolamento do cache do ledger).

### Adicionado

- `task reject <proposal-id> --reason <motivo> --rejection-ref <ref>`: a recusa
  de uma proposta, registrada como `proposal_rejected` com autor, referência,
  motivo e data. A inclusão recusada leva o rascunho ao estado `rejected`, que
  sai dos rascunhos e entra no histórico; remoção e reordenação recusadas
  deixam a fila intacta. `task list`, a projeção e o `BOARD.md` ganham a seção
  de recusas.

### Compatibilidade

- Versões anteriores falham ao ler um ledger com `proposal_rejected` (evento
  desconhecido). Atualize todos os consumidores antes da primeira recusa.

## [0.4.0] — não publicada

### Adicionado

- Fila única derivada de ledger Git append-only, com estados `draft`,
  `approved`, `active`, `ready`, `done` e `removed`.
- Propostas de inclusão, remoção e reordenação em duas etapas; aprovação exige
  referência estável e `task propose` não muda a fila.
- Seleção por dependências, claim concorrente com um único vencedor e saída
  humana/JSON gerada pelo mesmo reducer.
- Resultado atrasado preservado como candidato alternativo, associado ao claim
  anterior e ao merge-base calculado.
- Impedimentos registráveis sem alteração silenciosa da posição da tarefa.
- Medição apenas em `task next`, cache local de 15 minutos e valores
  indisponíveis representados como `unknown`.
- Checkpoint AES-256-GCM quando qualquer recurso conhecido chega a 20% ou menos,
  com teto de 25 MiB, recusa de credenciais e restauração em worktree isolada.
- Origem imutável com data e identidade estruturada do agente, idade calculada
  na leitura, data de entrada na fila e autoria da implementação vencedora.

### Alterado

- Claims usam `{ type, id }` em vez de responsável textual. Flags explícitas,
  ambiente padrão e `CODEX_THREAD_ID` resolvem a identidade sem prosa manual.
- A projeção do quadro de tarefas passa à versão 2.

### Segurança

- Chave fora do ledger; chave errada, adulteração, credenciais e artefatos acima
  do teto são recusados.

## [0.3.2] — 2026-09-08

### Adicionado

- `docs/context.md` — como escrever o arquivo de contexto do projeto
  (`AGENTS.md` e equivalentes) para carregar só o que não é dedutível do código,
  com a evidência que sustenta o corte e o método para não perder guardrail.
- `docs/AGENTS.example.md` — um modelo para copiar e adaptar, no formato que
  este handoff pressupõe, mais a tabela do que cortar primeiro.

Nenhuma mudança de código. A CLI não escreve nem edita o `AGENTS.md` do seu
projeto: os dois documentos são orientação, e os sete comandos funcionam igual
sem eles.

## [0.3.1] — 2026-09-08

### Alterado

- README reescrito em formato de referência técnica: "o que faz" em uma frase,
  o problema em tabela, e comandos, detectores, configuração e travas em tabelas
  e blocos de código. A versão anterior contava as motivações como narrativa.
  Nenhuma mudança de código — só documentação.

## [0.3.0] — 2026-09-08

A abertura da sessão passa a medir o estado, em vez de só imprimir o retrato.

### Adicionado

- **`start`, o sétimo comando.** Mede antes de você acreditar: trabalho aberto
  no remoto, relação do commit do retrato com a linha publicada, travas
  apagadas, estado publicado. Dá um veredito e **só então** chama o `brief` —
  nessa ordem, porque o retrato é a fonte mais fraca. Sai 1 quando bloqueado.
  Nada é escrito; tudo que toca a rede tem teto de tempo.
- **Cinco detectores, três bloqueantes** (`queue_hidden`, `snapshot_stale`,
  `constraint_dropped`) e dois informativos (`production_unverified`,
  `remote_ahead`). A regra pura vive em `src/opening.mjs`, sem E/S.
- **`.agents/constraints.yaml`** — as travas que não pertencem a nenhum retrato.
  Acrescentar é livre; remover exige mover o id para `retired` com o motivo.
  O `init` passa a criar o arquivo.
- **`gitFacts`**: `remoteHeads`, `fileHistoryShas`, `fileAtCommit`,
  `countCommitsBetween` e `snapshotRelation` (que mede as **duas** direções).
- `files.constraints` e `start.constraintsHistoryLimit` na configuração;
  `.agents/constraints.yaml` entra na classe `state` por padrão.

### Corrigido

- As leituras de Git que tocam a rede ganharam teto de tempo com `SIGKILL`. Sem
  ele, um remoto que aceita a conexão e não responde pendurava o processo —
  inclusive no `audit`, que já tinha esse buraco.
- `--recorded-at` passa a aparecer no `--help`. Era funcional e nunca esteve
  documentado.
- README e `docs/adoption.md` mandavam instalar `#v0.1.0` desde que a v0.1.0
  saiu.

### Notas

- Um retrato **à frente** do publicado (trabalho local ainda não pushado) não
  bloqueia; só a divergência de verdade bloqueia. Medir uma direção só foi o
  primeiro erro desta regra, e ele apareceu na primeira abertura real.
- Um projeto **sem retrato ainda** também não bloqueia — quem acabou de rodar
  `init` não pode ser reprovado pela ferramenta que está adotando.
- O formato do retrato **não mudou**: continua `version: 3`.

## [0.2.0] — 2026-09-08

### Corrigido

- O cruzamento `run_completed.commit` × retrato aceita **ancestralidade**, e não
  só igualdade. `new` grava o HEAD do momento e `finalize` é idempotente, então
  qualquer commit feito depois de gravar reprovava um retrato honesto. A saída
  praticada era inventar um `run_id` com sufixo. `mainContains` continua
  guardando a honestidade sobre `merged_main`.

## [0.1.3] — 2026-09-01

### Alterado — **quebra compatibilidade**

- `references/` virou `docs/`, e o `SKILL.md` saiu do repositório e da lista
  `files`. A skill não era carregável por nenhum agente: só existia dentro do
  pacote instalado, e nenhum agente descobre skills nesse caminho.
- **Se você linkava `node_modules/vibecora-agent-handoff/references/*`, esses
  caminhos deixaram de existir.** Foi o que aconteceu com o projeto de origem, e
  ninguém percebeu por semanas.

## [0.1.2] — 2026-08-31

### Adicionado

- `new --extra-class <c>` e `classify.recordAlsoTouches`, para o caso em que um
  passo posterior do fechamento toca arquivos que o `new` ainda não viu.

## [0.1.1] — 2026-08-31

### Corrigido

- Ancestralidade bidirecional no `audit`: retrato e deploy que diferem só por
  commits sem runtime deixam de ser reportados como divergência.
- `--help` sai 0. Comando desconhecido continua saindo 1.
- `audit.releaseBaseUrl` aceita valor literal na config, além da variável de
  ambiente.

## [0.1.0] — 2026-08-31

Primeira versão. Contrato de handoff v3 extraído para ferramenta pública: CLI
com seis comandos, schema versionado, verificação offline, reconciliação
conectada, adaptador de plataforma e verificador de termos proibidos.
