import { describe, expect, it } from 'vitest';
import type { RepoStatus } from '../src/git/parsers';
import { basicBlocker, countByState, firstLine, formatSummary } from '../src/git/preflight';

function status(changes: Partial<RepoStatus['changes']> = {}): RepoStatus {
  return {
    branch: 'develop',
    oid: 'abc',
    upstream: 'origin/develop',
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0, ...changes },
  };
}

describe('basicBlocker', () => {
  it('repo limpio no bloquea', () => {
    expect(basicBlocker({ status: status(), operation: null }, true)).toBeUndefined();
  });

  it('cambios sin commit bloquean solo con requireClean', () => {
    const dirty = status({ unstaged: 2, total: 2 });
    expect(basicBlocker({ status: dirty, operation: null }, false)).toBeUndefined();
    expect(basicBlocker({ status: dirty, operation: null }, true)).toMatch(/2 cambio/);
  });

  it('operación en curso, conflictos y errores siempre bloquean', () => {
    expect(basicBlocker({ status: status(), operation: 'rebase' }, false)).toMatch(/rebase en curso/);
    expect(basicBlocker({ status: status({ conflicted: 1, total: 1 }), operation: null }, false)).toMatch(/conflicto/);
    expect(basicBlocker({ operation: null, error: 'not a git repository' }, false)).toMatch(/not a git repository/);
  });
});

describe('formatSummary', () => {
  it('✅ ok / ❌ falló + motivo / ⏭ omitido y no ejecutado', () => {
    const results = [
      { repo: 'mfbankingservice', state: 'ok' as const },
      { repo: 'mfcomponents', state: 'skipped' as const, message: 'nada por subir' },
      { repo: 'mftheme', state: 'failed' as const, message: 'error: Your local changes would be overwritten\nAborting' },
      { repo: 'shell', state: 'pending' as const },
    ];
    expect(formatSummary(results)).toBe(
      [
        '✅ mfbankingservice',
        '⏭ mfcomponents: nada por subir',
        '❌ mftheme: Your local changes would be overwritten',
        '⏭ shell: no ejecutado',
      ].join('\n'),
    );
    expect(countByState(results)).toEqual({ ok: 1, failed: 1, skipped: 1, pending: 1 });
  });

  it('firstLine salta líneas vacías y prefijos de git', () => {
    expect(firstLine('\n  fatal: no upstream\nmore')).toBe('no upstream');
  });
});
