import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readConstraintIds, validateConstraints } from '../constraints.mjs';
import { makeGitFacts, REMOTE_TIMEOUT_MS } from '../gitFacts.mjs';
import { evaluateOpening } from '../opening.mjs';
import { parseYaml } from '../yaml.mjs';
import { run as briefRun } from './brief.mjs';

// `vibecora-handoff start` — o PRIMEIRO comando de uma sessão.
//
// Faz as leituras, aplica a regra de `src/opening.mjs`, imprime o estado MEDIDO
// e chama o `brief` ao final. É um comando só de propósito: a alternativa é
// cada agente improvisar a própria ordem de fontes, que é como um retrato
// correto virou "estado atual" três vezes num projeto real.
//
// O `brief` vem DEPOIS do veredito, e não antes, porque ele é a fonte mais
// fraca: o retrato diz o que a sessão anterior pretendia, não o que é.
//
// Nenhuma leitura escreve no clone. `ls-remote` lê o remoto sem buscar, e tudo
// que toca a rede tem teto de tempo — sem ele, um remoto que aceita a conexão e
// não responde trava a abertura em vez de degradar.

const execFileAsync = promisify(execFile);

// Uma abertura local-first mede o `origin` compartilhado, mas não atravessa a
// fronteira de release. Caminhos absolutos, relativos e `file://` são remotos
// Git locais; HTTPS/SSH e a forma scp (`git@host:repo`) são externos.
//
// Na dúvida, um valor sem sintaxe de rede é tratado como caminho local. É a
// escolha segura: deixar de consultar uma fonte externa vira "não medido";
// consultá-la por engano quebra a promessa de que o trabalho cotidiano não
// depende de GitHub nem de Produção.
export function isLocalGitRemoteUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const remote = value.trim();
  if (remote.startsWith('file://')) return true;
  if (path.isAbsolute(remote) || path.win32.isAbsolute(remote)) return true;
  if (remote.startsWith('./') || remote.startsWith('../')) return true;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) return false;
  if (/^[^/\\:]+:/.test(remote)) return false;
  return true;
}

export function externalOpeningSourcesAllowed(originUrl, policy = 'auto') {
  if (!['auto', 'always', 'never'].includes(policy)) {
    throw new Error('start.externalSources precisa ser auto, always ou never.');
  }
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return Boolean(originUrl) && !isLocalGitRemoteUrl(originUrl);
}

// PRs abertas. `gh` é opcional: sem ele a leitura degrada para "não consultado"
// e o relatório diz isso, em vez de fingir que olhou.
async function readOpenPrs(cwd, env) {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,title,isDraft,headRefName'],
      { cwd, env, timeout: REMOTE_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );
    const prs = JSON.parse(stdout);
    return Array.isArray(prs) ? prs : null;
  } catch {
    return null;
  }
}

// O estado publicado, medido e não lembrado. Só acontece se o consumidor tiver
// configurado a base — é a MESMA fonte do `audit`, então reusa a mesma config
// em vez de criar uma segunda verdade.
export function releaseBaseUrl(config, env) {
  const literal = config.audit?.releaseBaseUrl;
  if (literal) return literal;
  const name = config.audit?.releaseBaseUrlEnv;
  return name && env[name] ? env[name] : null;
}

