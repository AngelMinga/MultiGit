// Shelf (Unshelve de archivos sueltos, rehacer el shelf con los que quedan, renombrar) y merge con
// --autostash, con git real.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { SHELF_PREFIX } from '../src/git/stashes';

describe('shelf y merge (git real)', () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (repo: string, file: string, text: string) => writeFileSync(path.join(repo, file), text);
  const read = (repo: string, file: string) => readFileSync(path.join(repo, file), 'utf8');
  const init = (name: string) => {
    const dir = path.join(tmp, name);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    write(dir, 'a.txt', 'a\n');
    write(dir, 'b.txt', 'b\n');
    write(dir, 'c.txt', 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
  };

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    tmp = mkdtempSync(path.join(tmpdir(), 'multigit-shelf-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('unshelve de algunos archivos y el shelf se rehace con los que quedan', async () => {
    const dir = init('partial');
    write(dir, 'a.txt', 'a cambiado\n');
    write(dir, 'b.txt', 'b cambiado\n');
    git(dir, 'rm', '-q', 'c.txt'); // borrado preparado: también se puede apartar
    write(dir, 'nuevo.txt', 'nuevo\n');
    const service = new GitService(dir);
    await service.stashPush('trabajo', ['a.txt', 'b.txt', 'c.txt', 'nuevo.txt']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const [shelf] = await service.listStashes();
    const files = await service.stashFiles(shelf!.hash);
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'nuevo.txt']);

    // Unshelve de a.txt y del nuevo (sin versionar).
    const chosen = files.filter((f) => f.path === 'a.txt' || f.path === 'nuevo.txt');
    const patch = await service.stashPatch(shelf!.hash, chosen);
    await service.applyPatch(patch, 'check');
    await service.applyPatch(patch, 'apply');
    expect(read(dir, 'a.txt')).toBe('a cambiado\n');
    expect(read(dir, 'nuevo.txt')).toBe('nuevo\n');
    expect(read(dir, 'b.txt')).toBe('b\n');

    // El shelf se rehace solo con b.txt y el borrado de c.txt, con el mismo nombre.
    const rest = files.filter((f) => !chosen.includes(f));
    await service.rebuildStash(shelf!.hash, rest, `On main: ${SHELF_PREFIX}trabajo`);
    await service.stashDrop('stash@{1}');
    const after = await service.listStashes();
    expect(after).toHaveLength(1);
    expect(after[0]!.message).toBe(`${SHELF_PREFIX}trabajo`);
    expect(after[0]!.branch).toBe('main');
    expect((await service.stashFiles(after[0]!.hash)).map((f) => `${f.status} ${f.path}`).sort()).toEqual(['D c.txt', 'M b.txt']);

    // Y el resto se aplica bien después.
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'parte aplicada');
    await service.stashPop('stash@{0}');
    expect(read(dir, 'b.txt')).toBe('b cambiado\n');
    expect(existsSync(path.join(dir, 'c.txt'))).toBe(false);
  });

  it('rehacer un shelf con un archivo sin versionar que queda', async () => {
    const dir = init('untracked');
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'u1.txt', 'u1\n');
    write(dir, 'u2.txt', 'u2\n');
    const service = new GitService(dir);
    await service.stashPush('mixto', ['a.txt', 'u1.txt', 'u2.txt']);
    const [shelf] = await service.listStashes();
    const files = await service.stashFiles(shelf!.hash);
    await service.rebuildStash(shelf!.hash, files.filter((f) => f.path === 'u2.txt'), `On main: ${SHELF_PREFIX}mixto`);
    const [rebuilt] = await service.listStashes();
    expect((await service.stashFiles(rebuilt!.hash)).map((f) => f.path)).toEqual(['u2.txt']);
    await service.stashPop('stash@{0}');
    expect(read(dir, 'u2.txt')).toBe('u2\n');
    expect(existsSync(path.join(dir, 'u1.txt'))).toBe(false);
  });

  it('renombrar un shelf: stash store + borrar el viejo', async () => {
    const dir = init('rename');
    write(dir, 'a.txt', 'x\n');
    const service = new GitService(dir);
    await service.stashPush('viejo', ['a.txt']);
    const [shelf] = await service.listStashes();
    const copy = await service.renameStash(shelf!.hash, `On main: ${SHELF_PREFIX}nuevo`);
    expect((await service.listStashes()).map((s) => s.hash)).toEqual([copy, shelf!.hash]);
    await service.stashDrop('stash@{1}');
    const list = await service.listStashes();
    expect(list.map((s) => `${s.branch}|${s.message}`)).toEqual([`main|${SHELF_PREFIX}nuevo`]);
    // Mismo contenido.
    expect(git(dir, 'rev-parse', `${copy}^{tree}`)).toBe(git(dir, 'rev-parse', `${shelf!.hash}^{tree}`));
    await service.stashPop('stash@{0}');
    expect(read(dir, 'a.txt')).toBe('x\n');
  });

  it('merge con cambios sin commit: se apartan y vuelven (también tras un conflicto)', async () => {
    const dir = init('merge');
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'a.txt', 'a feature\n');
    git(dir, 'commit', '-q', '-am', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'b.txt', 'b local\n');
    const service = new GitService(dir);
    await service.merge('feature');
    expect(read(dir, 'a.txt')).toBe('a feature\n');
    expect(read(dir, 'b.txt')).toBe('b local\n');
    expect(git(dir, 'stash', 'list')).toBe('');

    // Conflicto: los cambios locales esperan aparte y vuelven al terminar el merge.
    git(dir, 'checkout', '-q', 'b.txt');
    git(dir, 'checkout', '-q', '-b', 'otra', 'HEAD~1');
    write(dir, 'a.txt', 'a otra\n');
    git(dir, 'commit', '-q', '-am', 'otra');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'c.txt', 'c local\n');
    await expect(service.merge('otra')).rejects.toThrow();
    expect(read(dir, 'c.txt')).toBe('c\n');
    write(dir, 'a.txt', 'a resuelto\n');
    git(dir, 'add', 'a.txt');
    await service.continueOperation('merge');
    expect(read(dir, 'c.txt')).toBe('c local\n');
    expect(git(dir, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
  });
});
