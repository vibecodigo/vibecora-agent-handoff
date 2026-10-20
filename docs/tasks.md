# Fila compartilhada e continuidade preventiva

O ledger Git privado é a fonte canônica das tarefas. `events.jsonl` é
append-only; `board.json` e `BOARD.md` são projeções geradas pelo reducer. O
roadmap pode ser referenciado por uma tarefa, mas não replica posição,
responsável nem estado.

## Fluxo

```bash
# leitura canônica, também disponível em --json
npx vibecora-handoff task list

# descoberta: cria rascunho e proposta, sem mudar a fila
npx vibecora-handoff task propose add \
  --task-id corrigir-login --title "Corrigir login" \
  --objective "Restaurar o login" --done-when "Fluxo verificado" \
  --suggested-rank 2 --reason "Falha reproduzida" \
  --agent-type codex --agent-id <instância>

# somente após aprovação explícita do condutor; quem registra se identifica
npx vibecora-handoff task approve <proposal-id> \
  --approval-ref "codex-thread:<referência-estável>" \
  --approval-summary "O que o condutor decidiu, em uma frase" \
  --agent-type codex --agent-id <instância>

# ou a recusa, com o motivo e onde o condutor a decidiu
npx vibecora-handoff task reject <proposal-id> \
  --reason "Duplica outra tarefa" \
  --rejection-ref "codex-thread:<referência-estável>"

# reivindica a primeira tarefa executável
npx vibecora-handoff task next --agent-type codex --agent-id <instância> \
  --quota-remaining 18 --context-remaining unknown
```

`task propose remove` exige `--consequence`. `task propose reorder` exige
`--suggested-rank`. Nenhuma das duas altera a fila antes de `task approve`.
Dependências são repetidas com `--depends-on`.

### Proveniência da aprovação

`task approve` grava `approvedBy: <condutor>` e a referência, como sempre, e
também **quem registrou** (`recordedBy`, a identidade do agente, quando
informada) e **em que a aprovação se apoia** (`approvalBasis`):

| Base | Referência | Exigência |
|---|---|---|
| `document` | `ledger:<caminho no ledger>` | o arquivo existe no ledger na hora do registro |
| `delegation` | uma referência listada em `tasks.delegationRefs` | — |
| `conversation` | qualquer outra (conversa, quiz, thread) | `--approval-summary` com a decisão do condutor, até 280 caracteres |

Só `document` é algo que o sucessor abre. As outras duas são **declaradas** por
quem registrou: o `task list` e o `BOARD.md` dizem isso na linha da tarefa
(`aprovação declarada (conversa; codex:abc12345)`). Nada disto prova que o
condutor aprovou; o que muda é que o texto autodeclarado deixa de se passar por
autenticação. Aprovações anteriores a este registro são classificadas pelo
prefixo da referência e aparecem como `registro anterior à proveniência`, sem
reescrever o histórico. A projeção do quadro (`boardProjection`) não muda.

`task reject` é a outra resposta à mesma proposta, e também só registra decisão
do condutor. Exige `--reason` e `--rejection-ref`; grava `proposal_rejected`
com autor, referência, motivo e data, sem apagar nada. A inclusão recusada leva
o rascunho a `rejected`, que sai dos rascunhos e aparece no histórico; recusar
remoção ou reordenação deixa a fila como estava. Proposta decidida, aprovada
ou recusada, não aceita outra decisão, e o id de uma tarefa recusada não volta
a ser proposto: uma nova tentativa usa id novo. `task list` mostra as recusas
em seção própria.

**Compatibilidade.** Um reducer anterior à 0.4.1 recusa evento desconhecido, e
um único `proposal_rejected` no ledger derruba a leitura da fila em todo clone
que ainda estiver numa versão anterior. Atualize os consumidores do ledger
antes da primeira recusa.

A identidade vem primeiro de `--agent-type/--agent-id`, depois de
`VIBECORA_AGENT_TYPE/VIBECORA_AGENT_ID`. No Codex, `CODEX_THREAD_ID` é detectado
automaticamente. Tipo e instância são obrigatórios para criar ou reivindicar.

Cada tarefa expõe a data e o agente de origem, `queuedAt` após aprovação,
claims estruturados e `implementedBy` quando chega a `ready`. `task list`
calcula a idade em dias completos a partir da origem, sem reordenar ou remover:
antiguidade só pode motivar uma proposta sujeita à aprovação normal.

Um impedimento factual é registrado com
`task block --task-id <id> --reason <motivo>` e removido com `task unblock`.
Isso não muda a posição da tarefa.

## Estados

