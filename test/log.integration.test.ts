import { devNull } from 'node:os';
// Log combinado con git real: mezcla por fecha, filtros por usuario y rama, paginación y acciones.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { EMPTY_FILTERS, logFilterArgs, MergedLogPager, resolveBranchRefs, type LogFilters } from '../src/git/log';

let base: string;
const repos: GitService[] = [];

/** Commit con autor y fecha fijos (segundos desde una base). */
function commitAt(root: string, file: string, author: string, email: string, t: number, message: string): void {
  writeFileSync(path.join(root, file), `${message}\n`);
  const date = `${1_700_000_000 + t} +0000`;
  execFileSync('git', ['add', file], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // Identidad por defecto para los comandos que no la pasan (p. ej. git tag -a).
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  base = mkdtempSync(path.join(tmpdir(), 'multigit-log-'));
  const me = ['Angel', 'afminga@example.com'] as const;
  const other = ['Otra', 'otra@example.com'] as const;
  for (const [i, name] of ['mftheme', 'shell'].entries()) {
    const root = path.join(base, name);
    execFileSync('git', ['init', '-q', '-b', 'develop', root]);
    commitAt(root, 'a.txt', ...other, 10 + i, `${name}: init`);
    commitAt(root, 'b.txt', ...me, 30 + i, `${name}: feat en develop`);
    execFileSync('git', ['checkout', '-q', '-b', 'dev-afminga-scheduled-transfers'], { cwd: root });
    commitAt(root, 'c.txt', ...me, 50 + i, `${name}: feat programadas`);
    commitAt(root, 'd.txt', ...other, 70 + i, `${name}: fix de otra`);
    execFileSync('git', ['checkout', '-q', 'develop'], { cwd: root });
    repos.push(new GitService(root));
  }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function load(filters: LogFilters, pageSize = 300) {
  const sources = await Promise.all(
    repos.map(async (git) => {
      const b = await git.getBranches();
      const refs = resolveBranchRefs(filters.branch, b.local.map((l) => l.name), b.remote.map((r) => r.full));
      return refs ? [{ id: git.name, fetch: (skip: number, count: number) => git.logPage(logFilterArgs(filters, refs), filters.paths, skip, count) }] : [];
    }),
  );
  return new MergedLogPager(sources.flat(), pageSize);
}

describe('log combinado (git real)', () => {
  it('mezcla los repos por fecha', async () => {
    const rows = await (await load(EMPTY_FILTERS)).next();
    expect(rows.map((r) => r.subject)).toEqual([
      'shell: fix de otra',
      'mftheme: fix de otra',
      'shell: feat programadas',
      'mftheme: feat programadas',
      'shell: feat en develop',
      'mftheme: feat en develop',
      'shell: init',
      'mftheme: init',
    ]);
    expect(rows[0]!.decorations).toBe('dev-afminga-scheduled-transfers');
  });

  it('mi usuario + rama dev-afminga-scheduled-transfers', async () => {
    const rows = await (
      await load({ ...EMPTY_FILTERS, user: 'afminga@example.com', branch: 'dev-afminga-scheduled-transfers' })
    ).next();
    expect(rows.map((r) => r.subject)).toEqual([
      'shell: feat programadas',
      'mftheme: feat programadas',
      'shell: feat en develop',
      'mftheme: feat en develop',
    ]);
  });

  it('paginación de a 3 con --skip', async () => {
    const pager = await load(EMPTY_FILTERS, 3);
    const first = await pager.next(3);
    const second = await pager.next(3);
    const third = await pager.next(3);
    expect([...first, ...second, ...third].map((r) => r.subject)).toHaveLength(8);
    expect(pager.hasMore).toBe(false);
  });

  it('texto y rutas', async () => {
    const byText = await (await load({ ...EMPTY_FILTERS, text: 'PROGRAMADAS' })).next();
    expect(byText).toHaveLength(2);
    const byPath = await (await load({ ...EMPTY_FILTERS, paths: ['d.txt'] })).next();
    expect(byPath.map((r) => r.subject)).toEqual(['shell: fix de otra', 'mftheme: fix de otra']);
  });

  it('hash, detalle, tag y reset', async () => {
    const git = repos[0]!;
    const [head] = await git.logPage(['HEAD'], [], 0, 1);
    expect((await git.logCommit(head!.shortHash))?.hash).toBe(head!.hash);
    expect(await git.logCommit('deadbeef')).toBeNull();
    expect((await git.commitDetails(head!.hash)).body).toBe('mftheme: feat en develop');

    await git.createTag('v1.0', head!.hash, 'versión 1');
    expect(await git.resolveCommit('refs/tags/v1.0')).toBe(head!.hash);
    expect(await git.resolveCommit('dev-afminga-scheduled-transfers')).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.resolveCommit('no-existe')).toBeNull();
    const [tagged] = await git.logPage(['HEAD'], [], 0, 1);
    expect(tagged!.decorations).toContain('tag: v1.0');

    const [, parent] = await git.logPage(['HEAD'], [], 0, 2);
    await git.reset('hard', parent!.hash);
    expect((await git.logPage(['HEAD'], [], 0, 1))[0]!.hash).toBe(parent!.hash);
  });
});
