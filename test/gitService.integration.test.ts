// Integración con git real: repos temporales con un remote "origin" bare.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';

let base: string;
const names = ['mftheme', 'mflogin', 'shell'];
const repos: GitService[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  // Configuración aislada: no depender del ~/.gitconfig de quien corre los tests.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // git (también Git for Windows) entiende /dev/null
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

  base = mkdtempSync(path.join(tmpdir(), 'multigit-it-'));
  for (const name of names) {
    const remote = path.join(base, 'remotes', `${name}.git`);
    const root = path.join(base, 'ws', name);
    execFileSync('git', ['init', '--bare', '-q', '-b', 'develop', remote]);
    execFileSync('git', ['init', '-q', '-b', 'develop', root]);
    writeFileSync(path.join(root, 'README.md'), `# ${name}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'develop');
    git(root, 'branch', 'production-lt');
    repos.push(new GitService(root));
  }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('GitService (git real)', () => {
  it('crea dev-afminga-prueba desde develop en todos y vuelve a develop', async () => {
    for (const r of repos) await r.createBranch('dev-afminga-prueba', 'develop', true);
    for (const r of repos) expect((await r.getStatus()).branch).toBe('dev-afminga-prueba');

    for (const r of repos) await r.checkout('develop');
    for (const r of repos) expect((await r.getStatus()).branch).toBe('develop');
  });

  it('la rama nueva desde una remota no queda enlazada a ella (--no-track)', async () => {
    const r = repos[0]!;
    await r.createBranch('desde-remota', 'origin/develop', false);
    const lb = (await r.getBranches()).local.find((b) => b.name === 'desde-remota')!;
    expect(lb.upstream).toBeNull();
  });

  it('getBranches: locales, remotas, upstream y ↑', async () => {
    const r = repos[1]!;
    writeFileSync(path.join(r.root, 'a.txt'), 'a');
    await r.exec(['add', 'a.txt']);
    await r.exec(['commit', '-q', '-m', 'a']);
    const branches = await r.getBranches();
    const develop = branches.local.find((b) => b.name === 'develop')!;
    expect(develop).toMatchObject({ current: true, upstream: 'origin/develop', upstreamRemote: 'origin', ahead: 1 });
    expect(branches.remote.map((b) => b.full)).toContain('origin/develop');
    expect(branches.remotes).toEqual(['origin']);
  });

  it('push -u de una rama nueva y borrado local', async () => {
    const r = repos[2]!;
    await r.createBranch('feature-x', 'HEAD', false);
    await r.pushBranch('origin', 'feature-x', 'feature-x', { setUpstream: true });
    const lb = (await r.getBranches()).local.find((b) => b.name === 'feature-x')!;
    expect(lb.upstream).toBe('origin/feature-x');

    expect(await r.isAncestor('feature-x', 'HEAD')).toBe(true);
    await r.deleteBranch('feature-x', false);
    expect((await r.getBranches()).local.some((b) => b.name === 'feature-x')).toBe(false);
  });

  it('detecta un merge en curso', async () => {
    const r = repos[0]!;
    expect(await r.getOperationInProgress()).toBeNull();

    await r.createBranch('conflicto', 'develop', true);
    writeFileSync(path.join(r.root, 'README.md'), 'rama\n');
    await r.exec(['commit', '-q', '-am', 'rama']);
    await r.checkout('develop');
    writeFileSync(path.join(r.root, 'README.md'), 'develop\n');
    await r.exec(['commit', '-q', '-am', 'develop']);

    await expect(r.merge('conflicto')).rejects.toThrow();
    expect(await r.getOperationInProgress()).toBe('merge');
    expect((await r.getStatus()).changes.conflicted).toBe(1);

    await r.exec(['merge', '--abort']);
    expect(await r.getOperationInProgress()).toBeNull();
  });

  it('valida nombres de rama y revisiones', async () => {
    const r = repos[0]!;
    expect(await r.isValidBranchName('dev-afminga/ok')).toBe(true);
    expect(await r.isValidBranchName('mal..nombre')).toBe(false);
    expect(await r.isValidBranchName('-x')).toBe(false);
    expect(await r.revisionExists('develop')).toBe(true);
    expect(await r.revisionExists('no-existe')).toBe(false);
  });
});
