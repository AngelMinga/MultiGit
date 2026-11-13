// Checkout con cambios locales: detectar qué se sobrescribiría y Smart Checkout (stash → checkout → pop).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';

let root: string;
let git: GitService;
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (f: string, s: string) => writeFileSync(path.join(root, f), s);
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  root = mkdtempSync(path.join(tmpdir(), 'multigit-smart-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  write('hook.js', 'uno\ndos\ntres\n');
  write('otro.js', 'a\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  // develop cambia la última línea de hook.js y añade nuevo.js.
  run('checkout', '-q', '-b', 'develop');
  write('hook.js', 'uno\ndos\nTRES\n');
  write('nuevo.js', 'de develop\n');
  run('add', '.');
  run('commit', '-q', '-m', 'develop');
  run('checkout', '-q', 'main');
  git = new GitService(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  run('checkout', '-q', '-f', 'main');
  run('clean', '-qfd');
  run('stash', 'clear');
});

describe('wouldBeOverwritten', () => {
  it('versionados que cambian entre ramas y sin versionar que existen en la otra', async () => {
    write('hook.js', 'UNO\ndos\ntres\n'); // choca: develop también cambia hook.js
    write('otro.js', 'b\n'); // no choca: develop no toca otro.js
    write('nuevo.js', 'mío\n'); // sin versionar que existe en develop
    write('libre.js', 'x\n'); // sin versionar que no existe en develop
    const files = await git.getChanges();
    expect(await git.wouldBeOverwritten('develop', files)).toEqual(['hook.js', 'nuevo.js']);
    // git de verdad se niega:
    expect(() => run('checkout', '-q', 'develop')).toThrow();
  });

  it('sin cambios que choquen: lista vacía', async () => {
    write('otro.js', 'b\n');
    expect(await git.wouldBeOverwritten('develop', await git.getChanges())).toEqual([]);
  });
});

describe('smartCheckout', () => {
  it('sin conflicto: cambia de rama y mantiene los cambios (sin stash de sobra)', async () => {
    write('hook.js', 'UNO\ndos\ntres\n'); // primera línea; develop cambia la última → se combinan
    const result = await git.smartCheckout('develop', () => git.checkout('develop'));
    expect(result.conflicts).toEqual([]);
    expect((await git.getStatus()).branch).toBe('develop');
    expect(read('hook.js')).toBe('UNO\ndos\nTRES\n');
    expect(run('stash', 'list')).toBe('');
  });

  it('con conflicto: quedan las marcas para el merge editor y el stash como copia', async () => {
    write('hook.js', 'uno\ndos\nTres local\n'); // misma línea que develop
    const result = await git.smartCheckout('develop', () => git.checkout('develop'));
    expect(result.conflicts).toEqual(['hook.js']);
    expect((await git.getStatus()).branch).toBe('develop');
    expect(read('hook.js')).toContain('<<<<<<<');
    expect(run('stash', 'list')).toContain('MultiGit smart checkout → develop');
  });

  it('si el checkout falla, los cambios vuelven a su sitio', async () => {
    write('hook.js', 'UNO\ndos\ntres\n');
    await expect(git.smartCheckout('no-existe', () => git.checkout('no-existe'))).rejects.toThrow();
    expect((await git.getStatus()).branch).toBe('main');
    expect(read('hook.js')).toBe('UNO\ndos\ntres\n');
    expect(run('stash', 'list')).toBe('');
  });

  it('force: descarta lo que estorba', async () => {
    write('hook.js', 'UNO\ndos\ntres\n');
    await git.checkout('develop', true);
    expect(read('hook.js')).toBe('uno\ndos\nTRES\n');
  });
});
