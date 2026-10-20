import fs from 'node:fs';
import path from 'node:path';

// Configuração do handoff no projeto consumidor. Caminho padrão:
// `.agents/handoff.config.json`. O núcleo traz defaults genéricos; o consumidor
// sobrescreve o que for específico do layout dele.

export const DEFAULT_CONFIG = {
  version: 3,
  platform: null, // ex.: "quave-one"
  files: {
    handoff: '.agents/handoff.yaml',
    input: '.agents/handoff.input.yaml',
    performance: '.agents/performance.jsonl',
    friction: '.agents/friction.log',
    constraints: '.agents/constraints.yaml',
    roadmap: null, // opcional; null => roadmap não faz parte do fluxo
  },
  git: {
    mainRef: 'main',
  },
  start: {
    // auto dispensa PRs/release na abertura com origin local ou ausente.
    externalSources: 'auto',
    // Quantos commits do arquivo de constraints olhar para trás. Teto porque a
    // leitura é um `git show` por commit, e um id apagado aparece no commit
    // seguinte — não daqui a cem.
    constraintsHistoryLimit: 50,
  },
  tasks: {
    enabled: false,
    project: null,
    ledger: null,
    branch: 'main',
    conductor: '@rafaspol',
    // Referências de delegação permanente do condutor. Uma aprovação que cita
    // uma delas é classificada como `delegation`, e não como conversa.
    delegationRefs: [],
    thresholdPercent: 20,
    measurementCacheMinutes: 15,
    maxCheckpointBytes: 25 * 1024 * 1024,
    keyEnv: 'VIBE_CORA_TASK_KEY',
    keyFile: null,
    cacheDir: null,
  },
  classify: {
    // Regras ordenadas: a primeira que casar decide a classe do caminho.
    // `match` aceita globs simples (`**`, `*`) e caminhos literais.
    rules: [
      {
        class: 'state',
        match: [
          '.agents/handoff.yaml',
          '.agents/handoff.input.yaml',
          '.agents/performance.jsonl',
          '.agents/friction.log',
          '.agents/constraints.yaml',
        ],
      },
      { class: 'general_docs', match: ['docs/decisions/**', 'README.md'] },
      { class: 'product_docs', match: ['ROADMAP.md', 'docs/**'] },
      {
        class: 'process',
        match: [
          '.github/**',
          'scripts/**',
          '.githooks/**',
          'tests/**',
          'test/**',
          'evals/**',
          'AGENTS.md',
          'CLAUDE.md',
          '.agents/**',
        ],
      },
      {
        class: 'runtime',
        match: [
          'src/**',
          'app/**',
          'lib/**',
          'client/**',
          'server/**',
          'public/**',
          'package.json',
          'package-lock.json',
          'Dockerfile',
        ],
      },
      { class: 'general_docs', match: ['*.md'] },
    ],
    unknownClass: 'runtime',
    // Classes que o fluxo de fechamento do consumidor toca DEPOIS do `new`
    // (ex.: um `roadmap-sync` que reescreve o ROADMAP). Unidas ao change_class.
    recordAlsoTouches: [],
  },
  audit: {
    // Base de `/api/release`. Precedência: `releaseBaseUrl` literal na config,
    // depois a env var nomeada em `releaseBaseUrlEnv`. Sem nenhum => a fonte é
    // reportada como indisponível.
    releaseBaseUrl: null,
    releaseBaseUrlEnv: 'HANDOFF_AUDIT_BASE_URL',
    quave: {
      envNameEnv: 'QUAVEONE_ENV_NAME',
      envTokenEnv: 'QUAVEONE_ENV_TOKEN',
      cliEnv: 'QUAVEONE_CLI', // caminho do binário; default: "quaveone" no PATH
    },
  },
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (
    override == null ||
    typeof override !== 'object' ||
    typeof base !== 'object' ||
    base == null ||
    Array.isArray(base)
  ) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

export function configPath(cwd, override) {
  return path.resolve(cwd, override || '.agents/handoff.config.json');
}

export function loadConfig(cwd = process.cwd(), override) {
  const file = configPath(cwd, override);
  if (!fs.existsSync(file)) {
    return { config: DEFAULT_CONFIG, path: file, exists: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: JSON inválido (${error.message}).`);
  }
  return { config: deepMerge(DEFAULT_CONFIG, parsed), path: file, exists: true };
}
