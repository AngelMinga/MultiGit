// Acciones de la vista Changes: Commit (solo archivos marcados), Rollback, Shelve / Unshelve y diff.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeCounts, planCommit, planRollback, SHELF_PREFIX, STATUS_LABEL, type StatusFile } from '../git/changes';
import { GitContentProvider } from '../git/GitContentProvider';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { StepResult } from '../git/preflight';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { ChangesTree, FileRef } from './ChangesTree';
import { openMergeEditor } from './conflicts';

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
  ) {}

  // ------------------------------------------------------------------ commit

  /**
   * Commit de los archivos marcados: en cada repo con archivos marcados, con el mismo mensaje.
   * Devuelve los repos donde se hizo el commit (o `undefined` si no se ejecutó).
   */
  async commit(message: string, amend: boolean): Promise<Repo[] | undefined> {
    const groups = byRepo(this.tree.checkedFiles, this.manager.all);
    if (groups.length === 0) {
      void vscode.window.showWarningMessage('MultiGit: marca al menos un archivo en la vista Changes.');
      return undefined;
    }
    if (!message.trim()) {
      void vscode.window.showWarningMessage('MultiGit: escribe el mensaje del commit.');
      return undefined;
    }
    const filesOf = new Map(groups.map((g) => [g.repo, g.files]));
    const total = groups.reduce((n, g) => n + g.files.length, 0);

    const results = await runInRepos(this.manager, {
      title: `${amend ? 'Amend commit' : 'Commit'} de ${total} archivo(s)`,
      repos: groups.map((g) => g.repo),
      check: () => undefined,
      run: async (repo) => {
        const files = filesOf.get(repo)!;
        const plan = planCommit(files);
        await repo.git.addPaths(plan.add);
        await repo.git.commitPaths(message, plan.paths, amend);
        return `${files.length} archivo(s)`;
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
   * Rollback…: elige archivos (preseleccionados los marcados), confirma listando qué se pierde
   * y revierte. Con `direct`, salta el selector (p. ej. desde el menú de un archivo).
   */
  async rollback(initial?: readonly FileRef[], direct = false): Promise<void> {
    const candidates = this.tree.trackedFiles;
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('MultiGit: no hay cambios versionados para revertir.');
      return;
    }
    const preselected = new Set(
      (initial ?? this.tree.checkedFiles).filter((r) => r.file.kind === 'tracked').map((r) => `${r.repo.root}\0${r.file.path}`),
    );

    let selected: FileRef[];
    if (direct && initial?.length) {
      selected = initial.filter((r) => r.file.kind === 'tracked');
    } else {
      const picked = await pickFiles(candidates, preselected, this.manager.all);
      if (!picked) return;
      selected = picked;
    }
    if (selected.length === 0) return;

    const groups = byRepo(selected, this.manager.all);
    const plans = new Map(groups.map((g) => [g.repo, planRollback(g.files)]));
    const added = groups.flatMap((g) => plans.get(g.repo)!.added.map((p) => `${g.repo.name}/${p}`));

    const detail = [
      ...groups.flatMap((g) => [
        `${g.repo.name}:`,
        ...g.files.map((f) => `   ${f.status}  ${f.path}${f.origPath ? ` (← ${f.origPath})` : ''}`),
      ]),
      '',
      'Se perderán los cambios locales de estos archivos (vuelven a como están en HEAD).',
      ...(added.length
        ? [`Los ${added.length} archivo(s) añadido(s) quedarán sin versionar, salvo que elijas borrarlos también del disco.`]
        : []),
    ].join('\n');
    const ROLLBACK = 'Rollback';
    const DELETE = 'Rollback y borrar del disco los añadidos';
    const choice = await vscode.window.showWarningMessage(
      `¿Rollback de ${selected.length} archivo(s)? (${describeCounts(selected.map((s) => s.file))})`,
      { modal: true, detail },
      ...(added.length ? [ROLLBACK, DELETE] : [ROLLBACK]),
    );
    if (!choice) return;
    const deleteAdded = choice === DELETE;

    await runInRepos(this.manager, {
      title: `Rollback de ${selected.length} archivo(s)`,
      repos: groups.map((g) => g.repo),
      run: async (repo) => {
        const plan = plans.get(repo)!;
        await repo.git.restorePaths(plan.restore);
        await repo.git.unstageAdded(plan.unstage);
        if (deleteAdded) {
          await Promise.all(plan.added.map((p) => fs.rm(path.join(repo.root, p), { force: true })));
        }
        return `${plan.restore.length + plan.unstage.length} archivo(s)`;
      },
    });
    await this.tree.refresh();
  }

  // ------------------------------------------------------------------ shelf

  /** Shelve: guarda los archivos marcados en un stash con nombre, por repo. */
  async shelve(refs?: readonly FileRef[]): Promise<void> {
    const groups = byRepo(refs?.length ? refs : this.tree.checkedFiles, this.manager.all);
    if (groups.length === 0) {
      void vscode.window.showWarningMessage('MultiGit: marca los archivos que quieres guardar (shelve).');
      return;
    }
    const name = (
      await vscode.window.showInputBox({
        title: 'Shelve: guardar cambios aparte',
        prompt: `Nombre del shelf (${groups.map((g) => `${g.repo.name}: ${g.files.length}`).join(', ')})`,
        validateInput: (v) => (v.trim() ? undefined : 'Escribe un nombre'),
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
        return `${files.length} archivo(s)`;
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
      void vscode.window.showInformationMessage('MultiGit: no hay shelves guardados.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...byName.entries()].map(([name, repos]) => ({
        label: `$(archive) ${name}`,
        description: repos.map((r) => r.name).join(', '),
        name,
        repos,
      })),
      { title: 'Unshelve: aplicar cambios guardados', placeHolder: 'Elige un shelf' },
    );
    if (!picked) return;

    await runInRepos(this.manager, {
      title: `Unshelve '${picked.name}'`,
      repos: picked.repos,
      run: async (repo) => {
        const entry = (await repo.git.listStashes()).find((s) => s.message === `${SHELF_PREFIX}${picked.name}`);
        if (!entry) throw new Error('el shelf ya no existe');
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
    vscode.window.setStatusBarMessage(`$(add) ${groups.reduce((n, g) => n + g.files.length, 0)} archivo(s) agregados a Git`, 4000);
  }

  /** Agrega las rutas a `.git/info/exclude` (solo local) o a `.gitignore` (del repo). */
  async ignore(refs: readonly FileRef[], target: 'exclude' | 'gitignore'): Promise<void> {
    const groups = byRepo(refs.filter((r) => r.file.kind === 'untracked'), this.manager.all);
    if (!groups.length) return;
    await this.perRepo(groups, async (repo, files) => {
      const file = target === 'exclude' ? await repo.git.resolveGitPath('info/exclude') : path.join(repo.root, '.gitignore');
      let current = '';
      try {
        current = await fs.readFile(file, 'utf8');
      } catch {
        await fs.mkdir(path.dirname(file), { recursive: true });
      }
      const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
      const lines = files.map((f) => `/${f.path}`).filter((l) => !existing.has(l));
      if (!lines.length) return;
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      await fs.writeFile(file, `${current}${sep}${lines.join('\n')}\n`, 'utf8');
    });
    vscode.window.setStatusBarMessage(target === 'exclude' ? '$(eye-closed) Agregado a .git/info/exclude' : '$(eye-closed) Agregado a .gitignore', 4000);
  }

  /** Delete…: manda los archivos a la papelera, con confirmación. */
  async deleteFiles(refs: readonly FileRef[]): Promise<void> {
    const existing = refs.filter((r) => r.file.status !== 'D');
    if (!existing.length) return;
    const detail = byRepo(existing, this.manager.all)
      .flatMap((g) => [`${g.repo.name}:`, ...g.files.map((f) => `   ${f.path}`)])
      .join('\n');
    const ok = await vscode.window.showWarningMessage(
      `¿Eliminar ${existing.length} archivo(s)?`,
      { modal: true, detail: `${detail}\n\nSe mueven a la papelera del sistema.` },
      'Eliminar',
    );
    if (ok !== 'Eliminar') return;
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
      if (patch.trim()) parts.push(groups.length > 1 ? `# Repositorio: ${repo.name}\n${patch}` : patch);
    }
    if (!parts.length) {
      void vscode.window.showInformationMessage('MultiGit: no hay diferencias para copiar.');
      return;
    }
    await vscode.env.clipboard.writeText(parts.join('\n'));
    vscode.window.setStatusBarMessage(`$(copy) Patch de ${refs.length} archivo(s) copiado`, 4000);
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
    const title = `${path.posix.basename(file.path)} (${STATUS_LABEL[file.status]} · HEAD ↔ local)`;
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

/** QuickPick múltiple con los archivos agrupados por repo y el contador en el título. */
function pickFiles(candidates: FileRef[], preselected: Set<string>, repos: readonly Repo[]): Promise<FileRef[] | undefined> {
  type Item = vscode.QuickPickItem & { ref?: FileRef };
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.placeholder = 'Marca los archivos a revertir y pulsa Enter';
    const items: Item[] = [];
    for (const repo of repos) {
      const refs = candidates.filter((c) => c.repo === repo);
      if (!refs.length) continue;
      items.push({ label: repo.name, kind: vscode.QuickPickItemKind.Separator });
      for (const ref of refs) {
        items.push({
          label: `${ref.file.status}  ${path.posix.basename(ref.file.path)}`,
          description: path.posix.dirname(ref.file.path) === '.' ? '' : path.posix.dirname(ref.file.path),
          ref,
        });
      }
    }
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.ref && preselected.has(`${i.ref.repo.root}\0${i.ref.file.path}`));
    const updateTitle = () => {
      const files = qp.selectedItems.flatMap((i) => (i.ref ? [i.ref.file] : []));
      qp.title = `Rollback — ${files.length} archivo(s): ${describeCounts(files)}`;
    };
    updateTitle();
    let done = false;
    qp.onDidChangeSelection(updateTitle);
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems.flatMap((i) => (i.ref ? [i.ref] : [])));
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
