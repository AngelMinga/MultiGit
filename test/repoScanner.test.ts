import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanForRepos } from '../src/git/repoScanner';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'multigit-scan-'));
  const mk = (...p: string[]) => mkdirSync(path.join(root, ...p), { recursive: true });
  mk('mftheme', '.git');
  mk('shell', '.git');
  mk('grupo', 'mflogin', '.git');
  mk('a', 'b', 'c', 'profundo', '.git');
  mk('mftheme', 'node_modules', 'dep', '.git');
  // worktree: `.git` es un archivo
  mk('worktree');
  writeFileSync(path.join(root, 'worktree', '.git'), 'gitdir: /otro/lugar\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanForRepos', () => {
  it('encuentra repos hasta la profundidad indicada, incluyendo worktrees', async () => {
    const found = (await scanForRepos(root, 2)).map((p) => path.relative(root, p));
    expect(found.sort()).toEqual([path.join('grupo', 'mflogin'), 'mftheme', 'shell', 'worktree']);
  });

  it('profundidad 0 solo revisa la raíz', async () => {
    expect(await scanForRepos(root, 0)).toEqual([]);
    expect(await scanForRepos(path.join(root, 'shell'), 0)).toEqual([path.join(root, 'shell')]);
  });

  it('salta node_modules', async () => {
    const found = await scanForRepos(root, 5);
    expect(found.some((p) => p.includes('node_modules'))).toBe(false);
    expect(found).toContain(path.join(root, 'a', 'b', 'c', 'profundo'));
  });
});
