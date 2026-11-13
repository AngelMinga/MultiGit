// Detalle de un commit en el Git Log: grupos de archivos (en un merge, uno por padre) y ramas que lo contienen.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';

let root: string;
let git: GitService;
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (f: string, s: string) => writeFileSync(path.join(root, f), s);

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  root = mkdtempSync(path.join(tmpdir(), 'multigit-details-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  write('a.txt', 'a\n');
  write('comun.txt', '1\n2\n3\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  run('checkout', '-q', '-b', 'feature');
  write('feature.txt', 'f\n');
  write('comun.txt', '1\n2\nfeature\n');
  run('add', '.');
  run('commit', '-q', '-m', 'feat: feature');
  run('checkout', '-q', 'main');
  write('main.txt', 'm\n');
  write('comun.txt', 'main\n2\n3\n');
  run('add', '.');
  run('commit', '-q', '-m', 'feat: main');
  run('merge', '-q', '--no-edit', 'feature');
  git = new GitService(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('commitFileGroups', () => {
  it('commit normal: un grupo contra su padre', async () => {
    const groups = await git.commitFileGroups(run('rev-parse', 'HEAD^1'));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.map((f) => f.path).sort()).toEqual(['comun.txt', 'main.txt']);
  });

  it('merge: lo cambiado respecto a todos los padres y un grupo por padre', async () => {
    const groups = await git.commitFileGroups(run('rev-parse', 'HEAD'));
    expect(groups.map((g) => [g.merged ?? false, g.parentSubject ?? '', g.files.map((f) => f.path).sort()])).toEqual([
      [true, '', ['comun.txt']],
      [false, 'feat: main', ['comun.txt', 'feature.txt']],
      [false, 'feat: feature', ['comun.txt', 'main.txt']],
    ]);
  });

  it('commit raíz: sin padre', async () => {
    const groups = await git.commitFileGroups(run('rev-list', '--max-parents=0', 'HEAD'));
    expect(groups[0]!.parent).toBeNull();
    expect(groups[0]!.files.map((f) => f.path).sort()).toEqual(['a.txt', 'comun.txt']);
  });
});

describe('branchesContaining', () => {
  it('ramas locales que contienen el commit y si está en HEAD', async () => {
    expect(await git.branchesContaining(run('rev-parse', 'feature'))).toEqual({ branches: ['feature', 'main'], inHead: true });
    expect(await git.branchesContaining(run('rev-parse', 'HEAD'))).toEqual({ branches: ['main'], inHead: true });
  });
});