`draft` → `approved` → `active` → `ready` → `done`; `draft` → `rejected` quando a
inclusão é recusada. Uma remoção aprovada leva
a `removed` sem apagar o histórico. Bloqueio é derivado de dependências não
concluídas ou de impedimento registrado; não muda a prioridade.

## Recursos e checkpoint

A medição só ocorre em `task next` e é reutilizada por até 15 minutos. Valores
devem vir de uma fonte confiável do host; o que não puder ser medido fica
`unknown`. Se qualquer recurso conhecido estiver em 20% ou menos, um checkpoint
cifrado é persistido no mesmo commit do claim, antes de a tarefa ser liberada.

`task arm --agent-type <tipo> --agent-id <id> --claim-epoch <n>` força um checkpoint da tarefa ativa. `task resume` mostra os casos
retomáveis; `task resume --claim <id> --agent-type <tipo> --agent-id <id>` restaura o estado em uma
worktree isolada e só então conclui a transferência no ledger. Claims
concorrentes usam push fast-forward: há um vencedor.

Os checkpoints usam AES-256-GCM e uma chave de 32 bytes em
`VIBE_CORA_TASK_KEY` ou, por padrão,
`~/.config/vibecora-agent-handoff/task-key`. A chave nunca pertence ao ledger.
Arquivos de credencial são recusados e o artefato cifrado não pode exceder
25 MiB.

## Fechamento

```bash
# árvore limpa; persiste HEAD no origin (ou --candidate-repository <repo>)
npx vibecora-handoff task finish --task-id <id> \
  --agent-type <tipo> --agent-id <id> --claim-epoch <n>

# depois de o commit candidato estar em main/origin/main
npx vibecora-handoff task finish --task-id <id> --integrated
```

`ready` significa concluída e verificada, aguardando integração. `done` exige
ancestralidade Git verificável, ou equivalência de patch explicitamente verificada.

### Integração por ancestralidade ou patch equivalente

O modo padrão `finish --integrated` exige que o próprio `candidateCommit` seja
ancestral do main escolhido. Nunca escolhe silenciosamente entre main local e
tracking refs divergentes: nesse caso informe, por exemplo,
`--integration-main-ref refs/heads/main` ou
`--integration-main-ref refs/remotes/origin/main`. O nome da branch vem de
`git.mainRef` (padrão `main`); somente essas refs completas da branch configurada
são aceitas, não SHA, tags ou expressões Git. A verificação é local: atualize
explicitamente o clone antes; o comando não faz fetch/push nem modifica main.

Para cherry-pick ou rebase que preservou o patch:

```bash
npx vibecora-handoff task finish --task-id <id> --integrated \
  --integrated-commit <SHA-completo-do-commit-integrado> \
  --integration-evidence 'review:referencia-da-revisao' \
  --integration-main-ref refs/remotes/origin/main
```

O commit integrado deve ser ancestral da ref escolhida. Ambos os commits devem
ter exatamente um pai e diff não vazio; merges, commits raiz, squash de vários
commits e resolução que altere o patch não são suportados nesse modo.
O comando calcula independentemente `git patch-id --stable` dos diffs binários
com hashes completos, sem external diff/textconv/renames, e exige igualdade.
Isso é equivalência segundo patch-id (que normaliza whitespace), não uma
afirmação de identidade de árvore ou de comportamento em outro contexto.
A evidência é referência de revisão, nunca substitui a prova Git.

O evento `task_done.integration` e a projeção histórica retêm candidato,
commit integrado, modo (`ancestry`/`patch-equivalent`), ref e tip verificados,
patch hash e evidência. Ancestralidade preserva suporte a merges/raiz/vazios:
nesses casos patchHash pode ser null. Eventos done antigos permanecem legados,
com integração null, sem inventar verificações históricas.

Com metadados recuperáveis, o clone deve ter um remote cuja URL de **fetch**
seja exatamente `candidate.repository`; URLs alternativas/aliases não são
assumidas equivalentes. Só tracking refs desses remotes são elegíveis.
Se salvou o candidato em repositório separado, use um clone desse repositório
ou configure explicitamente um remote correspondente e a main pretendida antes
de verificar. Uma URL apenas de push não autentica tracking refs. Tarefas ready
legadas ainda podem ser verificadas com objetos locais, sem fabricar metadados
de recuperação. Nenhum modo faz cherry-pick/merge/push ou escreve credenciais.

Antes de registrar `ready`, `finish` envia apenas
`refs/vibecora/candidates/<projeto>/<tarefa>/<SHA>` ao repositório candidato e
confirma o SHA remoto. Não usa force, não envia main nem tags. O destino
padrão é a URL de push de origin; `--candidate-repository` permite salvar em
outro repositório. A URL gravada não pode conter senha, token, query ou usuário
HTTPS; autentique por credential helper/SSH. Use um repositório privado com
retenção dessas refs.

