// Commit parcial, amend, rollback y shelf con git real (el criterio de la Fase 5).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planCommit, planRollback, type StatusFile } from '../src/git/changes';
import { GitService } from '../src/git/GitService';

let base: string;
let components: GitService;
let theme: GitService;

function makeRepo(name: string, files: Record<string, string>): GitService {
  const root = path.join(base, name);
  execFileSync('git', ['init', '-q', '-b', 'develop', root]);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), content);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return new GitService(root);
}

const write = (repo: GitService, f: string, content: string) => writeFileSync(path.join(repo.root, f), content);
const pick = (files: StatusFile[], ...paths: string[]) => files.filter((f) => paths.includes(f.path));

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // git (también Git for Windows) entiende /dev/null
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  base = mkdtempSync(path.join(tmpdir(), 'multigit-changes-'));
  components = makeRepo('mfcomponents', { 'src/a.js': 'a', 'src/b.js': 'b', 'src/c.js': 'c', 'src/d.js': 'd' });
  theme = makeRepo('mftheme', { 'theme.js': 't', 'colors.js': 'c' });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('commit / rollback (git real)', () => {
  it('commit de 3 archivos de mfcomponents y 1 de mftheme; el resto queda sin tocar', async () => {
    write(components, 'src/a.js', 'a2');
    write(components, 'src/b.js', 'b2');
    write(components, 'src/nuevo.js', 'n'); // sin versionar
    write(components, 'src/d.js', 'd2'); // no marcado
    write(theme, 'theme.js', 't2');
    write(theme, 'colors.js', 'c2'); // no marcado

    const compFiles = await components.getChanges();
    const themeFiles = await theme.getChanges();
    expect(compFiles.map((f) => f.status).sort()).toEqual(['?', 'M', 'M', 'M']);

    for (const [repo, files] of [
      [components, pick(compFiles, 'src/a.js', 'src/b.js', 'src/nuevo.js')],
      [theme, pick(themeFiles, 'theme.js')],
    ] as const) {
      const plan = planCommit(files);
      await repo.addPaths(plan.add);
      await repo.commitPaths('feat: solo los marcados', plan.paths, false);
    }

    expect((await components.getChanges()).map((f) => f.path)).toEqual(['src/d.js']);
    expect((await theme.getChanges()).map((f) => f.path)).toEqual(['colors.js']);
    expect(await components.lastCommitMessage()).toBe('feat: solo los marcados');
    const committed = await components.exec(['show', '--name-only', '--format=', 'HEAD']);
    expect(committed.trim().split('\n').sort()).toEqual(['src/a.js', 'src/b.js', 'src/nuevo.js']);
  });

  it('amend agrega un archivo al último commit y cambia el mensaje', async () => {
    const plan = planCommit(pick(await theme.getChanges(), 'colors.js'));
    await theme.commitPaths('feat: tema completo', plan.paths, true);
    expect(await theme.lastCommitMessage()).toBe('feat: tema completo');
    expect(await theme.countCommits('HEAD')).toBe(2);
    expect(await theme.getChanges()).toEqual([]);
  });

  it('rollback: restaura modificados y borrados; los añadidos quedan sin versionar o se borran', async () => {
    write(components, 'src/c.js', 'c-cambiado');
    rmSync(path.join(components.root, 'src/b.js'));
    write(components, 'src/agregado.js', 'x');
    write(components, 'src/agregado2.js', 'y');
    await components.addPaths(['src/agregado.js', 'src/agregado2.js']);

    const files = pick(await components.getChanges(), 'src/c.js', 'src/b.js', 'src/agregado.js', 'src/agregado2.js');
    const plan = planRollback(files);
    expect(plan.restore.sort()).toEqual(['src/b.js', 'src/c.js']);
    expect(plan.unstage.sort()).toEqual(['src/agregado.js', 'src/agregado2.js']);

    await components.restorePaths(plan.restore);
    await components.unstageAdded(plan.unstage);
    rmSync(path.join(components.root, 'src/agregado2.js')); // "borrar copias locales" solo para uno

    expect(readFileSync(path.join(components.root, 'src/c.js'), 'utf8')).toBe('c');
    expect(existsSync(path.join(components.root, 'src/b.js'))).toBe(true);
    const after = await components.getChanges();
    expect(after.map((f) => [f.status, f.path]).sort()).toEqual([
      ['?', 'src/agregado.js'],
      ['M', 'src/d.js'],
    ]);
  });

  it('shelve y unshelve por nombre', async () => {
    await components.stashPush('wip login', ['src/d.js', 'src/agregado.js']);
    expect(await components.getChanges()).toEqual([]);
    const [entry] = await components.listStashes();
    expect(entry).toEqual({ ref: 'stash@{0}', message: 'MultiGit: wip login' });
    await components.stashPop(entry!.ref);
    expect((await components.getChanges()).map((f) => f.path).sort()).toEqual(['src/agregado.js', 'src/d.js']);
  });

  it('patch de archivos nuevos y modificados aplicable con git apply; ruta de info/exclude', async () => {
    write(theme, 'nuevo.js', 'export const n = 1;\n');
    write(theme, 'theme.js', 't-patch');
    const patch = (await theme.patchTracked(['theme.js'])) + (await theme.patchUntracked('nuevo.js'));
    expect(patch).toContain('+++ b/nuevo.js');
    expect(patch).toContain('+t-patch');
    // Deshacer y volver a aplicar el patch deja el repo igual.
    await theme.restorePaths(['theme.js']);
    rmSync(path.join(theme.root, 'nuevo.js'));
    const patchFile = path.join(base, 'cambios.patch');
    writeFileSync(patchFile, patch);
    execFileSync('git', ['apply', patchFile], { cwd: theme.root });
    expect(readFileSync(path.join(theme.root, 'nuevo.js'), 'utf8')).toBe('export const n = 1;\n');
    expect(readFileSync(path.join(theme.root, 'theme.js'), 'utf8')).toBe('t-patch');

    expect(await theme.resolveGitPath('info/exclude')).toBe(path.join(theme.root, '.git', 'info', 'exclude'));
  });

  it('historial de un archivo siguiendo renombres, y tags', async () => {
    write(theme, 'historia.js', 'v1\n');
    await theme.addPaths(['historia.js']);
    await theme.commitPaths('feat: crear historia', ['historia.js'], false);
    write(theme, 'historia.js', 'v2\n');
    await theme.commitPaths('fix: cambiar historia', ['historia.js'], false);
    await theme.exec(['mv', 'historia.js', 'renombrado.js']);
    await theme.exec(['commit', '-q', '-m', 'refactor: renombrar']);
    await theme.createTag('v9.0', 'HEAD');

    const history = await theme.fileHistory('renombrado.js');
    expect(history.map((c) => c.subject)).toEqual(['refactor: renombrar', 'fix: cambiar historia', 'feat: crear historia']);
    expect(await theme.listTags()).toContain('v9.0');
  });

  it('ignorados: carpetas ignoradas como una sola entrada', async () => {
    mkdirSync(path.join(components.root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(components.root, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(path.join(components.root, '.gitignore'), 'node_modules/\n');
    const withIgnored = await components.getChanges(true);
    expect(withIgnored.filter((f) => f.kind === 'ignored').map((f) => f.path)).toEqual(['node_modules/']);
    expect((await components.getChanges()).some((f) => f.kind === 'ignored')).toBe(false);
  });
});
