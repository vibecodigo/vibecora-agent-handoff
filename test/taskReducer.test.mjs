import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boardProjection,
  boardView,
  proposalImpact,
  reduceTaskEvents,
  renderBoardMarkdown,
  taskAgeDays,
} from '../src/tasks/reducer.mjs';

const AGENT_A = { type: 'codex', id: 'agent-a' };
const AGENT_B = { type: 'codex', id: 'agent-b' };

let sequence = 0;
const event = (type, fields = {}) => ({
  id: `event-${++sequence}`,
  type,
  at: `2026-09-13T00:00:${String(sequence).padStart(2, '0')}Z`,
  ...fields,
});

function draft(id, rank, dependencies = []) {
  return event('task_drafted', {
    agent: AGENT_A,
    task: {
      id,
      title: `Tarefa ${id}`,
      objective: `Fazer ${id}`,
      doneWhen: `${id} verificada`,
      dependencies,
      suggestedRank: rank,
      roadmapRef: null,
    },
    proposal: {
      id: `proposal-${id}`,
      kind: 'add',
      taskId: id,
      suggestedRank: rank,
      reason: 'necessária',
    },
  });
}

const approve = (id) =>
  event('proposal_approved', {
    proposalId: `proposal-${id}`,
    approvedBy: '@rafaspol',
    approvalRef: `thread:${id}`,
  });

test('rascunho e task propose não mudam a fila aprovada', () => {
  const board = reduceTaskEvents([draft('a', 1)], { project: 'p' });
  assert.equal(board.tasks.a.status, 'draft');
  assert.deepEqual(board.queue, []);
  assert.equal(boardView(board).drafts.length, 1);
  assert.deepEqual(board.tasks.a.origin.agent, AGENT_A);
  assert.equal(board.tasks.a.origin.at, board.tasks.a.createdAt);
});

test('aprovação insere em posição única e calcula deslocados', () => {
  const events = [draft('a', 1), approve('a'), draft('b', 1)];
  const before = reduceTaskEvents(events, { project: 'p' });
  assert.deepEqual(proposalImpact(before, before.proposals['proposal-b']), {
    suggestedRank: 1,
    effectiveRank: 1,
    displaced: ['a'],
  });
  const after = reduceTaskEvents([...events, approve('b')], { project: 'p' });
  assert.deepEqual(after.queue, ['b', 'a']);
});

test('dependência bloqueia sem reordenar e expõe a próxima executável', () => {
  const board = reduceTaskEvents(
    [draft('a', 1, ['b']), approve('a'), draft('b', 2), approve('b')],
    { project: 'p' },
  );
  const view = boardView(board);
  assert.deepEqual(board.queue, ['a', 'b']);
  assert.equal(view.blockedPriorities[0].id, 'a');
  assert.equal(view.nextExecutable.id, 'b');
});

test('impedimento bloqueia sem alterar prioridade e pode ser limpo', () => {
  const base = [draft('a', 1), approve('a')];
  const impeded = reduceTaskEvents(
    [...base, event('task_impeded', { taskId: 'a', reason: 'aguarda decisão' })],
    { project: 'p' },
  );
  assert.deepEqual(impeded.queue, ['a']);
  assert.equal(
    boardView(impeded).blockedPriorities[0].blockers.impediment,
    'aguarda decisão',
  );
  const clear = reduceTaskEvents(
    [
      ...base,
      event('task_impeded', { taskId: 'a', reason: 'aguarda decisão' }),
      event('task_impediment_cleared', { taskId: 'a' }),
    ],
    { project: 'p' },
  );
  assert.equal(boardView(clear).nextExecutable.id, 'a');
});

test('remoção e reordenação só acontecem após aprovação e preservam história', () => {
  const initial = [draft('a', 1), approve('a'), draft('b', 2), approve('b')];
  const removeProposal = event('proposal_created', {
    proposal: {
      id: 'remove-a',
      kind: 'remove',
      taskId: 'a',
      reason: 'substituída',
      consequence: 'A deixa de ser atendida.',
    },
  });
  const pending = reduceTaskEvents([...initial, removeProposal], { project: 'p' });
  assert.deepEqual(pending.queue, ['a', 'b']);
  const removed = reduceTaskEvents(
    [
      ...initial,
      removeProposal,
      event('proposal_approved', {
        proposalId: 'remove-a',
        approvedBy: '@rafaspol',
        approvalRef: 'thread:remove',
      }),
    ],
    { project: 'p' },
  );
  assert.equal(removed.tasks.a.status, 'removed');
  assert.deepEqual(removed.queue, ['b']);
  assert.equal(boardView(removed).history[0].id, 'a');
});

