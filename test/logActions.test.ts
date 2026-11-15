// Git Log: varios commits (cherry-pick, revert, squash, patch), navegación padre/hijo, archivos de una
// revisión, Get from Revision, tags (push y borrado) y "Open on GitHub / GitLab" (con git real).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { squashMessage, squashPlan } from '../src/git/historyEdit';
import { buildTodo, type RebaseCommit } from '../src/git/rebase';
import { parseRemoteUrl, revisionWebUrl } from '../src/git/pullRequests';
import { parsePatch, patchPath } from '../src/git/patches';

const commit = (hash: string, message = hash): RebaseCommit => ({ hash, short: hash, subject: message, message, author: 'a', time: 0 });

describe('squash (puro)', () => {
  it('junta los elegidos en el lugar del más viejo; el resto sigue en orden', () => {
    const commits = ['a', 'b', 'c', 'd'].map((h) => commit(h));
    expect(squashPlan(commits, ['a', 'c'], 'juntos')).toEqual([
      { hash: 'a', action: 'pick' },
      { hash: 'c', action: 'fixup', message: 'juntos' },
      { hash: 'b', action: 'pick' },
      { hash: 'd', action: 'pick' },
    ]);
    expect(squashPlan(commits, ['a'], 'x')).toBeUndefined();
    expect(squashPlan(commits, ['b', 'c'], 'x')).toBeUndefined(); // no empieza por el más viejo elegido
    expect(squashPlan(commits, ['a', 'z'], 'x')).toBeUndefined();
    expect(squashMessage(['feat: a', ' feat: a ', 'fix: b', ''])).toBe('feat: a\n\nfix: b');
  });

  it('el todo pone el mensaje tras el último fixup', () => {
    const todo = buildTodo(
      [
        { hash: 'a', action: 'pick' },
        { hash: 'c', action: 'fixup', message: 'm' },
      ],
      (h) => `/tmp/msg-${h}`,
    );
    expect(todo).toBe('pick a\nfixup c\nexec git commit --amend --allow-empty --no-verify --quiet -F "/tmp/msg-c"\n');
  });
});

describe('Open on GitHub / GitLab', () => {
  it('commit y archivo por proveedor; un host propio cuenta como GitLab', () => {
    const gh = parseRemoteUrl('git@github.com:ana/app.git')!;
    expect(revisionWebUrl(gh, 'abc')).toBe('https://github.com/ana/app/commit/abc');
    expect(revisionWebUrl(gh, 'abc', 'src/a b.ts')).toBe('https://github.com/ana/app/blob/abc/src/a%20b.ts');
    const own = parseRemoteUrl('https://git.empresa.tech/frontend/micro/mftheme.git')!;
    expect(own.provider).toBeUndefined();
    expect(revisionWebUrl(own, 'abc')).toBe('https://git.empresa.tech/frontend/micro/mftheme/-/commit/abc');
    expect(revisionWebUrl(own, 'abc', 'src/x.ts')).toBe('https://git.empresa.tech/frontend/micro/mftheme/-/blob/abc/src/x.ts');
    const bb = parseRemoteUrl('https://bitbucket.org/ana/app.git')!;
    expect(revisionWebUrl(bb, 'abc')).toBe('https://bitbucket.org/ana/app/commits/abc');
  });
});

