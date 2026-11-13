// Opciones de merge (--no-ff, --squash, --ff-only, mensaje propio) con git real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let root: string;
let git: GitService;
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'multigit-mergeopts-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  run('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(root, 'f.txt'), 'f\n');
  run('add', '.');
  run('commit', '-q', '-m', 'feat: f');
  run('checkout', '-q', 'main');
  git = new GitService(root);
});

describe('merge con opciones', () => {
  it('normal: fast-forward', async () => {
    await git.merge('feature');
    expect(run('log', '-1', '--format=%s')).toBe('feat: f');
  });

  it('--no-ff con mensaje propio: commit de merge aunque pudiera avanzar', async () => {
    await git.merge('feature', ['--no-ff'], 'Merge feature (revisado)');
    expect(run('log', '-1', '--format=%s')).toBe('Merge feature (revisado)');
    expect(run('log', '-1', '--format=%p').split(' ')).toHaveLength(2);
  });

  it('--squash: deja los cambios preparados sin commit', async () => {
    await git.merge('feature', ['--squash']);
    expect(run('log', '-1', '--format=%s')).toBe('init');
    expect(run('status', '--porcelain')).toBe('A  f.txt');
  });

  it('--ff-only falla si hay que crear un commit de merge', async () => {
    writeFileSync(path.join(root, 'm.txt'), 'm\n');
    run('add', '.');
    run('commit', '-q', '-m', 'feat: m');
    await expect(git.merge('feature', ['--ff-only'])).rejects.toThrow();
  });
});
