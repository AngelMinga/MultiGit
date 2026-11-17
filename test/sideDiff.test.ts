// Diff lado a lado: los bloques reconstruyen los dos archivos y sus índices son correctos.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allLineIds, parseHunks } from '../src/git/hunks';
import { type SideBlock, sideBlocks, wholeFileBlocks } from '../src/git/sideDiff';

const dir = mkdtempSync(path.join(tmpdir(), 'multigit-sidediff-'));
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function diff(oldText: string, newText: string): string {
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  writeFileSync(a, oldText);
  writeFileSync(b, newText);
  try {
    return execFileSync('git', ['diff', '--no-index', '-U0', '--no-color', '--', a, b], { encoding: 'utf8' });
  } catch (error) {
    return (error as { stdout: string }).stdout;
  }
}

/** Comprueba que los bloques dan los dos textos y que cada bloque empieza donde dice. */
function check(oldText: string, newText: string): SideBlock[] {
  const hunks = parseHunks(diff(oldText, newText))!;
  const blocks = sideBlocks(oldText, hunks);
  let o = 0;
  let n = 0;
  let left = '';
  let right = '';
  for (const b of blocks) {
    expect(b.oldIndex).toBe(o);
    expect(b.newIndex).toBe(n);
    const l = b.type === 'stable' ? b.lines : b.old;
    const r = b.type === 'stable' ? b.lines : b.new;
    left += l.join('');
    right += r.join('');
    o += l.length;
    n += r.length;
  }
  expect(left).toBe(oldText);
  expect(right).toBe(newText);
  expect(blocks.flatMap((b) => (b.type === 'change' ? b.ids : []))).toEqual(allLineIds(hunks));
  return blocks;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

describe('sideBlocks', () => {
  it('cambio en medio', () => {
    const blocks = check(lines(10), lines(10).replace('line 5\n', 'cinco\n'));
    expect(blocks.map((b) => b.type)).toEqual(['stable', 'change', 'stable']);
  });

  it('solo añadidos y solo borrados', () => {
    check(lines(6), lines(6).replace('line 3\n', 'line 3\nnew a\nnew b\n'));
    check(lines(6), lines(6).replace('line 3\nline 4\n', ''));
  });

  it('cambios al principio y al final', () => {
    const blocks = check(lines(5), `cero\n${lines(5)}fin\n`);
    expect(blocks[0]!.type).toBe('change');
    expect(blocks[blocks.length - 1]!.type).toBe('change');
  });

  it('varios hunks y archivo sin \\n final', () => {
    check(lines(30), lines(30).replace('line 2\n', 'dos\n').replace('line 15\n', '').replace('line 30\n', 'treinta'));
  });

  it('archivo entero añadido o borrado', () => {
    expect(wholeFileBlocks('', 'a\nb\n')).toEqual([{ type: 'change', oldIndex: 0, newIndex: 0, old: [], new: ['a\n', 'b\n'], ids: [] }]);
    expect(wholeFileBlocks('a\n', '')[0]).toMatchObject({ old: ['a\n'], new: [] });
    expect(wholeFileBlocks('', '')).toEqual([]);
  });
});