test('retirar rascunho encerra a proposta de inclusão que ele carregava', () => {
  const removeProposal = event('proposal_created', {
    proposal: {
      id: 'remove-a-draft',
      kind: 'remove',
      taskId: 'a',
      reason: 'já foi entregue',
      consequence: 'Nenhuma entrega deixa de ser atendida.',
    },
  });
  const board = reduceTaskEvents(
    [
      draft('a', 1),
      removeProposal,
      event('proposal_approved', {
        proposalId: 'remove-a-draft',
        approvedBy: '@rafaspol',
        approvalRef: 'thread:remove-draft',
      }),
    ],
    { project: 'p' },
  );

  assert.equal(board.tasks.a.status, 'removed');
  assert.equal(board.proposals['proposal-a'].status, 'superseded');
  assert.equal(board.proposals['proposal-a'].resolution.byProposal, 'remove-a-draft');
  assert.deepEqual(boardView(board).pendingProposals, []);
});

test('claim usa época monotônica e agente anterior não finaliza após transferência', () => {
  const base = [draft('a', 1), approve('a')];
  const claimed = event('task_claimed', {
    taskId: 'a',
    agent: AGENT_A,
    claimEpoch: 1,
  });
  const transferred = event('task_claimed', {
    taskId: 'a',
    agent: AGENT_B,
    claimEpoch: 2,
  });
  assert.throws(
    () =>
      reduceTaskEvents(
        [
          ...base,
          claimed,
          transferred,
          event('task_ready', {
            taskId: 'a',
            agent: AGENT_A,
            claimEpoch: 1,
            candidateCommit: 'abc',
          }),
        ],
        { project: 'p' },
      ),
    /responsável atual/,
  );
  assert.throws(
    () =>
      reduceTaskEvents(
        [
          ...base,
          claimed,
          event('task_claimed', {
            taskId: 'a',
            agent: AGENT_B,
            claimEpoch: 3,
          }),
        ],
        { project: 'p' },
      ),
    /Época de claim inválida/,
  );
  assert.throws(
    () =>
      reduceTaskEvents(
        [
          ...base,
          claimed,
          transferred,
          event('task_claimed', {
            taskId: 'a',
            agent: AGENT_A,
            claimEpoch: 3,
          }),
          event('task_ready', {
            taskId: 'a',
            agent: AGENT_A,
            claimEpoch: 1,
            candidateCommit: 'abc',
          }),
        ],
        { project: 'p' },
      ),
    /responsável atual/,
  );
});

test('resultado tardio vira candidato alternativo ligado ao claim anterior', () => {
  const events = [
    draft('a', 1),
    approve('a'),
    event('task_claimed', { taskId: 'a', agent: AGENT_A, claimEpoch: 1 }),
    event('task_claimed', { taskId: 'a', agent: AGENT_B, claimEpoch: 2 }),
    event('task_alternate_candidate', {
      taskId: 'a',
      agent: AGENT_A,
      claimEpoch: 1,
      candidateCommit: 'a'.repeat(40),
      mergeBase: 'b'.repeat(40),
    }),
  ];
  const board = reduceTaskEvents(events, { project: 'x' });
  assert.equal(board.tasks.a.alternateCandidates.length, 1);
  assert.deepEqual(board.tasks.a.alternateCandidates[0].agent, AGENT_A);
  assert.throws(
    () =>
      reduceTaskEvents(
        [
          ...events,
          event('task_alternate_candidate', {
            taskId: 'a',
            agent: AGENT_B,
            claimEpoch: 2,
            candidateCommit: 'c'.repeat(40),
            mergeBase: 'b'.repeat(40),
          }),
        ],
        { project: 'x' },
      ),
    /não vem de claim anterior/,
  );
});

test('projeção contém somente estado derivado do histórico', () => {
  const board = reduceTaskEvents([draft('a', 1), approve('a')], { project: 'p' });
  const projection = boardProjection(board);
  assert.equal(projection.priorities[0].id, 'a');
  assert.equal(projection.priorities[0].rank, 1);
  assert.equal(projection.drafts.length, 0);
  assert.equal(projection.version, 2);
  assert.deepEqual(projection.priorities[0].origin.agent, AGENT_A);
  assert.equal(projection.priorities[0].queuedAt, board.tasks.a.queuedAt);
});

