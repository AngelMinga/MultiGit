import { describe, expect, it } from 'vitest';
import { alignmentKey, computeAlignment } from '../src/git/alignment';
import type { RepoStatus } from '../src/git/parsers';

const st = (branch: string | null): RepoStatus => ({
  branch,
  oid: 'abcdef1234567',
  upstream: null,
  ahead: null,
  behind: null,
  changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
});

describe('computeAlignment', () => {
  it('mayoría clara: rama objetivo y repos fuera de ella', () => {
    const a = computeAlignment([
      { name: 'mftheme', status: st('dev-x') },
      { name: 'shell', status: st('dev-x') },
      { name: 'mflogin', status: st('develop') },
      { name: 'mfcomponents', status: st(null) },
    ]);
    expect(a).toEqual({
      target: 'dev-x',
      aligned: ['mftheme', 'shell'],
      outliers: [
        { repo: 'mfcomponents', branch: '(detached abcdef1)' },
        { repo: 'mflogin', branch: 'develop' },
      ],
    });
    expect(alignmentKey(a)).toBe('dev-x|mfcomponents:(detached abcdef1),mflogin:develop');
  });

  it('sin aviso: todos iguales, empate o mayoría de 1', () => {
    expect(computeAlignment([{ name: 'a', status: st('x') }, { name: 'b', status: st('x') }])).toBeNull();
    expect(
      computeAlignment([
        { name: 'a', status: st('x') },
        { name: 'b', status: st('x') },
        { name: 'c', status: st('y') },
        { name: 'd', status: st('y') },
      ]),
    ).toBeNull();
    expect(computeAlignment([{ name: 'a', status: st('x') }, { name: 'b', status: st('y') }])).toBeNull();
    expect(alignmentKey(null)).toBe('');
  });
});
