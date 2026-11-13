// Commit parcial: parseo de `git diff -U0` y contenido con solo las líneas elegidas, contra git real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allLineIds, buildPartial, hunkRows, parseHunks, splitLines } from '../src/git/hunks';

// Se crea al cargar el archivo: algunos describe calculan el diff al declararse.
const dir = mkdtempSync(path.join(tmpdir(), 'multigit-hunks-'));
// Sin la config global del usuario (p. ej. core.autocrlf, que cambiaría el diff de los CRLF).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** `git diff -U0 --no-index` entre dos textos. */
function diff(oldText: string, newText: string): string {
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  writeFileSync(a, oldText);
  writeFileSync(b, newText);
  try {
    return execFileSync('git', ['diff', '--no-index', '-U0', '--no-color', '--', a, b], { encoding: 'utf8' });
  } catch (error) {
    return (error as { stdout: string }).stdout; // sale con 1 cuando hay diferencias
  }
}

function check(oldText: string, newText: string): void {
  const hunks = parseHunks(diff(oldText, newText))!;
  expect(buildPartial(oldText, hunks, new Set(allLineIds(hunks)))).toBe(newText);
  expect(buildPartial(oldText, hunks, new Set())).toBe(oldText);
}

describe('buildPartial con todo / nada elegido', () => {
  it('casos borde', () => {
    check('a\nb\nc\n', 'a\nB\nc\n');
    check('a\nb\nc\n', 'x\na\nb\nc\ny\n'); // añadidos al principio y al final
    check('a\nb\nc\n', 'c\n'); // borrados al principio
    check('', 'nuevo\n'); // archivo vacío
    check('a\nb', 'a\nb\nc'); // sin \n final
    check('a\nb\n', 'a\nb'); // quita el \n final
    check('a\nb', 'a\nb\n'); // añade el \n final
    check('a\r\nb\r\n', 'a\r\nB\r\n'); // CRLF
    check('uno\ndos\ntres\n', ''); // vacía el archivo
  });

  it('cambios aleatorios', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 60; round++) {
      const old = Array.from({ length: rand(15) }, (_, i) => `l${i}`);
      const next = [...old];
      for (let k = rand(6); k > 0; k--) {
        const op = rand(3);
        const at = rand(next.length + 1);
        if (op === 0) next.splice(at, 0, `n${round}_${k}`);
        else if (op === 1 && next.length) next.splice(Math.min(at, next.length - 1), 1);
        else if (next.length) next[Math.min(at, next.length - 1)] = `m${round}_${k}`;
      }
      const eol = (lines: string[], last: boolean) => lines.join('\n') + (lines.length && last ? '\n' : '');
      check(eol(old, rand(4) > 0), eol(next, rand(4) > 0));
    }
  });
});

describe('selección parcial', () => {
  const oldText = 'a\nb\nc\nd\ne\n';
  const newText = 'a\nB\nc\nd\nE\nf\n';
  const hunks = parseHunks(diff(oldText, newText))!;

  it('parsea los hunks con sus líneas', () => {
    expect(hunks.map((h) => h.lines.map((l) => `${l.id}:${l.text.trim()}`))).toEqual([
      ['d2:b', 'a2:B'],
      ['d5:e', 'a5:E', 'a6:f'],
    ]);
  });

  it('solo el primer hunk', () => {
    expect(buildPartial(oldText, hunks, new Set(['d2', 'a2']))).toBe('a\nB\nc\nd\ne\n');
  });

  it('solo una línea añadida del segundo hunk (sin borrar la vieja)', () => {
    expect(buildPartial(oldText, hunks, new Set(['a6']))).toBe('a\nb\nc\nd\ne\nf\n');
  });

  it('solo el borrado', () => {
    expect(buildPartial(oldText, hunks, new Set(['d5']))).toBe('a\nb\nc\nd\n');
  });

  it('una línea añadida tras una última línea sin \\n la separa con \\n', () => {
    const h = parseHunks(diff('a', 'a2\nb\n'))!;
    const added = h[0]!.lines.filter((l) => l.kind === 'add' && l.text === 'b\n').map((l) => l.id);
    expect(buildPartial('a', h, new Set(added))).toBe('a\nb\n');
  });

  it('binarios: undefined', () => {
    expect(parseHunks('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toBeUndefined();
  });
});

describe('hunkRows', () => {
  it('contexto alrededor sin repetir líneas y con números de línea', () => {
    const oldText = splitLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n').join('');
    const newText = '1\n2\nX\n4\n5\n6\n7\n8\nY\nZ\n10\n';
    const rows = hunkRows(oldText, parseHunks(diff(oldText, newText))!, 2);
    expect(rows.map((h) => h.map((r) => `${r.kind}:${r.text.trim()}:${r.oldNo ?? ''}/${r.newNo ?? ''}`))).toEqual([
      ['ctx:1:1/1', 'ctx:2:2/2', 'del:3:3/', 'add:X:/3', 'ctx:4:4/4', 'ctx:5:5/5'],
      ['ctx:7:7/7', 'ctx:8:8/8', 'del:9:9/', 'add:Y:/9', 'add:Z:/10', 'ctx:10:10/11'],
    ]);
  });
});

describe('commitPartial (git real)', () => {
  it('commitea solo los hunks elegidos, más archivos completos; el resto queda sin commit', async () => {
    const { GitService } = await import('../src/git/GitService');
    const { readFileSync } = await import('node:fs');
    const root = path.join(dir, 'repo');
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' },
      });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    writeFileSync(path.join(root, 'app.js'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
    writeFileSync(path.join(root, 'old.js'), 'viejo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    writeFileSync(path.join(root, 'app.js'), 'a\nB\nc\nd\ne\nf\ng\nH\n'); // dos hunks
    writeFileSync(path.join(root, 'nuevo.js'), 'n\n'); // sin versionar, completo
    git('rm', '-q', 'old.js'); // borrado, completo
    writeFileSync(path.join(root, 'otro.js'), 'no se commitea\n');
    git('add', 'otro.js'); // staged pero NO elegido: no debe entrar

    const service = new GitService(root);
    const hunks = parseHunks(await service.diffForPartial('app.js'))!;
    expect(hunks).toHaveLength(2);
    const first = new Set(hunks[0]!.lines.map((l) => l.id));
    const content = buildPartial(git('show', 'HEAD:app.js'), hunks, first);
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'T';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@e.com';
    await service.commitPartial('feat: parcial', ['nuevo.js', 'old.js'], [{ path: 'app.js', content }], false);

    expect(git('show', 'HEAD:app.js')).toBe('a\nB\nc\nd\ne\nf\ng\nh\n');
    expect(git('show', 'HEAD:nuevo.js')).toBe('n\n');
    expect(git('ls-tree', '--name-only', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['app.js', 'nuevo.js']);
    // El working tree no se toca; lo no elegido sigue como cambio y otro.js sigue staged.
    expect(readFileSync(path.join(root, 'app.js'), 'utf8')).toBe('a\nB\nc\nd\ne\nf\ng\nH\n');
    expect(git('status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' M app.js', 'A  otro.js']);
    expect(git('diff', '-U0', '--', 'app.js')).toContain('+H');
    expect(git('log', '--format=%s')).toBe('feat: parcial\ninit\n');
  });
});
