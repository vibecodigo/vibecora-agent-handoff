# vibecora-agent-handoff

[![CI](https://github.com/rafaspol/vibecora-agent-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaspol/vibecora-agent-handoff/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-informational)
![Licença](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)

**O que faz:** mede o estado real do repositório **antes** de a sessão de um
agente começar, mantém uma fila compartilhada e prepara continuidade preventiva
quando um recurso conhecido está perto do limite. Um contrato entre agentes de
código — Claude Code, Codex, Cursor, ou você.

CLI em Node, sem build, sem framework de teste, uma dependência de runtime.

## O problema

Passar contexto entre sessões de agentes por um resumo escrito à mão falha de
três formas, todas observadas em produção:

| Falha | Por quê |
|---|---|
| O resumo correto engana | Ele é imutável e correto sobre o instante em que foi gravado. Lido como estado atual, esconde tudo o que aconteceu depois — commits, branches, PRs. |
| O fechamento tem verificação, a abertura não | O CI reprova um resumo inconsistente; começar a sessão é uma frase de boa vontade num arquivo de instruções. |
| Decisões somem na troca do arquivo | "Este comportamento é intencional", "esta peça parece morta e não está" — moram na lista de pendências e vão junto no próximo merge. |

Nenhuma se resolve pedindo ao agente que escreva melhor. As três são
verificáveis por medição.

## Como resolve

**Precedência de fontes**, da mais forte para a mais fraca:

```
medição ao vivo  >  travas versionadas  >  retrato  >  telemetria
```

O retrato é **intenção**; a medição é **estado**. Onde discordarem, vale a
medição.

- **Abertura** (`start`) — mede o remoto, a ancestralidade do commit do retrato,
  as travas e o estado publicado; dá um veredito; **depois** imprime o retrato.
- **Fechamento** (`new` → `finalize` → `check`) — você escreve a narrativa numa
  entrada; o retrato é **gerado** derivando do Git o que é derivável; um evento
  append-only registra o run; a verificação é offline e determinística.

O retrato nunca é editado à mão.

## Instalação

```bash
npm i -D github:rafaspol/vibecora-agent-handoff#<tag-ou-commit-revisado>
```

Node ≥ 20 e Git. `gh` é opcional — sem ele, PRs abertas não são lidas e a saída
diz isso. Distribuição por tag do GitHub, sem npm; atualizar é trocar a tag.

## Uso

```bash
npx vibecora-handoff init             # config + entrada + travas
git add .agents && git commit -m "adota o handoff"

npx vibecora-handoff start            # abre a sessão: mede, dá veredito, mostra o retrato
# ... trabalho; edite .agents/handoff.input.yaml ...
npx vibecora-handoff new              # gera o retrato
npx vibecora-handoff finalize         # grava o run_completed
npx vibecora-handoff check            # verifica; sai 1 se inconsistente

npx vibecora-handoff task list        # fila, bloqueios, histórico e rascunhos
npx vibecora-handoff task next --agent-type codex --agent-id <instância>
```

Saída do `start`:

```
── medido ──
  clone        f1f6408 (main)
  retrato      2f29d5c — contained em relação ao publicado
  publicado    2f29d5c
  remoto       lido — 0 branch(es) ausente(s), 0 PR(s) aberta(s)
  travas       7

LIVRE — o estado medido não contradiz o retrato.
```

**Commitar o `constraints.yaml` não é opcional.** O detector de travas compara o
arquivo com os ids que já existiram no histórico Git dele; sem commit, não há
com o que comparar e ele fica inerte.

## Comandos

| Comando | Faz | Rede | Escreve | Sai 1 |
|---|---|---|---|---|
| `init` | cria config, entrada e travas; não sobrescreve | — | sim | — |
| `start` | mede a abertura, dá veredito, chama o `brief` | leitura | — | bloqueado |
| `new` | regenera o retrato do Git + entrada | — | sim | entrada inconsistente |
| `brief` | visão compacta do retrato | — | — | retrato ilegível |
| `finalize` | acrescenta um `run_completed` (idempotente) | — | sim | retrato inválido |
| `check` | valida schema, Git, histórico e cruzamentos | — | — | inconsistente |
| `audit` | reconcilia com GitHub, release e plataforma | leitura | — | — ¹ |
| `task list` | projeta a fila canônica, bloqueios, histórico e rascunhos | leitura | — | erro |
| `task propose` | grava proposta; nunca altera a fila aprovada | escrita | ledger | erro |
| `task approve` | aplica proposta com referência, base e registrante da aprovação | escrita | ledger | conflito |
| `task reject` | recusa proposta com motivo e referência; nada na fila muda | escrita | ledger | conflito |
| `task next` | mede recursos, arma se preciso e reivindica a próxima | escrita | ledger | conflito |
| `task arm` | força checkpoint preventivo da tarefa ativa | escrita | ledger | conflito |
| `task resume` | mostra retomáveis ou transfere para worktree isolada | leitura/escrita | ledger/worktree | conflito |
| `task finish` | registra `ready`; após integração verificável, `done` | escrita | ledger | erro |
| `task block/unblock` | registra ou limpa impedimento sem reordenar | escrita | ledger | erro |

¹ `audit` é relatório, não gate: sai 0 mesmo apontando divergência.

Flags: `--json` (`start`, `brief`, `check`, `finalize`, `task`), `--config <path>`,
`--result <r>`, `--recorded-at <iso>`, `--extra-class <c>`. Ações de tarefa
resolvem `--agent-type/--agent-id`, depois `VIBECORA_AGENT_TYPE/_ID` e, no
Codex, `CODEX_THREAD_ID` automaticamente.
Saída 2 é reservada para "não deu para rodar" (config ilegível, arquivo
corrompido).

## Detectores da abertura

| Detector | Bloqueia | Dispara quando |
|---|---|---|
| `queue_hidden` | **sim** | há PR aberta, ou branch no remoto ausente do clone |
| `snapshot_stale` | **sim** | o commit do retrato divergiu da linha publicada |
| `constraint_dropped` | **sim** | uma trava sumiu do arquivo sem ir para `retired` |
| `production_unverified` | não | o estado publicado não foi consultado |
| `remote_ahead` | não | o remoto está à frente do clone |

Três decisões de desenho, cada uma com teste simétrico e mutação:

- **`remote_ahead` não bloqueia.** Remoto à frente é o estado normal de quem não
  deu `pull`; um alarme que dispara sempre é contornado por reflexo.
- **Ancestralidade é bidirecional.** Retrato *à frente* do publicado é trabalho
  local não pushado, não divergência. Só `diverged` bloqueia; `null` (não medido)
  também não.
- **Retrato ausente informa; retrato sem commit bloqueia.** Projeto recém-adotado
  não é retrato quebrado.

**Regra de desligamento:** se um bloqueio atrapalhar duas vezes sem razão,
desligue-o e deixe só o relatório — não recalibre. Detector que vira ritual de
contorno não mede nada.

## Travas (`constraints.yaml`)

Decisões que não pertencem a nenhum retrato. Versionadas, fora do ciclo.

```yaml
version: 1
constraints:
  - id: polaridade-invertida        # kebab-case, único
    resumo: >                       # o que é
      O contraste invertido nesta tela é intencional.
    porque: >                       # por que não é bug
      Medido contra as referências e escolhido assim mesmo.
    fonte: "ADR 0007"               # onde verificar
retired: []                         # { id, motivo, em } — remover exige passar por aqui
```

Acrescentar é livre. Remover sem aposentar bloqueia a próxima abertura.
Tarefa não entra aqui: com o sistema de tarefas habilitado, ela vive no ledger
privado e o retrato apenas referencia o trabalho corrente quando necessário.

## Configuração

`.agents/handoff.config.json`, mesclada em profundidade sobre os defaults —
**listas substituem**:

```jsonc
{
  "git":   { "mainRef": "main" },
  "files": { "handoff": ".agents/handoff.yaml", "constraints": ".agents/constraints.yaml" },
  "classify": {
    "rules": [{ "class": "runtime", "match": ["app/**", "package.json"] }],
    "unknownClass": "runtime"
  },
  "audit": { "releaseBaseUrl": null, "releaseBaseUrlEnv": "HANDOFF_AUDIT_BASE_URL" },
  "tasks": {
    "enabled": false,
    "project": null,
    "ledger": null,
    "thresholdPercent": 20,
    "measurementCacheMinutes": 15
  }
}
```

- `classify.rules` é ordenada: a primeira que casar decide. É o que mais varia
  entre projetos.
- Mudou `files.*`? Mude `classify.rules` junto — senão os arquivos do handoff
  caem em `unknownClass` e o `check` reclama.
- `files.friction`, `files.roadmap` e `platform` são **declarativos**: nenhum
  comando os lê.

Roteiro completo em [`docs/adoption.md`](docs/adoption.md).

## Limites

- **Um handoff não autoriza nada.** Não é permissão para deploy, publicação ou
  ação externa. Deploy, rollback, smoke e gates de CI ficam no seu projeto.
- **O CLI não inventa medição.** Recursos não expostos de modo confiável pelo
  host aparecem como `unknown`; `task arm` cobre o caso manual.
- **Os comandos de handoff e tarefas rodam em qualquer projeto; o `audit` não.** Ele assume a
  plataforma Quave One e um `GET /api/release`. Em outra plataforma reporta a
  fonte como indisponível para sempre, e adaptar significa trocar
  `src/quave/adapter.mjs` — não há mecanismo de plugin.
- **Nada verifica a qualidade da narrativa.** O mecanismo protege o que é
  verificável — commits, branches, ids, ancestralidade. A prosa é sua.
- Sem npm, tudo em português, sem promessa de suporte.

## Proteção de informação

`npm run check:forbidden` varre arquivos **e histórico de commits** contra a
lista em `HANDOFF_FORBIDDEN_TERMS` (não versionada). Serve a quem **extrai** uma
ferramenta de um projeto privado — nome, domínio, identificadores de ambiente de
produtos ainda não lançados. Sem a variável definida, ele não protege nada e diz
isso.

## Documentação

| Arquivo | Para quê |
|---|---|
| [`docs/schema.md`](docs/schema.md) | contrato completo do retrato (`version: 3`) |
| [`docs/adoption.md`](docs/adoption.md) | adotar num projeto ou migrar de scripts próprios |
| [`docs/diagnostics.md`](docs/diagnostics.md) | um comando reprovou e você quer saber por quê |
| [`docs/context.md`](docs/context.md) | enxugar o `AGENTS.md` do seu projeto, e a evidência disso |
| [`docs/tasks.md`](docs/tasks.md) | fila, governança, medição e recuperação preventiva |
| [`docs/AGENTS.example.md`](docs/AGENTS.example.md) | um modelo de `AGENTS.md` para copiar |
| [`docs/quave-one.md`](docs/quave-one.md) | o adaptador de plataforma do `audit` |
| [`CHANGELOG.md`](CHANGELOG.md) | o que mudou entre as tags |

## Testes

```bash
npm test
```

107 testes, `node --test` puro, zero devDependencies. Os testes de comando rodam a
CLI de verdade contra repositórios Git temporários, com remoto bare local — os
casos de branch ausente e histórico divergente são exercidos sem tocar a rede.

## Licença

[MIT](LICENSE). Construído por um vibecoder para manter consistência entre
agentes diferentes; publicado porque pode servir a mais alguém.

---

Feito com erva-mate por Vibecora.

## Abertura local-first (0.5.1)

`start.externalSources` controla somente as consultas de PRs (`gh`) e de
`/api/release` na abertura:

| Valor | Comportamento |
|---|---|
| `auto` (padrão) | consulta com `origin` de rede; dispensa com caminho local, `file://` ou sem `origin` |
| `always` | habilita as consultas mesmo com `origin` local ou ausente |
| `never` | dispensa as consultas, inclusive com `origin` de rede |

```json
{ "start": { "externalSources": "auto" } }
```

O relatório informa a política e se as consultas foram habilitadas. Uma fonte
habilitada ainda pode estar indisponível; `external_read` não comprova que a
Produção foi verificada. A medição do `origin` continua ativa em todos os modos:
`never` não torna offline um `origin` de rede. `audit` é uma operação explícita
separada e não muda com esta configuração.

### Cópia vendorizada rastreável

Para incorporar a ferramenta sem depender de rede na instalação, copie os
arquivos distribuídos de uma tag/commit revisado, sem alterações locais. Guarde
fora da pasta copiada a URL, versão, commit de origem, lista de arquivos e seus
hashes. Confira esses hashes no gate do consumidor e rode os testes da ferramenta
e da integração antes de atualizar. Mudanças genéricas devem voltar ao projeto
público e resultar numa versão nova; não mantenha implementações diferentes com
o mesmo número de versão.
