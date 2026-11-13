// Rebase interactivo: validación, todo y ejecución con git real (reordenar, squash, fixup, reword, drop).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/GitService';
import { buildTodo, isNoop, validatePlan, type RebaseEntry } from '../src/git/rebase';

describe('plan', () => {
  it('validatePlan', () => {
    expect(validatePlan([{ hash: 'a', action: 'squash' }, { hash: 'b', action: 'pick' }])).toBe('first-squash');
    expect(validatePlan([{ hash: 'a', action: 'drop' }, { hash: 'b', action: 'fixup' }])).toBe('first-squash');
    expect(validatePlan([{ hash: 'a', action: 'drop' }])).toBe('all-dropped');
    expect(validatePlan([{ hash: 'a', action: 'reword', message: '  ' }])).toBe('empty-message');
    expect(validatePlan([{ hash: 'a', action: 'pick' }, { hash: 'b', action: 'squash' }])).toBeUndefined();
  });

  it('buildTodo: reword con exec y rutas con barras normales', () => {
    const todo = buildTodo(
      [
        { hash: 'a1', action: 'pick' },
        { hash: 'b2', action: 'reword', message: 'nuevo' },
        { hash: 'c3', action: 'fixup' },
      ],
      (h) => `C:\\repo\\.git\\msg-${h}.txt`,
    );
    expect(todo).toBe('pick a1\npick b2\nexec git commit --amend --allow-empty --no-verify --quiet -F "C:/repo/.git/msg-b2.txt"\nfixup c3\n');
  });

  it('isNoop', () => {
    expect(isNoop([{ hash: 'a', action: 'pick' }], ['a'])).toBe(true);
    expect(isNoop([{ hash: 'b', action: 'pick' }, { hash: 'a', action: 'pick' }], ['a', 'b'])).toBe(false);
  });
});

describe('interactiveRebase (git real)', () => {
  let root: string;
  let git: GitService;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    root = mkdtempSync(path.join(tmpdir(), 'multigit-rebase-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    for (const n of ['base', 'uno', 'dos', 'tres', 'cuatro', 'cinco']) {
      writeFileSync(path.join(root, `${n}.txt`), n);
      run('add', '.');
      run('commit', '-q', '-m', `feat: ${n}`);
    }
    git = new GitService(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lee los commits desde uno dado (incluido), del más viejo al más nuevo', async () => {
    const uno = run('rev-parse', 'HEAD~4').trim();
    const { base, commits, merges } = await git.rebaseCommits(uno);
    expect(base).toBe(run('rev-parse', 'HEAD~5').trim());
    expect(commits.map((c) => c.subject)).toEqual(['feat: uno', 'feat: dos', 'feat: tres', 'feat: cuatro', 'feat: cinco']);
    expect(merges).toBe(0);
    expect((await git.rebaseCommits(run('rev-list', '--max-parents=0', 'HEAD').trim())).base).toBeNull();
  });

  it('reordena, reword, squash, fixup y drop', async () => {
    const uno = run('rev-parse', 'HEAD~4').trim();
    const { base, commits } = await git.rebaseCommits(uno);
    const [c1, c2, c3, c4, c5] = commits.map((c) => c.hash) as [string, string, string, string, string];
    const plan: RebaseEntry[] = [
      { hash: c2, action: 'reword', message: 'feat: dos (renombrado)\n\ncon cuerpo' },
      { hash: c1, action: 'pick' },
      { hash: c3, action: 'squash' },
      { hash: c4, action: 'fixup' },
      { hash: c5, action: 'drop' },
    ];
    await git.interactiveRebase(base, plan);
    expect(run('log', '--format=%s', '-3').trim().split('\n')).toEqual(['feat: uno', 'feat: dos (renombrado)', 'feat: base']);
    expect(run('log', '-1', '--format=%B', 'HEAD~1').trim()).toBe('feat: dos (renombrado)\n\ncon cuerpo');
    // squash junta los mensajes de uno y tres; fixup descarta el de cuatro.
    const squashed = run('log', '-1', '--format=%B');
    expect(squashed).toContain('feat: uno');
    expect(squashed).toContain('feat: tres');
    expect(squashed).not.toContain('feat: cuatro');
    expect(run('ls-files').trim().split('\n').sort()).toEqual(['base.txt', 'cuatro.txt', 'dos.txt', 'tres.txt', 'uno.txt']);
    expect(run('status', '--porcelain')).toBe('');
  });
});