Após perder o clone original, recupere e verifique o candidato sem alterar
árvore, branch, claim ou ledger:

```bash
npx vibecora-handoff task recover --task-id <id> \
  --candidate-repository <repo-salvo> --json
```

`recover` valida projeto, tarefa, URL, namespace e hash antes de buscar a ref.
Eventos antigos sem `candidate` continuam legíveis, mas não são recuperáveis
por este comando. Se o ledger conflitar depois do push, a ref pode ficar órfã;
repetir o mesmo `finish` reutiliza a ref sem sobrescrever.

Se um agente antigo terminar depois da transferência, ele informa seu
`--claim-epoch`; o resultado é preservado como candidato alternativo com o
merge-base calculado, sem substituir o responsável atual.

## Configuração

### Isolamento e ciclo de vida do ledger

Cada operação usa um clone temporário privado, inclusive `list` e `resume`
sem claim. `cacheDir` (ou o caminho derivado de `VIBE_CORA_TASK_CACHE`) é
somente um namespace: o clone fica em um diretório irmão
`<cacheDir>.operation-<sufixo aleatório>`, criado atomicamente. Um cache antigo
ou conteúdo do chamador nesse caminho não é reutilizado, limpo ou sobrescrito.
Isso evita também corridas durante o primeiro clone. O custo é um clone por
operação, sem aceleração por cache compartilhado.

A pequena cache de medições permanece separada em
`<cacheDir>.measurements/<projeto>.json`, com substituição atômica de cada
amostra completa. Ela preserva a reutilização por quinze minutos, mas não
contém checkout, eventos nem checkpoints e não participa da transação Git.
Escritas concorrentes usam a última substituição concluída. Interrupção durante
uma escrita pode deixar um arquivo `.tmp`, removível manualmente quando não
houver comandos ativos; ele nunca é lido como amostra.

A revisão capturada não recebe fetch/reset durante a operação. Leituras,
checkpoint, redução e commit usam o mesmo snapshot; o push envia o SHA exato
do commit, sem force. Escritores concorrentes partindo da mesma revisão têm
no máximo um push aceito. Rejeição não gera confirmação de sucesso nem retry
automático. Uma falha de transporte pode ocorrer depois da aceitação remota:
o erro informa o SHA e é necessário consultar o ledger antes de repetir.

O CLI mantém o snapshot até concluir a operação e imprimir o resultado, e
o remove em `finally`, tanto em sucesso quanto em erro. `withLedger(config,
callback)` também aguarda callbacks assíncronos. Falha na remoção produz aviso
com o caminho, sem transformar um push confirmado em falha. A API de baixo
nível `syncLedger(config)` continua síncrona e retorna uma string, mas agora
sempre retorna um caminho privado novo: o chamador deve removê-lo ao terminar,
ou preferir `withLedger`. Não se deve compartilhar esse caminho entre operações.

Interrupções que impedem `finally` (inclusive SIGKILL, encerramento por sinal
ou queda do host) podem deixar clones órfãos. Não há lock, identificação por
PID, coleta automática nem reutilização desses diretórios; portanto um órfão
não bloqueia nem altera operações futuras e reutilização de PID é irrelevante.
Para limpeza manual, primeiro encerre os comandos que usam esse namespace e
remova apenas os diretórios `.operation-*` correspondentes. Não apague snapshots
de operações ativas. Um processo interrompido após o push também pode não ter
exibido confirmação: consulte o histórico remoto antes de tentar novamente.

```jsonc
{
  "tasks": {
    "enabled": true,
    "project": "meu-projeto",
    "ledger": "https://github.com/owner/estado-privado.git",
    "branch": "main",
    "conductor": "@usuario",
    "thresholdPercent": 20,
    "measurementCacheMinutes": 15,
    "maxCheckpointBytes": 26214400
  }
}
```

O ledger precisa existir e ter a branch configurada. O CLI não inicia agentes,
não consulta recursos sem uma fonte exposta pelo host e não autoriza deploy,
merge ou publicação.

### Evidência histórica de integração

Registros históricos `version: 1`, `mode: reviewed-composition` e método
`reviewed-candidate-manifest-and-composed-file-review` são preservados em
`legacyIntegration`, marcados `legacy-unverified`. Não são provas verificadas
pelo contrato atual. O comando de conclusão continua exigindo a verificação
atual; não produz esse formato histórico. Eventos antigos não são reescritos.