async function readPublished(config, env) {
  const base = releaseBaseUrl(config, env);
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/release`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.commit ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Todo id que já existiu no arquivo de constraints, em qualquer versão
// commitada. É contra isto que o conjunto atual é comparado: um id que existiu
// e não está mais nem ativo nem aposentado foi apagado em silêncio.
function historicalConstraintIds(git, filePath, limit) {
  const seen = new Set();
  for (const sha of git.fileHistoryShas(filePath, { maxCount: limit })) {
    const content = git.fileAtCommit(sha, filePath);
    if (!content) continue;
    for (const id of readConstraintIds(content).active) seen.add(id);
  }
  return [...seen];
}

export async function collectReadings({ cwd, config, env = process.env }) {
  const git = makeGitFacts({ cwd, mainRef: config.git?.mainRef || 'main' });

  const originUrl = git.originUrl();
  const externalSourcesPolicy = config.start?.externalSources ?? 'auto';
  const readExternalSources = externalOpeningSourcesAllowed(originUrl, externalSourcesPolicy);

  const [heads, openPrs, published] = await Promise.all([
    Promise.resolve(git.remoteHeads()),
    readExternalSources ? readOpenPrs(cwd, env) : Promise.resolve(null),
    readExternalSources ? readPublished(config, env) : Promise.resolve(null),
  ]);

  const mainRef = config.git?.mainRef || 'main';
  const missingBranches = [];
  let commitsBehind = 0;
  for (const { sha, name } of heads || []) {
    if (name === mainRef) {
      commitsBehind = git.commitExists(sha)
        ? git.countCommitsBetween('HEAD', sha)
        : 1;
      continue;
    }
    // Objeto ausente no clone = trabalho que este checkout nunca viu.
    if (!git.commitExists(sha)) missingBranches.push(name);
  }

  const handoffPath = path.resolve(cwd, config.files.handoff);
  const snapshotPresent = fs.existsSync(handoffPath);
  let snapshot = null;
  if (snapshotPresent) {
    try {
      snapshot = parseYaml(fs.readFileSync(handoffPath, 'utf8'));
    } catch {
      snapshot = null;
    }
  }
  const snapshotCommit = snapshot?.code?.commit || null;
  // Contra a linha PUBLICADA, e só contra ela. Sem remoto não há publicado, e
  // cair para a main local seria medir outra coisa e chamá-la pelo mesmo nome —
  // imprecisão de nome de campo é exatamente o que esta camada existe para
  // evitar. `null` diz "não deu para medir", que não é "medi e está errado".
  const snapshotRelation = snapshotCommit
    ? (git.snapshotRelation(snapshotCommit, `origin/${mainRef}`) ??
      git.snapshotRelation(snapshotCommit, 'origin/HEAD'))
    : null;

  const constraintsFile = config.files.constraints;
  let current = { active: [], retired: [] };
  let constraintErrors = [];
  if (constraintsFile) {
    const p = path.resolve(cwd, constraintsFile);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      current = readConstraintIds(text);
      try {
        constraintErrors = validateConstraints(parseYaml(text));
      } catch {
        constraintErrors = ['constraints: o arquivo não é YAML válido.'];
      }
    }
  }

  const readings = {
    openPrs: openPrs || [],
    missingBranches,
    commitsBehind,
    snapshotPresent,
    snapshotCommit,
    snapshotRelation,
    currentConstraints: current.active,
    historicalConstraints: constraintsFile
      ? historicalConstraintIds(
          git,
          constraintsFile,
          config.start?.constraintsHistoryLimit ?? 50,
        )
      : [],
    retiredConstraints: current.retired,
    productionChecked: Boolean(published),
  };

  const measured = {
    head: git.headCommit(),
    branch: git.currentBranch(),
    origin: originUrl,
    external_read: readExternalSources,
    external_sources_policy: externalSourcesPolicy,
    snapshot: {
      run_id: snapshot?.run_id || null,
      commit: snapshotCommit,
      relation_to_published: snapshotRelation,
    },
    published: published?.commit ? published.commit.slice(0, 7) : null,
    constraints: current.active,
    remote_read: heads !== null,
    prs_read: openPrs !== null,
  };

  return { readings, measured, constraintErrors };
}

export async function run(args, { cwd = process.cwd(), config, configInfo }) {
  const { readings, measured, constraintErrors } = await collectReadings({
    cwd,
    config,
  });

  const state = evaluateOpening(readings);
  const payload = { ...state, measured };

  if (args.json) {
    // Sem o brief: a saída precisa continuar parseável.
    console.log(JSON.stringify(payload, null, 2));
    return state.blocked ? 1 : 0;
  }

  // Modo texto é para gente ler: o medido em quatro linhas, não o JSON inteiro.
  // Quem quiser a estrutura completa pede `--json`.
  const line = (k, v) => console.log(`  ${String(k).padEnd(12)} ${v ?? '—'}`);
  console.log('── medido ──');
  line('clone', `${measured.head ?? '—'} (${measured.branch ?? '—'})`);
  line(
    'retrato',
    measured.snapshot.commit
      ? `${measured.snapshot.commit}${
          measured.snapshot.relation_to_published
            ? ` — ${measured.snapshot.relation_to_published} em relação ao publicado`
            : ' — relação com o publicado não medida'
        }`
      : 'ainda não existe',
  );
  line('publicado', measured.published);
  line(
    'externas',
    `${measured.external_read ? 'habilitadas' : 'ignoradas'} — política ${measured.external_sources_policy}`,
  );
  line(
    'remoto',
    measured.remote_read
      ? `lido — ${readings.missingBranches.length} branch(es) ausente(s), ${
          measured.prs_read ? `${readings.openPrs.length} PR(s) aberta(s)` : 'PRs não consultadas'
        }`
      : 'não consultado',
  );
  line('travas', measured.constraints.length || 'nenhuma');
  console.log('');

  if (state.blocked) {
    console.log('BLOQUEADO — não comece a trabalhar antes de resolver:');
    for (const r of state.reasons) console.log(`  - ${r}`);
  } else {
    console.log('LIVRE — o estado medido não contradiz o retrato.');
  }
  for (const n of state.notes) console.log(`  (aviso) ${n}`);
  // Formato do arquivo de travas: informa, nunca bloqueia. Validar formato não
  // é medir estado, e um bloqueio por YAML feio é o alarme que ensina a
  // contornar o mecanismo.
  for (const e of constraintErrors) console.log(`  (aviso) ${e}`);

  // Sem retrato não há o que resumir, e chamar o brief só produziria um erro
  // que não é erro nenhum — é um projeto começando.
  if (!readings.snapshotPresent) {
    console.log(
      '\nAinda não há retrato. Ao fechar a sessão, `new` + `finalize` gravam o\n' +
        'primeiro, e a partir daí ele aparece aqui embaixo.',
    );
    return state.blocked ? 1 : 0;
  }

  console.log(
    '\nO que vem abaixo é o RETRATO: a intenção de quem fechou a sessão\n' +
      'anterior, não o estado atual. Onde os dois discordarem, vale o medido.\n' +
      `As travas estão em ${config.files.constraints || 'constraints.yaml'}, não aqui.\n`,
  );

  // Chamada direta, não `npx`: dentro do próprio pacote uma resolução externa
  // só pode falhar, e o `brief` já imprime em stdout e devolve número.
  const briefCode = await briefRun({ ...args, json: false }, { cwd, config, configInfo });
  if (briefCode !== 0) {
    // O retrato ilegível não contamina o veredito do `start`: quem decide o
    // código de saída é a medição.
    console.log('(o brief não pôde ser impresso; o veredito acima continua valendo)');
  }

  return state.blocked ? 1 : 0;
}
