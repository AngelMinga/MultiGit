// Annotate: parseo de `git blame --line-porcelain`, niveles de antigüedad y patches de archivos sueltos
// de un commit (Cherry-Pick / Revert Selected Changes), con git real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageLevels, parseBlame, shortAuthor, UNCOMMITTED, type BlameLine } from '../src/git/blame';
import { GitService } from '../src/git/GitService';

describe('niveles y autor', () => {
  it('el más reciente es 0; sin commit no cuenta', () => {
    const line = (hash: string, time: number): BlameLine => ({ hash, author: 'a', email: '', time, summary: '', path: 'f' });
    const levels = ageLevels([line('a', 1), line('b', 3), line('c', 2), line(UNCOMMITTED, 9), line('b', 3)], 3);
    expect([levels.get('b'), levels.get('c'), levels.get('a')]).toEqual([0, 1, 2]);
    expect(levels.has(UNCOMMITTED)).toBe(false);
    expect(ageLevels([line('x', 1)]).get('x')).toBe(0);
    expect(shortAuthor('Angel Fernando Minga Pérez', 10)).toBe('Angel Fer…');
  });
});

describe('git real', () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (repo: string, file: string, text: string) => writeFileSync(path.join(repo, file), text);
  const commitAs = (repo: string, who: string, message: string, when: string) =>
    execFileSync('git', ['commit', '-q', '-am', message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@x.com`, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    tmp = mkdtempSync(path.join(tmpdir(), 'multigit-blame-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('blame por línea, con renombre, texto sin guardar y revisión anterior', async () => {
    const dir = path.join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    write(dir, 'viejo.txt', 'uno\ndos\ntres\n');
    git(dir, 'add', '.');
    commitAs(dir, 'Ana', 'base', '2026-01-01T10:00:00Z');
    git(dir, 'mv', 'viejo.txt', 'nuevo.txt');
    write(dir, 'nuevo.txt', 'uno\nDOS\ntres\n');
    git(dir, 'add', '.');
    commitAs(dir, 'Luis', 'feat: dos en mayúsculas', '2026-02-01T10:00:00Z');
    const service = new GitService(dir);

    const lines = parseBlame(await service.blame('nuevo.txt'));
    expect(lines.map((l) => `${l.author}|${l.path}`)).toEqual(['Ana|viejo.txt', 'Luis|nuevo.txt', 'Ana|viejo.txt']);
    expect(lines[1]!.summary).toBe('feat: dos en mayúsculas');
    expect(lines[1]!.email).toBe('luis@x.com');
    expect(lines[1]!.time).toBe(Date.parse('2026-02-01T10:00:00Z'));
    // La línea 2 viene de base, con la ruta vieja: Annotate Previous Revision abre esa.
    expect(lines[1]!.previous).toEqual({ hash: lines[0]!.hash, path: 'viejo.txt' });

    // Texto del editor sin guardar: la línea nueva sale sin commit.
    const unsaved = parseBlame(await service.blame('nuevo.txt', { contents: 'uno\nDOS\nnueva\ntres\n' }));
    expect(unsaved.map((l) => (l.hash === UNCOMMITTED ? '-' : l.author))).toEqual(['Ana', 'Luis', '-', 'Ana']);

    // En una revisión concreta.
    const before = parseBlame(await service.blame('viejo.txt', { rev: lines[0]!.hash }));
    expect(before.map((l) => l.author)).toEqual(['Ana', 'Ana', 'Ana']);
  });

  it('cherry-pick y revert de solo algunos archivos de un commit', async () => {
    const dir = path.join(tmp, 'sel');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    write(dir, 'a.txt', 'a\n');
    write(dir, 'b.txt', 'b\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'a.txt', 'a feature\n');
    write(dir, 'b.txt', 'b feature\n');
    write(dir, 'c.txt', 'c nuevo\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feature');
    const hash = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    const service = new GitService(dir);

    // Cherry-pick de a.txt y c.txt (no b.txt) al working tree.
    const patch = await service.commitFilesPatch(hash, null, ['a.txt', 'c.txt'], false);
    await service.applyPatch(patch, 'apply');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a feature\n');
    expect(readFileSync(path.join(dir, 'c.txt'), 'utf8')).toBe('c nuevo\n');
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b\n');
    git(dir, 'checkout', '-q', '.');
    git(dir, 'clean', '-qfd');

    // Revert de b.txt en la rama del commit.
    git(dir, 'checkout', '-q', 'feature');
    await service.applyPatch(await service.commitFilesPatch(hash, null, ['b.txt'], true), 'apply');
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a feature\n');
    expect(git(dir, 'status', '--porcelain')).toBe('M b.txt');
  });
});
