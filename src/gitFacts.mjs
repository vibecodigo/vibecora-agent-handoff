import { execFileSync } from 'node:child_process';

// Fatos de Git. A maioria é local; as que falam com o remoto estão marcadas e
// levam TETO DE TEMPO. Cada função devolve `null` (ou lista vazia) quando o
// comando falha, para o chamador decidir.
//
// O teto existe porque um remoto que aceita a conexão e não responde pendura o
// processo em vez de degradar — e essas leituras rodam na ABERTURA de uma
// sessão, onde pendurar é o pior resultado possível. `killSignal` garante o
// encerramento de um filho que ignore o SIGTERM.
export const REMOTE_TIMEOUT_MS = 15_000;

function git(args, { cwd, timeout } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
    }).trim();
  } catch {
    return null;
  }
}

function gitRaw(args, { cwd } = {}) {
  // Como git(), mas SEM trim — preserva o espaço-coluna de `status --porcelain`
  // (a 1ª linha perderia o char de status com trim()).
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function makeGitFacts({ cwd = process.cwd(), mainRef = 'main' } = {}) {
  const g = (args) => git(args, { cwd });
  // Para o que toca a rede.
  const gRemote = (args) => git(args, { cwd, timeout: REMOTE_TIMEOUT_MS });

  function resolvedMainRef() {
    if (g(['rev-parse', '--verify', '--quiet', `origin/${mainRef}`]) !== null) {
      return `origin/${mainRef}`;
    }
    return mainRef;
  }

  function headCommit() {
    return g(['rev-parse', '--short', 'HEAD']);
  }

  function currentBranch() {
    return g(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  function originUrl() {
    return g(['remote', 'get-url', 'origin']);
  }

  function commitExists(sha) {
    if (!sha) return false;
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
        cwd,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  function isAncestor(sha, ref) {
    if (!sha) return false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], {
        cwd,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  // Ancestral de origin/<main> OU de <main> local — num fluxo commit-então-push
  // direto na main o commit está na main local antes do push.
  function mainContains(sha) {
    return isAncestor(sha, `origin/${mainRef}`) || isAncestor(sha, mainRef);
  }

  function baseRef() {
    const base =
      g(['merge-base', resolvedMainRef(), 'HEAD']) ||
      g(['merge-base', mainRef, 'HEAD']) ||
      g(['rev-list', '--max-parents=0', 'HEAD']);
    return base ? base.split('\n')[0] : null;
  }

  function changedPathsSince(base) {
    if (!base) return [];
    const out = g(['diff', '--name-only', `${base}..HEAD`]);
    const committed = out ? out.split('\n').filter(Boolean) : [];
    const dirty = gitRaw(['status', '--porcelain'], { cwd });
    const uncommitted = dirty
      ? dirty
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).split(' -> ').pop())
          .filter(Boolean)
      : [];
    return [...new Set([...committed, ...uncommitted])];
  }

  function commitsInRange(base, head = 'HEAD') {
    if (!base) return [];
    const out = g(['rev-list', `${base}..${head}`]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  function pathsInCommit(sha) {
    const out = g(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  function workingTreeDirty() {
    return Boolean(g(['status', '--porcelain']));
  }

  function branchHasUpstream() {
    return (
      g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) !== null
    );
  }

  function inferCodeState() {
    if (workingTreeDirty()) return 'working_tree';
    const head = g(['rev-parse', 'HEAD']);
    if (head && mainContains(head)) return 'merged_main';
    if (branchHasUpstream()) return 'pushed_branch';
    return 'local_commit';
  }

  // REDE. Com teto de tempo — sem ele, um remoto que não responde pendura.
  function remoteMainCommit() {
    const out = gRemote(['ls-remote', 'origin', `refs/heads/${mainRef}`]);
    return out ? out.split(/\s+/)[0] : null;
  }

  // REDE. Todas as branches do remoto, sem buscar nada para o clone.
  // `null` = não deu para consultar, que é diferente de "o remoto não tem
  // branch nenhuma" (lista vazia).
  function remoteHeads() {
    const out = gRemote(['ls-remote', '--heads', 'origin']);
    if (out === null) return null;
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t');
        return { sha, name: (ref || '').replace('refs/heads/', '') };
      })
      .filter((h) => h.sha && h.name);
  }

  // Shas dos commits que tocaram um arquivo, do mais recente para o mais antigo.
  function fileHistoryShas(filePath, { maxCount = 50 } = {}) {
    const out = g([
      'log',
      `--max-count=${maxCount}`,
      '--format=%H',
      '--',
      filePath,
    ]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  // Conteúdo de um arquivo como estava num commit. `null` se não existia lá.
  function fileAtCommit(sha, filePath) {
    return g(['show', `${sha}:${filePath}`]);
  }

  function countCommitsBetween(from, to) {
    const out = g(['rev-list', '--count', `${from}..${to}`]);
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  }

  // Relação entre um commit e uma ref, medida nas DUAS direções.
  //
  // Medir uma direção só é o erro fácil aqui: um commit à frente da ref é
  // trabalho local ainda não pushado, e tratá-lo como divergente reprova quem
  // não fez nada de errado. `null` quer dizer que não deu para medir — a ref
  // não existe, ou o commit não está neste clone.
  function snapshotRelation(sha, ref) {
    if (!sha || !ref) return null;
    if (g(['rev-parse', '--verify', '--quiet', ref]) === null) return null;
    if (!commitExists(sha)) return null;
    if (isAncestor(sha, ref)) return 'contained';
    if (isAncestor(ref, sha)) return 'ahead';
    return 'diverged';
  }

  return {
    headCommit,
    currentBranch,
    originUrl,
    commitExists,
    mainContains,
    isAncestor,
    baseRef,
    changedPathsSince,
    commitsInRange,
    pathsInCommit,
    workingTreeDirty,
    inferCodeState,
    remoteMainCommit,
    remoteHeads,
    fileHistoryShas,
    fileAtCommit,
    countCommitsBetween,
    snapshotRelation,
    mainRef,
  };
}
