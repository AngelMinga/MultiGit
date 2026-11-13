// Acciones de la vista Changes: Commit (solo archivos marcados), Rollback, Shelve / Unshelve y diff.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { planCommit, planRollback, statusLabel, type StatusFile } from '../git/changes';
import { SHELF_PREFIX } from '../git/stashes';
import { buildPartial, diffFingerprint, parseHunks } from '../git/hunks';
import { GitContentProvider } from '../git/GitContentProvider';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { StepResult } from '../git/preflight';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { ChangesTree, FileRef, PartialSelection } from './ChangesTree';
import { commonAncestorDirs, gitignoreIn, ignorePattern } from '../git/ignoreTargets';
import { RollbackPanel, rollbackKey } from '../webview/RollbackPanel';
import { openMergeEditor } from './conflicts';
import { t } from '../i18n';

/** Agrupa archivos por repo, en el orden de los repos. */
function byRepo(refs: readonly FileRef[], repos: readonly Repo[]): Array<{ repo: Repo; files: StatusFile[] }> {
  return repos
    .map((repo) => ({ repo, files: refs.filter((r) => r.repo === repo).map((r) => r.file) }))
    .filter((g) => g.files.length > 0);
}

export class ChangesActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly tree: ChangesTree,
    private readonly extensionUri: vscode.Uri,
  ) {}

  // ------------------------------------------------------------------ commit

  /**
   * Commit de los archivos marcados: en cada repo con archivos marcados, con el mismo mensaje.
   * Devuelve los repos donde se hizo el commit (o `undefined` si no se ejecutó).
   */
  async commit(message: string, amend: boolean): Promise<Repo[] | undefined> {
    const groups = byRepo(this.tree.checkedFiles, this.manager.all);
    if (groups.length === 0) {
      void vscode.window.showWarningMessage(t('MultiGit: check at least one file in the Changes view.'));
      return undefined;
    }
    if (!message.trim()) {
      void vscode.window.showWarningMessage(t('MultiGit: type the commit message.'));
      return undefined;
    }
    const filesOf = new Map(groups.map((g) => [g.repo, g.files]));
    const total = groups.reduce((n, g) => n + g.files.length, 0);
    /** Archivos con solo parte de sus líneas elegidas, por repo. */
    const partialOf = (repo: Repo) =>
      filesOf.get(repo)!.flatMap((file) => {
        const selection = this.tree.partialOf({ repo, file });
        return selection ? [{ file, selection }] : [];
      });

    const results = await runInRepos(this.manager, {
      title: t('{0} of {1} file(s)', amend ? 'Amend commit' : 'Commit', total),
      repos: groups.map((g) => g.repo),
      // Si un archivo cambió después de elegir sus líneas, no se toca ningún repo.
      check: async (repo) => {
        for (const { file, selection } of partialOf(repo)) {
          if (!(await partialContent(repo, file.path, selection))) {
            return { block: t("'{0}' changed after its lines were selected; select them again", file.path) };
          }
        }
        return undefined;
      },
      run: async (repo) => {
        const files = filesOf.get(repo)!;
        const partial = partialOf(repo);
        if (partial.length === 0) {
          const plan = planCommit(files);
          await repo.git.addPaths(plan.add);
          await repo.git.commitPaths(message, plan.paths, amend);
          return t('{0} file(s)', files.length);
        }
        const partialPaths = new Set(partial.map((p) => p.file.path));
        const plan = planCommit(files.filter((f) => !partialPaths.has(f.path)));
        const contents = await Promise.all(
          partial.map(async ({ file, selection }) => {
            const content = await partialContent(repo, file.path, selection);
            if (content === undefined) throw new Error(t("'{0}' changed after its lines were selected; select them again", file.path));
            return { path: file.path, content };
          }),
        );
        await repo.git.commitPartial(message, plan.paths, contents, amend);
        this.tree.clearPartial(partial.map((p) => ({ repo, file: p.file })));
        return t('{0} file(s), {1} partial', files.length, partial.length);
      },
    });
    await this.tree.refresh();
    return okRepos(results, groups.map((g) => g.repo));
  }

  /** Mensaje del último commit del primer repo con archivos marcados (para Amend). */
  async lastMessage(): Promise<string> {
    const repo = byRepo(this.tree.checkedFiles, this.manager.all)[0]?.repo ?? this.manager.all[0];
    try {
      return repo ? await repo.git.lastCommitMessage() : '';
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ rollback

  /**
   * Rollback…: abre el diálogo "Rollback Changes" (árbol con casillas, como IntelliJ) con todos los
   * archivos versionados con cambios; vienen marcados los elegidos (o los marcados en Changes).
   */
  async rollback(initial?: readonly FileRef[]): Promise<void> {
    const candidates = this.tree.trackedFiles;
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no versioned changes to roll back.'));
      return;
    }
    const keys = new Set((initial ?? this.tree.checkedFiles).filter((r) => r.file.kind === 'tracked').map(rollbackKey));
    RollbackPanel.open(
      this.extensionUri,
      this.manager.all,
      candidates,
      candidates.filter((c) => keys.has(rollbackKey(c))),
      { run: (refs, deleteAdded) => this.runRollback(refs, deleteAdded), openDiff: (ref) => this.openDiff(ref) },
    );
  }

  /** Revierte los archivos a HEAD; los añadidos quedan sin versionar o, con `deleteAdded`, se borran. */
  private async runRollback(selected: readonly FileRef[], deleteAdded: boolean): Promise<boolean> {
    const groups = byRepo(selected, this.manager.all);
    if (!groups.length) return false;
    const plans = new Map(groups.map((g) => [g.repo, planRollback(g.files)]));
    const results = await runInRepos(this.manager, {
      title: t('Rollback of {0} file(s)', selected.length),
      repos: groups.map((g) => g.repo),
      run: async (repo) => {
        const plan = plans.get(repo)!;
        await repo.git.restorePaths(plan.restore);
        await repo.git.unstageAdded(plan.unstage);
        if (deleteAdded) {
          await Promise.all(plan.added.map((p) => fs.rm(path.join(repo.root, p), { force: true })));
        }
        return t('{0} file(s)', plan.restore.length + plan.unstage.length);
      },
    });
    await this.tree.refresh();
    return results !== undefined;
  }

  // ------------------------------------------------------------------ shelf

  /** Shelve: guarda los archivos marcados en un stash con nombre, por repo. */
  async shelve(refs?: readonly FileRef[]): Promise<void> {
    const groups = byRepo(refs?.length ? refs : this.tree.checkedFiles, this.manager.all);
    if (groups.length === 0) {
      void vscode.window.showWarningMessage(t('MultiGit: check the files you want to shelve.'));
      return;
    }
    const name = (
      await vscode.window.showInputBox({
        title: t('Shelve: put changes aside'),
        prompt: t('Shelf name ({0})', groups.map((g) => `${g.repo.name}: ${g.files.length}`).join(', ')),
        validateInput: (v) => (v.trim() ? undefined : t('Type a name')),
      })
    )?.trim();
    if (!name) return;

    const filesOf = new Map(groups.map((g) => [g.repo, g.files]));
    await runInRepos(this.manager, {
      title: `Shelve '${name}'`,
      repos: groups.map((g) => g.repo),
      check: () => undefined,
      run: async (repo) => {
        const files = filesOf.get(repo)!;
        await repo.git.stashPush(name, planCommit(files).paths);
        return t('{0} file(s)', files.length);
      },
    });
    await this.tree.refresh();
  }

  /** Unshelve: elige un shelf de MultiGit y lo aplica (stash pop) en cada repo que lo tenga. */
  async unshelve(): Promise<void> {
    const lists = await Promise.all(
      this.manager.all.map(async (repo) => ({ repo, stashes: await repo.git.listStashes().catch(() => []) })),
    );
    const byName = new Map<string, Repo[]>();
    for (const { repo, stashes } of lists) {
      for (const s of stashes) {
        if (!s.message.startsWith(SHELF_PREFIX)) continue;
        const name = s.message.slice(SHELF_PREFIX.length);
        const repos = byName.get(name) ?? [];
        if (!repos.includes(repo)) repos.push(repo);
        byName.set(name, repos);
      }
    }
    if (byName.size === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no saved shelves.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...byName.entries()].map(([name, repos]) => ({
        label: `$(archive) ${name}`,
        description: repos.map((r) => r.name).join(', '),
        name,
        repos,
      })),
      { title: t('Unshelve: apply saved changes'), placeHolder: t('Choose a shelf') },
    );
    if (!picked) return;

    await runInRepos(this.manager, {
      title: `Unshelve '${picked.name}'`,
      repos: picked.repos,
      run: async (repo) => {
        const entry = (await repo.git.listStashes()).find((s) => s.message === `${SHELF_PREFIX}${picked.name}`);
        if (!entry) throw new Error(t('the shelf no longer exists'));
        await repo.git.stashPop(entry.ref);
      },
    });
    await this.tree.refresh();
  }

  // ------------------------------------------------------------------ menú contextual (como IntelliJ)

  /** Commit File/Directory…: deja marcados solo estos archivos y enfoca la caja de commit. */
  async commitOnly(refs: readonly FileRef[]): Promise<void> {
    if (!refs.length) return;
    this.tree.setOnlyChecked(refs);
    await vscode.commands.executeCommand('multigit.commitFocus');
  }

  /** Add to VCS: `git add` de los archivos sin versionar. */
  async addToVcs(refs: readonly FileRef[]): Promise<void> {
    const groups = byRepo(refs.filter((r) => r.file.kind === 'untracked'), this.manager.all);
    if (!groups.length) return;
    await this.perRepo(groups, (repo, files) => repo.git.addPaths(files.map((f) => f.path)));
    vscode.window.setStatusBarMessage(t('$(add) {0} file(s) added to Git', groups.reduce((n, g) => n + g.files.length, 0)), 4000);
  }

  /**
   * Submenú Add to .gitignore: `.git/info/exclude` (solo local), el `.gitignore` más cercano que ya
   * exista (o el de la raíz), el de la raíz, o `gitignore` para elegir entre todos (lista).
   */
  async ignore(refs: readonly FileRef[], target: 'exclude' | 'nearest' | 'root' | 'gitignore'): Promise<void> {
    const groups = byRepo(refs.filter((r) => r.file.kind === 'untracked'), this.manager.all);
    if (!groups.length) return;
    if (target === 'gitignore') return this.addToGitignore(groups);
    if (target === 'nearest' || target === 'root') {
      const written = new Set<string>();
      await this.perRepo(groups, async (repo, files) => {
        const dir = target === 'root' ? '' : ((await this.existingGitignoreDirs(repo, files))[0] ?? '');
        written.add(gitignoreIn(dir));
        await appendIgnore(path.join(repo.root, gitignoreIn(dir)), files.map((f) => ignorePattern(dir, f.path)));
      });
      vscode.window.setStatusBarMessage(`$(eye-closed) Agregado a ${[...written].join(', ')}`, 4000);
      return;
    }
    await this.perRepo(groups, async (repo, files) => {
      await appendIgnore(await repo.git.resolveGitPath('info/exclude'), files.map((f) => `/${f.path}`));
    });
    vscode.window.setStatusBarMessage('$(eye-closed) Agregado a .git/info/exclude', 4000);
  }

  /**
   * Add to .gitignore: como el submenú de IntelliJ, ofrece los `.gitignore` que ya existen en las
   * carpetas que contienen a los archivos (el más cercano primero; si no hay, el de la raíz, que se
   * crea) y `.git/info/exclude`. Con varios repos: el más cercano de cada repo.
   */
  private async addToGitignore(groups: Array<{ repo: Repo; files: StatusFile[] }>): Promise<void> {
    const plans = await Promise.all(
      groups.map(async ({ repo, files }) => {
        const existing = await this.existingGitignoreDirs(repo, files);
        return { repo, files, dirs: existing.length ? existing : [''], created: !existing.length };
      }),
    );

    type Target = { kind: 'dir'; dir?: string } | { kind: 'exclude' };
    const items: Array<vscode.QuickPickItem & { target: Target }> = [];
    if (plans.length === 1) {
      const plan = plans[0]!;
      for (const dir of plan.dirs) {
        items.push({
          label: `$(file) ${gitignoreIn(dir)}`,
          description: plan.created ? t('will be created') : plan.repo.name,
          target: { kind: 'dir', dir },
        });
      }
    } else {
      items.push({
        label: '$(file) .gitignore',
        description: t('the nearest one in each repository (or the root one)'),
        target: { kind: 'dir' },
      });
    }
    items.push({ label: '$(file) .git/info/exclude', description: t('only on this machine, not committed'), target: { kind: 'exclude' } });

    const total = groups.reduce((n, g) => n + g.files.length, 0);
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Add to .gitignore',
      placeHolder: total === 1 ? t('Ignore {0} in…', groups[0]!.files[0]!.path) : t('Ignore {0} files in…', total),
    });
    if (!picked) return;

    const target = picked.target;
    await this.perRepo(groups, async (repo, files) => {
      if (target.kind === 'exclude') {
        return appendIgnore(await repo.git.resolveGitPath('info/exclude'), files.map((f) => `/${f.path}`));
      }
      const dir = target.dir ?? plans.find((p) => p.repo === repo)!.dirs[0]!;
      await appendIgnore(path.join(repo.root, gitignoreIn(dir)), files.map((f) => ignorePattern(dir, f.path)));
    });
    const where = target.kind === 'exclude' ? '.git/info/exclude' : target.dir !== undefined ? gitignoreIn(target.dir) : '.gitignore';
    vscode.window.setStatusBarMessage(`$(eye-closed) Agregado a ${where}`, 4000);
  }

  /** Carpetas con un `.gitignore` existente que contienen a todos los archivos, la más cercana primero. */
  private async existingGitignoreDirs(repo: Repo, files: readonly StatusFile[]): Promise<string[]> {
    const result: string[] = [];
    for (const dir of commonAncestorDirs(files.map((f) => f.path))) {
      if (await exists(path.join(repo.root, gitignoreIn(dir)))) result.push(dir);
    }
    return result;
  }

  /** Delete…: manda los archivos a la papelera, con confirmación. */
  async deleteFiles(refs: readonly FileRef[]): Promise<void> {
    const existing = refs.filter((r) => r.file.status !== 'D');
    if (!existing.length) return;
    const detail = byRepo(existing, this.manager.all)
      .flatMap((g) => [`${g.repo.name}:`, ...g.files.map((f) => `   ${f.path}`)])
      .join('\n');
    const ok = await vscode.window.showWarningMessage(
      t('Delete {0} file(s)?', existing.length),
      { modal: true, detail: t('{0}\n\nThey are moved to the system trash.', detail) },
      t('Delete'),
    );
    if (ok !== t('Delete')) return;
    for (const ref of existing) {
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(ref.repo.root, ref.file.path)), { useTrash: true, recursive: true });
    }
    await this.tree.refresh();
  }

  /** Copy as Patch to Clipboard: un patch por repo (aplicable con `git apply` en ese repo). */
  async copyPatch(refs: readonly FileRef[]): Promise<void> {
    const groups = byRepo(refs, this.manager.all);
    const parts: string[] = [];
    for (const { repo, files } of groups) {
      const tracked = files.filter((f) => f.kind !== 'untracked').flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]));
      let patch = await repo.git.patchTracked(tracked);
      for (const f of files.filter((x) => x.kind === 'untracked')) patch += await repo.git.patchUntracked(f.path);
      if (patch.trim()) parts.push(groups.length > 1 ? t('# Repository: {0}\n{1}', repo.name, patch) : patch);
    }
    if (!parts.length) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no differences to copy.'));
      return;
    }
    await vscode.env.clipboard.writeText(parts.join('\n'));
    vscode.window.setStatusBarMessage(t('$(copy) Patch of {0} file(s) copied', refs.length), 4000);
  }

  /** Ejecuta `fn` en cada repo y muestra los errores; luego refresca la vista. */
  private async perRepo(
    groups: Array<{ repo: Repo; files: StatusFile[] }>,
    fn: (repo: Repo, files: StatusFile[]) => Promise<unknown>,
  ): Promise<void> {
    const errors: string[] = [];
    for (const { repo, files } of groups) {
      try {
        await fn(repo, files);
      } catch (error) {
        errors.push(`${repo.name}: ${errorText(error)}`);
      }
    }
    await this.tree.refresh();
    if (errors.length) void vscode.window.showErrorMessage(`MultiGit: ${errors.join(' · ')}`);
  }

  // ------------------------------------------------------------------ diff / abrir

  /** Diff contra HEAD (añadidos: contra vacío; borrados: contra vacío a la derecha). Conflictos: merge editor. */
  async openDiff(ref: FileRef): Promise<void> {
    const { repo, file } = ref;
    const abs = vscode.Uri.file(path.join(repo.root, file.path));
    if (file.kind === 'conflict') {
      await openMergeEditor(abs);
      return;
    }
    const isNew = file.kind === 'untracked' || file.status === 'A' || file.status === 'C';
    const left = GitContentProvider.uri(repo.root, isNew ? '' : 'HEAD', file.origPath ?? file.path);
    const right = file.status === 'D' ? GitContentProvider.uri(repo.root, '', file.path) : abs;
    const title = `${path.posix.basename(file.path)} (${statusLabel(file.status)} · HEAD ↔ local)`;
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    }
  }

  async openFile(ref: FileRef): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(ref.repo.root, ref.file.path)));
  }
}

function okRepos(results: StepResult[] | undefined, repos: readonly Repo[]): Repo[] | undefined {
  if (!results) return undefined;
  const ok = new Set(results.filter((r) => r.state === 'ok').map((r) => r.repo));
  return repos.filter((r) => ok.has(r.name));
}


async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Agrega las líneas que falten al final de un archivo de ignores (lo crea si no existe). */
async function appendIgnore(file: string, patterns: readonly string[]): Promise<void> {
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const lines = [...new Set(patterns)].filter((l) => !existing.has(l));
  if (!lines.length) return;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  await fs.writeFile(file, `${current}${sep}${lines.join('\n')}\n`, 'utf8');
}

/**
 * Contenido de un archivo con solo las líneas elegidas, o `undefined` si el archivo cambió desde que
 * se eligieron (el diff ya no es el mismo).
 */
export async function partialContent(repo: Repo, filePath: string, selection: PartialSelection): Promise<string | undefined> {
  const diff = await repo.git.diffForPartial(filePath);
  if (diffFingerprint(diff) !== selection.fingerprint) return undefined;
  const hunks = parseHunks(diff);
  if (!hunks) return undefined;
  return buildPartial(await repo.git.showFile('HEAD', filePath), hunks, new Set(selection.selected));
}
