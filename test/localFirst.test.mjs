import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { collectReadings, externalOpeningSourcesAllowed, isLocalGitRemoteUrl } from '../src/commands/start.mjs';
import { tmpRepoWithRemote } from './helpers.mjs';

test('auto distingue caminhos locais de remotos de rede; overrides são explícitos', () => {
  for (const remote of ['/srv/git/project.git', '../repos/project.git', 'repos/project.git', 'file:///srv/git/project.git']) {
    assert.equal(isLocalGitRemoteUrl(remote), true);
    assert.equal(externalOpeningSourcesAllowed(remote), false);
    assert.equal(externalOpeningSourcesAllowed(remote, 'always'), true);
  }
  for (const remote of ['https://example.invalid/project.git', 'ssh://git@example.invalid/project.git', 'git@example.invalid:project.git', 'host:project.git', 'git://example.invalid/project.git']) {
    assert.equal(isLocalGitRemoteUrl(remote), false, remote);
    assert.equal(externalOpeningSourcesAllowed(remote), true, remote);
    assert.equal(externalOpeningSourcesAllowed(remote, 'never'), false);
  }
  assert.equal(externalOpeningSourcesAllowed(null), false);
  assert.equal(externalOpeningSourcesAllowed(null, 'always'), true);
  assert.throws(() => externalOpeningSourcesAllowed('/repo', 'typo'), /externalSources/);
});

test('abertura local dispensa chamadas reais de PR/release; rede e override mantêm consultas', async (t) => {
  const repo = tmpRepoWithRemote();
  t.after(() => repo.cleanup());
  const marker = path.join(repo.dir, 'gh-called');
  const shim = path.join(repo.dir, 'tools');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');process.stdout.write('[]');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}` };
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/api/release');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ commit: repo.git('rev-parse', 'HEAD') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = structuredClone(DEFAULT_CONFIG);
  config.audit.releaseBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const read = () => collectReadings({ cwd: repo.dir, config, env });

  let result = await read();
  assert.equal(result.measured.external_read, false);
  assert.equal(result.measured.remote_read, true);
  assert.equal(result.measured.published, null);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(marker), false);

  config.start.externalSources = 'always';
  result = await read();
  assert.equal(result.measured.external_read, true);
  assert.equal(result.measured.published, repo.git('rev-parse', 'HEAD').slice(0, 7));
  assert.equal(requests, 1);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'called\n');

  repo.git('remote', 'set-url', 'origin', 'https://127.0.0.1:1/project.git');
  config.start.externalSources = 'auto';
  result = await read();
  assert.equal(result.measured.external_read, true);
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'called\ncalled\n');

  config.start.externalSources = 'never';
  result = await read();
  assert.equal(result.measured.external_read, false);
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'called\ncalled\n');
});