test('origem histórica é atribuída uma vez sem mudar a data de entrada', () => {
  const legacy = draft('legacy', 1);
  delete legacy.agent;
  const attributed = reduceTaskEvents(
    [
      legacy,
      event('task_origin_recorded', {
        taskId: 'legacy',
        agent: AGENT_B,
      }),
    ],
    { project: 'p' },
  );
  assert.deepEqual(attributed.tasks.legacy.origin, {
    at: legacy.at,
    agent: AGENT_B,
  });
  assert.throws(
    () =>
      reduceTaskEvents(
        [
          legacy,
          event('task_origin_recorded', { taskId: 'legacy', agent: AGENT_B }),
          event('task_origin_recorded', { taskId: 'legacy', agent: AGENT_A }),
        ],
        { project: 'p' },
      ),
    /já foi registrada/,
  );
});

test('idade é só projeção e não muda a ordem aprovada', () => {
  const events = [draft('antiga', 1), approve('antiga'), draft('nova', 1), approve('nova')];
  const board = reduceTaskEvents(events, { project: 'p' });
  const queueBefore = [...board.queue];
  const view = boardView(board, { now: '2026-09-16T00:00:01Z' });
  assert.equal(view.priorities[0].id, 'nova');
  assert.ok(view.priorities[1].ageDays >= view.priorities[0].ageDays);
  assert.deepEqual(board.queue, queueBefore);
  assert.equal(taskAgeDays({ at: '2026-09-13T00:00:00Z' }, '2026-09-16T00:00:00Z'), 3);
});

test('agente do claim vencedor vira implementador; anteriores ficam nos claims', () => {
  const board = reduceTaskEvents(
    [
      draft('a', 1),
      approve('a'),
      event('task_claimed', { taskId: 'a', agent: AGENT_A, claimEpoch: 1 }),
      event('task_claimed', { taskId: 'a', agent: AGENT_B, claimEpoch: 2 }),
      event('task_ready', {
        taskId: 'a',
        agent: AGENT_B,
        claimEpoch: 2,
        candidateCommit: 'a'.repeat(40),
      }),
    ],
    { project: 'p' },
  );
  assert.deepEqual(board.tasks.a.implementedBy, AGENT_B);
  assert.deepEqual(board.tasks.a.claims.map((claim) => claim.agent), [AGENT_A, AGENT_B]);
});

const reject = (proposalId, reason = 'fora do escopo') =>
  event('proposal_rejected', {
    proposalId,
    rejectedBy: '@rafaspol',
    rejectionRef: `thread:reject-${proposalId}`,
    reason,
  });

test('recusar inclusão tira o rascunho dos pendentes e o leva ao histórico com motivo', () => {
  const board = reduceTaskEvents(
    [draft('a', 1), approve('a'), draft('b', 1), reject('proposal-b', 'duplica a')],
    { project: 'p' },
  );
  const view = boardView(board);
  assert.deepEqual(board.queue, ['a']);
  assert.equal(board.tasks.b.status, 'rejected');
  assert.deepEqual(view.drafts, []);
  assert.deepEqual(view.pendingProposals, []);
  assert.equal(view.history[0].id, 'b');
  assert.equal(view.history[0].rejection.reason, 'duplica a');
  assert.deepEqual(
    view.rejectedProposals.map((proposal) => [proposal.id, proposal.rejection.by]),
    [['proposal-b', '@rafaspol']],
  );
  assert.equal(board.proposals['proposal-b'].rejection.ref, 'thread:reject-proposal-b');
});

test('recusar reordenação deixa a fila como estava; aprovar a mesma proposta a mudaria', () => {
  const initial = [draft('a', 1), approve('a'), draft('b', 2), approve('b')];
  const reorder = event('proposal_created', {
    proposal: { id: 'reorder-b', kind: 'reorder', taskId: 'b', suggestedRank: 1, reason: 'urgente' },
  });
  const rejected = reduceTaskEvents([...initial, reorder, reject('reorder-b')], { project: 'p' });
  assert.deepEqual(rejected.queue, ['a', 'b']);
  assert.equal(rejected.proposals['reorder-b'].status, 'rejected');
  assert.deepEqual(boardView(rejected).pendingProposals, []);

  const approved = reduceTaskEvents(
    [
      ...initial,
      reorder,
      event('proposal_approved', { proposalId: 'reorder-b', approvedBy: '@rafaspol', approvalRef: 'thread:r' }),
    ],
    { project: 'p' },
  );
  assert.deepEqual(approved.queue, ['b', 'a']);
});

