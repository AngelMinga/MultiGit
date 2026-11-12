import { describe, expect, it } from 'vitest';
import { parseLog, parseNameStatusZ } from '../src/git/parsers';

describe('parseLog', () => {
  it('lee commits con decoraciones y sin ellas', () => {
    const out =
      ['a'.repeat(40), 'aaaaaaa', 'feat: push', 'Angel', '2026-11-11T08:51:00-05:00', 'HEAD -> dev-x, origin/dev-x, tag: v1.0'].join('\0') +
      '\x1e\n' +
      ['b'.repeat(40), 'bbbbbbb', 'fix: algo, con coma', 'Otra Persona', '2026-11-10T17:20:00-05:00', ''].join('\0') +
      '\x1e\n';
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      subject: 'feat: push',
      author: 'Angel',
      date: '2026-11-11T08:51:00-05:00',
      refs: ['HEAD -> dev-x', 'origin/dev-x', 'tag: v1.0'],
    });
    expect(commits[1]!.subject).toBe('fix: algo, con coma');
    expect(commits[1]!.refs).toEqual([]);
  });

  it('salida vacía', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('añadidos, modificados, borrados y renombrados', () => {
    const out = ['A', 'src/nuevo.ts', 'M', 'src/con espacio.ts', 'D', 'viejo.ts', 'R087', 'a/antes.ts', 'b/despues.ts', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'A', path: 'src/nuevo.ts' },
      { status: 'M', path: 'src/con espacio.ts' },
      { status: 'D', path: 'viejo.ts' },
      { status: 'R', path: 'b/despues.ts', oldPath: 'a/antes.ts' },
    ]);
  });
});
