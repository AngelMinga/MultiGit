import { describe, expect, it } from 'vitest';
import {
  ALL_REFS,
  EMPTY_FILTERS,
  logFilterArgs,
  looksLikeHash,
  MergedLogPager,
  parseDecorations,
  parseLogPage,
  resolveBranchRefs,
  type LogCommit,
  type LogSource,
} from '../src/git/log';

function commit(hash: string, minute: number): LogCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    author: 'A',
    email: 'a@x',
    authorTime: minute * 60_000,
    commitTime: minute * 60_000,
    decorations: '',
    subject: hash,
  };
}

/** Fuente falsa que cuenta cuántas veces se le pidió una página. */
function source(id: string, commits: LogCommit[]): LogSource & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  return {
    id,
    calls,
    fetch: async (skip, count) => {
      calls.push([skip, count]);
      return commits.slice(skip, skip + count);
    },
  };
}

describe('parseLogPage', () => {
  it('lee padres, fechas y decoraciones', () => {
    const out =
      ['a'.repeat(40), 'aaaaaaa', 'p1 p2', 'Angel', 'angel@x.com', '1700000000', '1700000100', 'HEAD -> dev', 'Merge x'].join('\0') +
      '\x1e\n';
    expect(parseLogPage(out)).toEqual([
      {
        hash: 'a'.repeat(40),
        shortHash: 'aaaaaaa',
        parents: ['p1', 'p2'],
        author: 'Angel',
        email: 'angel@x.com',
        authorTime: 1700000000000,
        commitTime: 1700000100000,
        decorations: 'HEAD -> dev',
        subject: 'Merge x',
      },
    ]);
  });
});

describe('parseDecorations', () => {
  it('rama actual, locales, remotas y tags; omite origin/HEAD', () => {
    expect(parseDecorations('HEAD -> dev-x, origin/dev-x, origin/HEAD, tag: v1.0, develop', ['origin'])).toEqual([
      { name: 'dev-x', kind: 'head' },
      { name: 'origin/dev-x', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
      { name: 'develop', kind: 'local' },
    ]);
    expect(parseDecorations('HEAD, tag: v2', ['origin'])).toEqual([{ name: 'v2', kind: 'tag' }]);
  });
});

describe('MergedLogPager', () => {
  it('mezcla por fecha y pide páginas con --skip solo cuando hace falta', async () => {
    // Repo A: minutos 100, 90, 80, 70, 60 — Repo B: 95, 85, 10
    const a = source('A', [100, 90, 80, 70, 60].map((m) => commit(`a${m}`, m)));
    const b = source('B', [95, 85, 10].map((m) => commit(`b${m}`, m)));
    const pager = new MergedLogPager([a, b], 2);

    const first = await pager.next(4);
    expect(first.map((c) => c.hash)).toEqual(['a100', 'b95', 'a90', 'b85']);
    expect(first.map((c) => c.repoId)).toEqual(['A', 'B', 'A', 'B']);
    expect(pager.hasMore).toBe(true);

    const rest = await pager.next(10);
    expect(rest.map((c) => c.hash)).toEqual(['a80', 'a70', 'a60', 'b10']);
    expect(pager.hasMore).toBe(false);
    expect(a.calls).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
    expect(b.calls).toEqual([
      [0, 2],
      [2, 2],
    ]);
  });

  it('sin fuentes o vacías', async () => {
    expect(await new MergedLogPager([]).next()).toEqual([]);
    const pager = new MergedLogPager([source('A', [])]);
    expect(await pager.next()).toEqual([]);
    expect(pager.hasMore).toBe(false);
  });
});

describe('filtros', () => {
  it('texto, usuario, mayúsculas y regex', () => {
    expect(logFilterArgs({ ...EMPTY_FILTERS, text: 'push', user: 'afminga' }, ALL_REFS)).toEqual([
      '--date-order',
      '--grep=push',
      '--author=afminga',
      '--regexp-ignore-case',
      '--fixed-strings',
      ...ALL_REFS,
    ]);
    expect(logFilterArgs({ ...EMPTY_FILTERS, text: 'feat\\(.*\\)', regex: true, matchCase: true }, ['HEAD'])).toEqual([
      '--date-order',
      '--grep=feat\\(.*\\)',
      '--extended-regexp',
      'HEAD',
    ]);
  });

  it('un hash no se busca en el mensaje; fechas inclusivas', () => {
    expect(looksLikeHash('a1b2c3d')).toBe(true);
    expect(looksLikeHash('push')).toBe(false);
    expect(logFilterArgs({ ...EMPTY_FILTERS, text: 'a1b2c3d', since: '2026-11-01', until: '2026-11-11' }, ['HEAD'])).toEqual([
      '--date-order',
      '--since=2026-11-01 00:00',
      '--until=2026-11-11 23:59:59',
      'HEAD',
    ]);
  });

  it('un hash inexistente se puede buscar como texto', () => {
    expect(logFilterArgs({ ...EMPTY_FILTERS, text: 'cafe' }, ['HEAD'], { hashAsText: true })).toEqual([
      '--date-order',
      '--grep=cafe',
      '--regexp-ignore-case',
      '--fixed-strings',
      'HEAD',
    ]);
  });

  it('resolución de la rama por repo', () => {
    const local = ['develop', 'dev-afminga-scheduled-transfers'];
    const remote = ['origin/develop', 'origin/solo-remota'];
    expect(resolveBranchRefs(null, local, remote)).toEqual(ALL_REFS);
    expect(resolveBranchRefs('HEAD', local, remote)).toEqual(['HEAD']);
    expect(resolveBranchRefs('dev-afminga-scheduled-transfers', local, remote)).toEqual(['dev-afminga-scheduled-transfers']);
    expect(resolveBranchRefs('solo-remota', local, remote)).toEqual(['origin/solo-remota']);
    expect(resolveBranchRefs('origin/develop', local, remote)).toEqual(['origin/develop']);
    expect(resolveBranchRefs('no-existe', local, remote)).toBeNull();
  });
});