describe('git real', () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (repo: string, file: string, text: string) => writeFileSync(path.join(repo, file), text);
  /** Repo con base + commits que tocan archivos distintos. */
  const repoWith = (name: string, files: string[]) => {
    const dir = path.join(tmp, name);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    write(dir, 'base.txt', 'base\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    for (const f of files) {
      write(dir, f, `${f}\n`);
      git(dir, 'add', f);
      git(dir, 'commit', '-q', '-m', `add ${f}`);
    }
    return dir;
  };
  const hashOf = (repo: string, subject: string) => git(repo, 'log', '--all', '--format=%H', `--grep=^${subject}$`);

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    tmp = mkdtempSync(path.join(tmpdir(), 'multigit-logactions-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('cherry-pick y revert de varios commits, en orden', async () => {
    const dir = repoWith('cp', []);
    git(dir, 'checkout', '-q', '-b', 'feature');
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      write(dir, f, `${f}\n`);
      git(dir, 'add', f);
      git(dir, 'commit', '-q', '-m', `add ${f}`);
    }
    git(dir, 'checkout', '-q', 'main');
    const service = new GitService(dir);
    // Elegidos a y c (del más viejo al más nuevo).
    await service.cherryPickMany([hashOf(dir, 'add a.txt'), hashOf(dir, 'add c.txt')]);
    expect(git(dir, 'log', '--format=%s', '-2')).toBe('add c.txt\nadd a.txt');
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false);
    // Revert de los dos (del más nuevo al más viejo).
    const [c, a] = git(dir, 'log', '--format=%H', '-2').split('\n');
    await service.revertMany([c!, a!]);
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(false);
    expect(existsSync(path.join(dir, 'c.txt'))).toBe(false);
    expect(git(dir, 'log', '--format=%s', '-2')).toBe('Revert "add a.txt"\nRevert "add c.txt"');
  });

  it('squash de commits no seguidos con mensaje propio', async () => {
    const dir = repoWith('squash', ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    const service = new GitService(dir);
    const a = hashOf(dir, 'add a.txt');
    const c = hashOf(dir, 'add c.txt');
    const { base, commits } = await service.rebaseCommits(a);
    const plan = squashPlan(commits, [a, c], 'feat: a y c\n\ncuerpo')!;
    await service.interactiveRebase(base, plan, { autostash: true });
    expect(git(dir, 'log', '--format=%s', '-4')).toBe('add d.txt\nadd b.txt\nfeat: a y c\nbase');
    expect(git(dir, 'show', '--format=', '--name-only', 'HEAD~2').split('\n').sort()).toEqual(['a.txt', 'c.txt']);
    expect(git(dir, 'log', '-1', '--format=%B', 'HEAD~2')).toBe('feat: a y c\n\ncuerpo');
  });

  it('patch de varios commits que tocan el mismo archivo', async () => {
    const dir = repoWith('multi-patch', []);
    write(dir, 'base.txt', 'uno\n');
    git(dir, 'commit', '-q', '-am', 'uno');
    write(dir, 'base.txt', 'uno\ndos\n');
    git(dir, 'commit', '-q', '-am', 'dos');
    const service = new GitService(dir);
    const [dos, uno] = git(dir, 'log', '--format=%H', '-2').split('\n');
    const patch = await service.commitsPatch([uno!, dos!]);
    expect(parsePatch(patch).map(patchPath)).toEqual(['base.txt', 'base.txt']);
    git(dir, 'reset', '-q', '--hard', 'HEAD~2');
    await service.applyPatch(patch, 'check');
    await service.applyPatch(patch, 'apply');
    expect(readFileSync(path.join(dir, 'base.txt'), 'utf8')).toBe('uno\ndos\n');
  });

  it('padres, hijos, archivos en una revisión y Get from Revision', async () => {
    const dir = repoWith('nav', ['a.txt']);
    const service = new GitService(dir);
    const base = hashOf(dir, 'base');
    const a = hashOf(dir, 'add a.txt');
    git(dir, 'branch', 'otra', base);
    git(dir, 'checkout', '-q', 'otra');
    write(dir, 'o.txt', 'o\n');
    git(dir, 'add', 'o.txt');
    git(dir, 'commit', '-q', '-m', 'otra');
    git(dir, 'checkout', '-q', 'main');
    expect(await service.parentsOf(a)).toEqual([base]);
    expect(await service.parentsOf(base)).toEqual([]);
    expect((await service.childrenOf(base)).sort()).toEqual([a, hashOf(dir, 'otra')].sort());
    expect(await service.childrenOf(a)).toEqual([]);
    expect(await service.filesAt(base)).toEqual(['base.txt']);
    expect(await service.filesAt(a)).toEqual(['a.txt', 'base.txt']);

    write(dir, 'base.txt', 'cambiado\n');
    await service.restoreFromRevision(base, 'base.txt', false);
    expect(readFileSync(path.join(dir, 'base.txt'), 'utf8')).toBe('base\n');
    // En `base` a.txt no existía: traer esa revisión lo borra.
    await service.restoreFromRevision(base, 'a.txt', true);
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('D  a.txt');
  });

  it('push y borrado de un tag (local y remoto)', async () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const dir = repoWith('tags', ['a.txt']);
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'tag', 'v1.0');
    git(dir, 'tag', 'v2.0');
    const service = new GitService(dir);
    await service.pushTag('origin', 'v1.0');
    expect(git(remote, 'tag')).toBe('v1.0');
    await service.deleteRemoteTag('origin', 'v1.0');
    expect(git(remote, 'tag')).toBe('');
    await service.deleteTag('v1.0');
    expect(await service.listTags()).toEqual(['v2.0']);
  });
});
