// Stashes: parseo de `git stash list`, agrupación entre repos y operaciones con git real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { groupStashes, parseStashList, shelfName, type StashEntry } from '../src/git/stashes';

describe('parseStashList', () => {
  it('separa ref, hash, fecha, rama y mensaje', () => {
    const out = ['stash@{0}\0aaa\x00100\0On dev-x: MultiGit: wip login', 'stash@{1}\0bbb\x00200\0WIP on develop: abc1234 algo', 'stash@{2}\0ccc\x00300\0sin prefijo', ''].join('\n');
    expect(parseStashList(out)).toEqual([
      { ref: 'stash@{0}', hash: 'aaa', time: 100_000, branch: 'dev-x', message: 'MultiGit: wip login' },
      { ref: 'stash@{1}', hash: 'bbb', time: 200_000, branch: 'develop', message: 'abc1234 algo' },
      { ref: 'stash@{2}', hash: 'ccc', time: 300_000, branch: '', message: 'sin prefijo' },
    ]);
  });

  it('HEAD suelto: sin rama', () => {
    expect(parseStashList('stash@{0}\0aaa\x001\0WIP on (no branch): abc x\n')[0]!.branch).toBe('');
  });

  it('shelfName reconoce los stashes de Shelve', () => {
    expect(shelfName('MultiGit: login')).toBe('login');
    expect(shelfName('WIP on develop')).toBeUndefined();
  });
});

describe('groupStashes', () => {
  const s = (hash: string, message: string, minutes: number): StashEntry => ({ ref: 'stash@{0}', hash, time: minutes * 60_000, branch: 'dev-x', message });

  it('junta el mismo mensaje en varios repos si se crearon casi a la vez', () => {
    const groups = groupStashes([
      { repo: 'b', stashes: [s('b1', 'WIP login', 100)] },
      { repo: 'a', stashes: [s('a1', 'WIP login', 101), s('a2', 'viejo', 10)] },
    ]);
    expect(groups.map((g) => [g.message, g.entries.map((e) => e.repo)])).toEqual([
      ['WIP login', ['b', 'a']],
      ['viejo', ['a']],
    ]);
    expect(groups[0]!.time).toBe(101 * 60_000);
  });

  it('no junta dos stashes del mismo repo ni stashes muy separados en el tiempo', () => {
    const groups = groupStashes([
      { repo: 'a', stashes: [s('a1', 'WIP', 100), s('a2', 'WIP', 99)] },
      { repo: 'b', stashes: [s('b1', 'WIP', 300)] },
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.stash.hash))).toEqual([['b1'], ['a1'], ['a2']]);
  });
});

describe('stash con git real', () => {
  let base: string;
  let repo: GitService;
  const write = (f: string, content: string) => writeFileSync(path.join(repo.root, f), content);
  const read = (f: string) => readFileSync(path.join(repo.root, f), 'utf8');

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    base = mkdtempSync(path.join(tmpdir(), 'multigit-stash-'));
    const root = path.join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'develop', root]);
    writeFileSync(path.join(root, 'a.js'), 'a');
    writeFileSync(path.join(root, 'b.js'), 'b');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
    repo = new GitService(root);
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('stash con archivos sin versionar: lista, archivos, apply, drop', async () => {
    write('a.js', 'a2');
    write('nuevo.js', 'n');
    await repo.stashAll('WIP login', { untracked: true });
    expect(await repo.getChanges()).toEqual([]);

    const [entry] = await repo.listStashes();
    expect(entry).toMatchObject({ ref: 'stash@{0}', branch: 'develop', message: 'WIP login' });
    expect(entry!.time).toBeGreaterThan(Date.now() - 60_000);

    const files = await repo.stashFiles(entry!.hash);
    expect(files.map((f) => [f.status, f.path, Boolean(f.untracked)])).toEqual([
      ['M', 'a.js', false],
      ['A', 'nuevo.js', true],
    ]);
    expect(await repo.showFile(`${entry!.hash}^3`, 'nuevo.js')).toBe('n');

    await repo.stashApply(entry!.ref);
    expect(read('a.js')).toBe('a2');
    expect(read('nuevo.js')).toBe('n');
    expect(await repo.listStashes()).toHaveLength(1);

    await repo.stashDrop(entry!.ref);
    expect(await repo.listStashes()).toEqual([]);
  });

  it('sin -u los sin versionar se quedan; stash branch crea la rama con los cambios', async () => {
    write('b.js', 'b2');
    await repo.stashAll('a y b', {});
    expect((await repo.getChanges()).map((f) => f.path)).toEqual(['nuevo.js']);
    rmSync(path.join(repo.root, 'nuevo.js'));

    const [entry] = await repo.listStashes();
    expect((await repo.stashFiles(entry!.hash)).map((f) => f.path)).toEqual(['a.js', 'b.js']);
    await repo.stashBranch('a-y-b', entry!.ref);
    expect((await repo.getStatus()).branch).toBe('a-y-b');
    expect(read('b.js')).toBe('b2');
    expect(await repo.listStashes()).toEqual([]);
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: repo.root });
  });

  it('stash clear borra todos', async () => {
    write('a.js', 'x');
    await repo.stashAll('uno');
    write('a.js', 'y');
    await repo.stashAll('dos');
    expect((await repo.listStashes()).map((s) => s.message)).toEqual(['dos', 'uno']);
    await repo.stashClear();
    expect(await repo.listStashes()).toEqual([]);
  });
});
