// Pull con git real: desde otra rama remota, --ff-only con divergencia, rebase y conflictos.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';

let base: string;
let me: GitService;
let other: GitService;

async function commit(repo: GitService, file: string, content: string, message: string): Promise<void> {
  writeFileSync(path.join(repo.root, file), content);
  await repo.exec(['add', file]);
  await repo.exec(['commit', '-q', '-m', message]);
}

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // git (también Git for Windows) entiende /dev/null
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

  base = mkdtempSync(path.join(tmpdir(), 'multigit-pull-'));
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'develop', remote]);
  const meRoot = path.join(base, 'me');
  execFileSync('git', ['init', '-q', '-b', 'develop', meRoot]);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: meRoot });
  writeFileSync(path.join(meRoot, 'app.ts'), 'base\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'develop');
  g('checkout', '-q', '-b', 'dev-x');
  g('push', '-q', '-u', 'origin', 'dev-x');
  execFileSync('git', ['clone', '-q', remote, path.join(base, 'other')]);
  me = new GitService(meRoot);
  other = new GitService(path.join(base, 'other'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('pull (git real)', () => {
  it('pull de origin/develop estando en dev-x (merge)', async () => {
    await commit(other, 'nuevo.ts', 'n', 'feat: en develop');
    await other.pushBranch('origin', 'develop', 'develop', {});

    const before = await me.headSha();
    await me.pullWith('merge', 'origin', 'develop');
    expect((await me.getStatus()).branch).toBe('dev-x');
    expect(await me.countCommits(`${before}..HEAD`)).toBe(1);
  });

  it('--ff-only falla si hay divergencia; rebase la resuelve', async () => {
    await other.exec(['pull', '-q', '--no-rebase', '--no-edit']);
    await commit(other, 'b.ts', 'b', 'feat: remoto');
    await other.pushBranch('origin', 'develop', 'develop', {});
    await me.checkout('develop');
    await me.pullWith('ff-only');
    await commit(me, 'c.ts', 'c', 'feat: local');
    await commit(other, 'd.ts', 'd', 'feat: remoto 2');
    await other.pushBranch('origin', 'develop', 'develop', {});

    await expect(me.pullWith('ff-only')).rejects.toThrow();
    await me.pullWith('rebase');
    const log = await me.logCommits(['-2', 'HEAD']);
    expect(log.map((c) => c.subject)).toEqual(['feat: local', 'feat: remoto 2']);
  });

  it('conflicto en pull: deja el merge a medias y lista los archivos', async () => {
    await me.pushBranch('origin', 'develop', 'develop', {});
    await other.exec(['pull', '-q', '--rebase']);
    await commit(other, 'app.ts', 'remoto\n', 'feat: cambia app remoto');
    await other.pushBranch('origin', 'develop', 'develop', {});
    await commit(me, 'app.ts', 'local\n', 'feat: cambia app local');

    const error = await me.pullWith('merge').catch((e: { stdout?: string }) => e);
    expect((error as { stdout?: string }).stdout).toMatch(/CONFLICT/);
    expect(await me.getConflictedFiles()).toEqual(['app.ts']);
    expect(await me.getOperationInProgress()).toBe('merge');
    await me.exec(['merge', '--abort']);
  });
});
