// Merge a tres bandas de la ventana de merge propia, comparado con `git merge-file`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHunks } from '../src/git/hunks';
import { autoMerge, merge3 } from '../src/git/merge3';

const dir = mkdtempSync(path.join(tmpdir(), 'multigit-merge3-'));
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function diff(a: string, b: string): string {
  writeFileSync(path.join(dir, 'a'), a);
  writeFileSync(path.join(dir, 'b'), b);
  try {
    return execFileSync('git', ['diff', '--no-index', '-U0', '--no-color', '--', path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
  } catch (error) {
    return (error as { stdout: string }).stdout;
  }
}

function blocksOf(base: string, ours: string, theirs: string) {
  return merge3(base, parseHunks(diff(base, ours))!, parseHunks(diff(base, theirs))!);
}

/** `git merge-file -p`: texto y si hubo conflictos. */
function gitMerge(base: string, ours: string, theirs: string): { text: string; conflict: boolean } {
  writeFileSync(path.join(dir, 'o'), ours);
  writeFileSync(path.join(dir, 'base'), base);
  writeFileSync(path.join(dir, 't'), theirs);
  try {
    return { text: execFileSync('git', ['merge-file', '-p', path.join(dir, 'o'), path.join(dir, 'base'), path.join(dir, 't')], { encoding: 'utf8' }), conflict: false };
  } catch (error) {
    return { text: (error as { stdout: string }).stdout, conflict: true };
  }
}

describe('merge3', () => {
  it('cambios en zonas distintas: sin conflicto, igual que git', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\n';
    const ours = 'A\nb\nc\nd\ne\nf\ng\n';
    const theirs = 'a\nb\nc\nd\ne\nf\nG\nh\n';
    const blocks = blocksOf(base, ours, theirs);
    expect(blocks.filter((b) => b.type === 'change').map((b) => b.type === 'change' && b.kind)).toEqual(['ours', 'theirs']);
    expect(autoMerge(blocks)).toEqual({ text: gitMerge(base, ours, theirs).text, conflicts: 0 });
  });

  it('misma línea cambiada distinto: conflicto con base, tuyos y otros', () => {
    const blocks = blocksOf('a\nb\nc\n', 'a\nB1\nc\n', 'a\nB2\nc\n');
    expect(blocks).toEqual([
      { type: 'stable', lines: ['a\n'] },
      { type: 'change', kind: 'conflict', base: ['b\n'], ours: ['B1\n'], theirs: ['B2\n'] },
      { type: 'stable', lines: ['c\n'] },
    ]);
    expect(autoMerge(blocks).conflicts).toBe(1);
  });

  it('el mismo cambio en los dos lados no es conflicto', () => {
    const blocks = blocksOf('a\nb\n', 'a\nX\n', 'a\nX\n');
    expect(blocks.map((b) => (b.type === 'change' ? b.kind : 'stable'))).toEqual(['stable', 'same']);
  });

  it('aleatorio: mismo resultado y mismos conflictos que git merge-file', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const mutate = (lines: string[], tag: string) => {
      const next = [...lines];
      for (let k = rand(3) + 1; k > 0; k--) {
        const at = rand(next.length + 1);
        const op = rand(3);
        if (op === 0) next.splice(at, 0, `${tag}${k}`);
        else if (op === 1 && next.length) next.splice(Math.min(at, next.length - 1), 1);
        else if (next.length) next[Math.min(at, next.length - 1)] = `${tag}m${k}`;
      }
      return next;
    };
    let same = 0;
    for (let round = 0; round < 150; round++) {
      const base = Array.from({ length: 6 + rand(20) }, (_, i) => `l${i}`);
      const text = (l: string[]) => (l.length ? `${l.join('\n')}\n` : '');
      const [b, o, t] = [text(base), text(mutate(base, 'o')), text(mutate(base, 't'))];
      const git = gitMerge(b, o, t);
      const ours = autoMerge(blocksOf(b, o, t));
      expect(ours.conflicts > 0, `ronda ${round}`).toBe(git.conflict);
      if (!git.conflict) {
        expect(ours.text, `ronda ${round}`).toBe(git.text);
        same++;
      }
    }
    expect(same).toBeGreaterThan(30);
  }, 60_000); // ~450 llamadas a git: con todos los tests en paralelo tarda más de 5 s
});
