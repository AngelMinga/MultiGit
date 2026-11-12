import { describe, expect, it } from 'vitest';
import { formatAheadBehind, summarizeBranches, sumCounters } from '../src/git/branchSummary';
import type { RepoStatus } from '../src/git/parsers';

function status(branch: string | null, extra: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch,
    oid: '1234567890abcdef',
    upstream: null,
    ahead: null,
    behind: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
    ...extra,
  };
}

describe('summarizeBranches', () => {
  it('todos en la misma rama', () => {
    const summary = summarizeBranches([
      { name: 'shell', status: status('dev-afminga-push-notifications') },
      { name: 'mftheme', status: status('dev-afminga-push-notifications') },
    ]);
    expect(summary).toEqual({ kind: 'single', branch: 'dev-afminga-push-notifications', repos: ['mftheme', 'shell'] });
  });

  it('ramas distintas, ordenadas por cantidad de repos', () => {
    const summary = summarizeBranches([
      { name: 'a', status: status('develop') },
      { name: 'b', status: status('feature') },
      { name: 'c', status: status('feature') },
      { name: 'd', status: status(null) },
    ]);
    expect(summary).toEqual({
      kind: 'mixed',
      byBranch: [
        { branch: 'feature', repos: ['b', 'c'] },
        { branch: '(detached 1234567)', repos: ['d'] },
        { branch: 'develop', repos: ['a'] },
      ],
    });
  });

  it('ignora repos sin estado y devuelve empty si no queda ninguno', () => {
    expect(summarizeBranches([{ name: 'x' }])).toEqual({ kind: 'empty' });
    expect(summarizeBranches([{ name: 'x' }, { name: 'y', status: status('main') }]).kind).toBe('single');
  });
});

describe('sumCounters', () => {
  it('suma ahead/behind y cuenta repos con cambios', () => {
    const dirty = { staged: 1, unstaged: 0, untracked: 0, conflicted: 0, total: 1 };
    expect(
      sumCounters([
        status('a', { ahead: 2, behind: 1 }),
        status('b', { ahead: null, behind: null, changes: dirty }),
        undefined,
        status('c', { ahead: 0, behind: 4, changes: dirty }),
      ]),
    ).toEqual({ ahead: 2, behind: 5, dirtyRepos: 2 });
  });
});

describe('formatAheadBehind', () => {
  it('omite los ceros y los null', () => {
    expect(formatAheadBehind({ ahead: 2, behind: 5 })).toBe('↑2 ↓5');
    expect(formatAheadBehind({ ahead: 0, behind: 3 })).toBe('↓3');
    expect(formatAheadBehind({ ahead: null, behind: null })).toBe('');
  });
});
