// Push con git real: rama New, rechazo por commits remotos, force-with-lease y archivos de un commit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitError, GitService } from '../src/git/GitService';
import { isRejection } from '../src/git/preflight';

let base: string;
let me: GitService;
let other: GitService;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

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

  base = mkdtempSync(path.join(tmpdir(), 'multigit-push-'));
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'develop', remote]);
  const meRoot = path.join(base, 'me');
  execFileSync('git', ['init', '-q', '-b', 'develop', meRoot]);
  writeFileSync(path.join(meRoot, 'README.md'), 'hola\n');
  git(meRoot, 'add', '.');
  git(meRoot, 'commit', '-q', '-m', 'init');
  git(meRoot, 'remote', 'add', 'origin', remote);
  git(meRoot, 'push', '-q', '-u', 'origin', 'develop');
  execFileSync('git', ['clone', '-q', remote, path.join(base, 'other')]);
  me = new GitService(meRoot);
  other = new GitService(path.join(base, 'other'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('push (git real)', () => {
  it('rama New: commits que no están en el remote y push -u', async () => {
    await me.createBranch('dev-afminga-push', 'develop', true);
    await commit(me, 'a.ts', 'a', 'feat: a');
    await commit(me, 'b.ts', 'b', 'feat: b');

    const pending = await me.logCommits(['dev-afminga-push', '--not', '--remotes=origin']);
    expect(pending.map((c) => c.subject)).toEqual(['feat: b', 'feat: a']);

    await me.pushBranch('origin', 'dev-afminga-push', 'dev-afminga-push', { setUpstream: true });
    const lb = (await me.getBranches()).local.find((b) => b.name === 'dev-afminga-push')!;
    expect(lb.upstream).toBe('origin/dev-afminga-push');
    expect(await me.logCommits(['origin/dev-afminga-push..dev-afminga-push'])).toEqual([]);
  });

  it('archivos de un commit (y del commit raíz)', async () => {
    const [head] = await me.logCommits(['-1', 'HEAD']);
    expect(await me.commitFiles(head!.hash)).toEqual([{ status: 'A', path: 'b.ts' }]);
    const root = (await me.exec(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    expect(await me.commitFiles(root)).toEqual([{ status: 'A', path: 'README.md' }]);
    expect(await me.showFile(root, 'README.md')).toBe('hola\n');
  });

  it('rechazo si el remote tiene commits nuevos; force-with-lease tras el fetch', async () => {
    // Otra persona sube a develop.
    await commit(other, 'otro.ts', 'x', 'feat: de otra persona');
    await other.pushBranch('origin', 'develop', 'develop', {});

    await me.checkout('develop');
    await commit(me, 'mio.ts', 'y', 'feat: mío');

    const error = await me.pushBranch('origin', 'develop', 'develop', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(isRejection((error as GitError).stderr)).toBe(true);

    // Sin fetch, el lease protege: origin/develop local está desactualizado.
    const stale = await me.pushBranch('origin', 'develop', 'develop', { forceWithLease: true }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(GitError);
    expect(isRejection((stale as GitError).stderr)).toBe(true);

    // Pull y reintentar.
    await me.fetchAll();
    await me.pull();
    await me.pushBranch('origin', 'develop', 'develop', {});
    expect((await me.getStatus()).ahead).toBe(0);
  });
});