test('recusa exige motivo e proposta pendente; proposta recusada não é aprovada depois', () => {
  assert.throws(
    () => reduceTaskEvents([draft('a', 1), reject('proposal-a', '')], { project: 'p' }),
    /precisa de motivo/,
  );
  assert.throws(
    () => reduceTaskEvents([draft('a', 1), approve('a'), reject('proposal-a')], { project: 'p' }),
    /já foi decidida/,
  );
  assert.throws(
    () => reduceTaskEvents([draft('a', 1), reject('proposal-a'), approve('a')], { project: 'p' }),
    /já foi decidida/,
  );
});

test('projeção e quadro Markdown mostram a recusa', () => {
  const board = reduceTaskEvents([draft('a', 1), reject('proposal-a', 'não vale agora')], {
    project: 'p',
  });
  const projection = boardProjection(board);
  assert.equal(projection.rejectedProposals[0].rejection.reason, 'não vale agora');
  assert.equal(projection.history[0].status, 'rejected');
  assert.match(
    renderBoardMarkdown(board),
    /## Recusas\n\n- `proposal-a` · add a recusada em \d{4}-\d{2}-\d{2} por @rafaspol \(thread:reject-proposal-a\): não vale agora/,
  );
});

test('o BOARD.md ressalva a aprovação declarada, nova ou antiga, e não a documentada', () => {
  const board = reduceTaskEvents(
    [
      draft('antiga', 1),
      approve('antiga'),
      draft('conversa', 2),
      event('proposal_approved', {
        proposalId: 'proposal-conversa',
        approvedBy: '@rafaspol',
        approvalRef: 'rafaspol:quiz-1',
        approvalBasis: 'conversation',
        recordedBy: AGENT_B,
        approvalSummary: 'Aceito',
      }),
      draft('documento', 3),
      event('proposal_approved', {
        proposalId: 'proposal-documento',
        approvedBy: '@rafaspol',
        approvalRef: 'ledger:approvals/d.md',
        approvalBasis: 'document',
        recordedBy: null,
      }),
    ],
    { project: 'p' }
  );
  const md = renderBoardMarkdown(board);
  const linha = (id) => md.split('\n').find((l) => l.includes(`**${id} —`));
  assert.match(linha('antiga'), /aprovação declarada \(conversa; registro anterior à proveniência\)/);
  assert.match(linha('conversa'), /aprovação declarada \(conversa; codex:agent-b\)/);
  assert.doesNotMatch(linha('documento'), /aprovação declarada/);
  // A projeção do ROADMAP não muda de forma: quem a consome faz digest dela.
  assert.equal('approval' in boardProjection(board).priorities[0], false);
});

test('composição histórica é preservada como declaração; prova inválida continua recusada', () => {
  const commit = 'a'.repeat(40);
  const base = [draft('legacy', 1), approve('legacy'),
    event('task_claimed', { taskId: 'legacy', agent: AGENT_A, claimEpoch: 1 }),
    event('task_ready', { taskId: 'legacy', agent: AGENT_A, claimEpoch: 1, candidateCommit: commit })];
  const evidence = { version: 1, mode: 'reviewed-composition',
    method: 'reviewed-candidate-manifest-and-composed-file-review',
    candidateCommit: commit, evidenceRef: 'ledger:evidence/review.json' };
  const board = reduceTaskEvents([...base, event('task_done', { taskId: 'legacy', integration: evidence })]);
  assert.equal(board.tasks.legacy.status, 'done');
  assert.equal(board.tasks.legacy.integration, null);
  assert.deepEqual(boardProjection(board).history[0].legacyIntegration,
    { validation: 'legacy-unverified', evidence });
  for (const integration of [{ ...evidence, method: 'unknown' }, { mode: 'ancestry' },
    { ...evidence, mode: 'unknown' }]) {
    assert.throws(() => reduceTaskEvents([...base,
      event('task_done', { taskId: 'legacy', integration })]), /integração|SHA/);
  }
});
