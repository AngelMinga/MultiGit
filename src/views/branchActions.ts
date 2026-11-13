// Acciones del popup de ramas. Todas las que modifican varios repos pasan por runInRepos
// (preflight → progreso → resumen) y las destructivas piden confirmación modal.
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { summarizeBranches } from '../git/branchSummary';
import { branchToFolderName, commonAncestor, type LocalBranch } from '../git/branches';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import { GitContentProvider } from '../git/GitContentProvider';
import type { CompareView } from './compareView';
import { showPullDialog } from './pullDialog';
import { t } from '../i18n';

/** Repos sobre los que actúa una acción: todos, o uno elegido en "Repositorios". */
export interface Scope {
  repos: readonly Repo[];
  /** "todos los repositorios" o el nombre del repo. */
  label: string;
}

export type BranchRef =
  | { type: 'local'; name: string }
  | { type: 'remote'; remote: string; name: string; full: string };

export function refName(ref: BranchRef): string {
  return ref.type === 'local' ? ref.name : ref.full;
}

/** Nombre de la rama actual para los textos: la común, o "rama actual" si difieren. */
export function currentLabel(scope: Scope): string {
  const s = summarizeBranches(scope.repos);
  return s.kind === 'single' ? s.branch : t('current branch');
}

export class BranchActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly compareView: CompareView,
    private readonly openPush: (scope: Scope, branch?: string) => Promise<void>,
  ) {}

  // ------------------------------------------------------------------ acciones generales

  /** Update Project: fetch + pull (merge) del upstream en cada repo. */
  async updateProject(scope: Scope): Promise<void> {
    await runInRepos(this.manager, {
      title: 'Update Project',
      repos: scope.repos,
      check: (_repo, status) => {
        if (!status.branch) return { skip: 'HEAD detached' };
        if (!status.upstream) return { skip: t('the branch has no upstream') };
        if (status.ahead === null) return { skip: t('upstream {0} no longer exists', status.upstream) };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.fetchAll();
        const after = await repo.git.getStatus();
        if (!after.behind) return t('already up to date');
        await repo.git.pull();
        return t('updated (↓{0})', after.behind);
      },
    });
  }

  /** Pull…: diálogo Repositorio → Remote → Rama → Modo (con el repo ya elegido si el alcance es uno). */
  async pull(scope: Scope): Promise<void> {
    await showPullDialog(this.manager, scope.repos.length === 1 ? scope.repos[0] : undefined);
  }

  /** Commit…: enfoca la caja de commit de MultiGit. */
  async commit(): Promise<void> {
    await vscode.commands.executeCommand('multigit.commitFocus');
  }

  /** New Branch… desde la rama actual (o desde `start`). */
  async newBranch(scope: Scope, start?: BranchRef): Promise<void> {
    const startRef = start ? refName(start) : 'HEAD';
    const name = await this.askBranchName(
      scope,
      start ? t('New branch from \'{0}\' — {1}', startRef, scope.label) : t('New branch from \'{0}\' — {1}', currentLabel(scope), scope.label),
    );
    if (!name) return;

    const mode = await vscode.window.showQuickPick(
      [
        { label: t('$(check) Create and check out'), checkout: true },
        { label: t('$(add) Create only'), checkout: false },
      ],
      { title: t('New branch \'{0}\'', name), placeHolder: t('Check out the new branch?') },
    );
    if (!mode) return;

    await runInRepos(this.manager, {
      title: start ? t('New branch \'{0}\' from \'{1}\'', name, startRef) : t('New branch \'{0}\'', name),
      repos: scope.repos,
      check: async (repo, status) => {
        const branches = await repo.git.getBranches();
        if (branches.local.some((b) => b.name === name)) return { block: t('branch \'{0}\' already exists', name) };
        if (start && !(await repo.git.revisionExists(startRef))) return { block: t('\'{0}\' does not exist', startRef) };
        if (!status.oid) return { block: t('the repository has no commits') };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.createBranch(name, startRef, mode.checkout);
      },
    });
  }

  /**
   * Alinear: checkout de `target` en los repos que están en otra rama (local si existe; si no,
   * se crea siguiendo a la remota). Los repos sin esa rama se omiten.
   */
  async alignTo(target: string, repos: readonly Repo[]): Promise<void> {
    const scope: Scope = { repos, label: t('{0} repositories', repos.length) };
    if (!(await this.confirmDirty(scope, t('Checkout of \'{0}\'', target)))) return;
    const remoteRef = new Map<Repo, string>();
    await runInRepos(this.manager, {
      title: t('Align with \'{0}\'', target),
      repos,
      check: async (repo, status) => {
        if (status.branch === target) return { skip: t('already on that branch') };
        const b = await repo.git.getBranches();
        if (b.local.some((l) => l.name === target)) return undefined;
        const remote = b.remote.find((r) => r.name === target && r.remote === 'origin') ?? b.remote.find((r) => r.name === target);
        if (!remote) return { skip: t('\'{0}\' does not exist (neither local nor remote)', target) };
        remoteRef.set(repo, remote.full);
        return undefined;
      },
      run: async (repo) => {
        const remote = remoteRef.get(repo);
        if (remote) {
          await repo.git.checkoutTracking(target, remote);
          return t('new local branch from {0}', remote);
        }
        await repo.git.checkout(target);
      },
    });
  }

  /** Checkout de un tag o revisión conocida (HEAD queda detached). */
  async checkoutRef(scope: Scope, ref: string): Promise<void> {
    if (!(await this.confirmDirty(scope, t('Checkout of \'{0}\'', ref)))) return;
    await runInRepos(this.manager, {
      title: t('Checkout of \'{0}\'', ref.replace(/^refs\/tags\//, '')),
      repos: scope.repos,
      check: async (repo) => ((await repo.git.revisionExists(ref)) ? undefined : { skip: t('\'{0}\' does not exist', ref) }),
      run: async (repo) => {
        await repo.git.checkoutDetached(ref);
      },
    });
  }

  /** Checkout Tag or Revision… (HEAD queda detached). */
  async checkoutRevision(scope: Scope): Promise<void> {
    const ref = (
      await vscode.window.showInputBox({
        title: t('Checkout tag or revision — {0}', scope.label),
        prompt: t('Tag, commit hash or any revision (e.g. v1.4.0, a1b2c3d, HEAD~2)'),
        validateInput: (v) => (!v.trim() ? t('Type a revision') : v.trim().startsWith('-') ? t('Invalid revision') : undefined),
      })
    )?.trim();
    if (!ref || !(await this.confirmDirty(scope, t('Checkout of \'{0}\'', ref)))) return;

    await runInRepos(this.manager, {
      title: t('Checkout of \'{0}\'', ref),
      repos: scope.repos,
      check: async (repo) => ((await repo.git.revisionExists(ref)) ? undefined : { block: t('revision \'{0}\' does not exist', ref) }),
      run: async (repo) => {
        await repo.git.checkoutDetached(ref);
      },
    });
  }

  /** Push…: abre el diálogo Push Commits para la rama actual (o `branch`) de cada repo. */
  async push(scope: Scope, branch?: string): Promise<void> {
    await this.openPush(scope, branch);
  }

  // ------------------------------------------------------------------ acciones sobre una rama

  async checkout(scope: Scope, ref: BranchRef): Promise<void> {
    if (!(await this.confirmDirty(scope, t('Checkout of \'{0}\'', refName(ref))))) return;

    await runInRepos(this.manager, {
      title: t('Checkout of \'{0}\'', refName(ref)),
      repos: scope.repos,
      check: (_repo, status) =>
        ref.type === 'local' && status.branch === ref.name ? { skip: t('already on that branch') } : undefined,
      run: async (repo) => {
        if (ref.type === 'local') {
          await repo.git.checkout(ref.name);
          return;
        }
        const branches = await repo.git.getBranches();
        if (branches.local.some((b) => b.name === ref.name)) {
          await repo.git.checkout(ref.name);
          return t('used the existing local branch \'{0}\'', ref.name);
        }
        await repo.git.checkoutTracking(ref.name, ref.full);
        return t('new local branch \'{0}\' → {1}', ref.name, ref.full);
      },
    });
  }

  /** Checkout and Rebase onto '<actual>': `git rebase <actual> <rama>`. */
  async checkoutAndRebase(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const current = new Map<Repo, string>();
    await runInRepos(this.manager, {
      title: t('Checkout of \'{0}\' and rebase onto \'{1}\'', ref.name, currentLabel(scope)),
      repos: scope.repos,
      requireClean: true,
      check: (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === ref.name) return { skip: t('already on that branch') };
        current.set(repo, status.branch);
        return undefined;
      },
      run: async (repo) => {
        await repo.git.rebase(current.get(repo)!, ref.name);
      },
    });
  }

  /** Rebase '<actual>' onto '<rama>'. */
  async rebaseOnto(scope: Scope, ref: BranchRef): Promise<void> {
    const target = refName(ref);
    await runInRepos(this.manager, {
      title: t('Rebase of \'{0}\' onto \'{1}\'', currentLabel(scope), target),
      repos: scope.repos,
      requireClean: true,
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === target) return { skip: t('it is the current branch') };
        if (!(await repo.git.revisionExists(target))) return { block: t('\'{0}\' does not exist', target) };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.rebase(target);
      },
    });
  }

  /** Merge '<rama>' into '<actual>'. */
  async merge(scope: Scope, ref: BranchRef): Promise<void> {
    const source = refName(ref);
    await runInRepos(this.manager, {
      title: t('Merge of \'{0}\' into \'{1}\'', source, currentLabel(scope)),
      repos: scope.repos,
      requireClean: true,
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === source) return { skip: t('it is the current branch') };
        if (!(await repo.git.revisionExists(source))) return { block: t('\'{0}\' does not exist', source) };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.merge(source);
      },
    });
  }

  /** Compare with '<actual>': commits que tiene cada lado y el otro no, por repo. */
  async compare(scope: Scope, ref: BranchRef): Promise<void> {
    const other = refName(ref);
    const label = currentLabel(scope);
    const sections = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('MultiGit: comparing \'{0}\' with \'{1}\'…', other, label) },
      () =>
        Promise.all(
          scope.repos.map(async (repo) => {
            try {
              const status = await repo.git.getStatus();
              const cur = status.branch ?? 'HEAD';
              const [incoming, outgoing] = await Promise.all([
                repo.git.logOneline(`${cur}..${other}`),
                repo.git.logOneline(`${other}..${cur}`),
              ]);
              return { repo, cur, incoming, outgoing };
            } catch (error) {
              return { repo, cur: '?', error: errorText(error), incoming: [], outgoing: [] };
            }
          }),
        ),
    );

    const lines = [`# '${other}' vs '${label}'`, ''];
    const same: string[] = [];
    for (const s of sections) {
      if ('error' in s && s.error) {
        lines.push(`## ${s.repo.name}`, '', `❌ ${s.error}`, '');
        continue;
      }
      if (s.incoming.length === 0 && s.outgoing.length === 0) {
        same.push(s.repo.name);
        continue;
      }
      lines.push(`## ${s.repo.name}`, '');
      lines.push(t('### In \'{0}\' but not in \'{1}\' ({2})', other, s.cur, s.incoming.length), '');
      lines.push(...(s.incoming.length ? s.incoming.map((l) => `- ${l}`) : [t('_none_')]), '');
      lines.push(t('### In \'{0}\' but not in \'{1}\' ({2})', s.cur, other, s.outgoing.length), '');
      lines.push(...(s.outgoing.length ? s.outgoing.map((l) => `- ${l}`) : [t('_none_')]), '');
    }
    if (same.length) lines.push(t('## No differences'), '', same.join(', '), '');
    await this.compareView.show(`compare ${other} vs ${label}`, lines.join('\n'));
  }

  /** Show Diff with Working Tree: archivos que difieren entre la rama y el working tree de cada repo. */
  async diffWithWorkingTree(scope: Scope, ref: BranchRef): Promise<void> {
    const name = refName(ref);
    const groups = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('MultiGit: comparing \'{0}\' with the working tree…', name) },
      () =>
        Promise.all(
          scope.repos.map(async (repo) => ({ repo, files: await repo.git.diffWithWorkingTree(name).catch(() => []) })),
        ),
    );
    type Item = vscode.QuickPickItem & { repo?: Repo; file?: { status: string; path: string; oldPath?: string } };
    const items: Item[] = [];
    for (const { repo, files } of groups) {
      if (!files.length) continue;
      items.push({ label: `${repo.name} (${files.length})`, kind: vscode.QuickPickItemKind.Separator });
      for (const file of files) {
        const dir = path.posix.dirname(file.path);
        items.push({
          label: `${file.status}  ${path.posix.basename(file.path)}`,
          description: dir === '.' ? '' : dir,
          repo,
          file,
        });
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: \'{0}\' has no differences with the working tree.', name));
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Diff of \'{0}\' with the working tree — {1}', name, scope.label),
      placeHolder: t('Choose a file to see its diff'),
      matchOnDescription: true,
    });
    if (!picked?.repo || !picked.file) return;
    const { repo, file } = picked;
    const left = GitContentProvider.uri(repo.root, file.status === 'A' ? '' : name, file.oldPath ?? file.path);
    const right =
      file.status === 'D'
        ? GitContentProvider.uri(repo.root, '', file.path)
        : vscode.Uri.file(path.join(repo.root, file.path));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(file.path)} (${name} ↔ local)`, {
      preview: true,
    });
  }

  /** New Worktree from '<rama>'…: un worktree por repo bajo una carpeta común. */
  async newWorktree(scope: Scope, ref: BranchRef): Promise<void> {
    const repos = scope.repos;
    const single = repos.length === 1;
    const ancestor = commonAncestor(repos.map((r) => r.root));
    const anchor = single ? repos[0]!.root : ancestor;
    const folder = branchToFolderName(ref.name);
    const base = await vscode.window.showInputBox({
      title: t('New worktree from \'{0}\' — {1}', refName(ref), scope.label),
      prompt: single
        ? t('Worktree folder')
        : t('Base folder: each repository goes in a subfolder with its relative path (e.g. <base>/mftheme)'),
      value: `${anchor}-worktrees${path.sep}${folder}`,
      validateInput: (v) => (path.isAbsolute(v.trim()) ? undefined : t('Use an absolute path')),
    });
    if (!base) return;
    const dirOf = (repo: Repo) => (single ? base.trim() : path.join(base.trim(), path.relative(ancestor, repo.root)));

    const results = await runInRepos(this.manager, {
      title: t('New worktree from \'{0}\'', refName(ref)),
      repos,
      check: async (repo, status) => {
        if (await pathExists(dirOf(repo))) return { block: `ya existe ${dirOf(repo)}` };
        if (ref.type === 'local' && status.branch === ref.name) {
          return { block: t('\'{0}\' is the current branch of this repository (a worktree cannot use it)', ref.name) };
        }
        return undefined;
      },
      run: async (repo) => {
        const dir = dirOf(repo);
        if (ref.type === 'local') {
          await repo.git.addWorktree(dir, ref.name);
        } else {
          const branches = await repo.git.getBranches();
          if (branches.local.some((b) => b.name === ref.name)) await repo.git.addWorktree(dir, ref.name);
          else await repo.git.addWorktreeTracking(dir, ref.name, ref.full);
        }
        return dir;
      },
    });

    if (results?.every((r) => r.state === 'ok' || r.state === 'skipped')) {
      const open = await vscode.window.showInformationMessage(t('Worktree created in {0}', base), t('Open in New Window'));
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(base.trim()), { forceNewWindow: true });
    }
  }

  /** Update: pull de esa rama (o fetch si no es la actual / si es remota). */
  async update(scope: Scope, ref: BranchRef): Promise<void> {
    if (ref.type === 'remote') {
      await runInRepos(this.manager, {
        title: t('Update of \'{0}\'', ref.full),
        repos: scope.repos,
        run: async (repo) => {
          await repo.git.fetchBranch(ref.remote, ref.name);
        },
      });
      return;
    }

    const info = new Map<Repo, LocalBranch>();
    await runInRepos(this.manager, {
      title: t('Update of \'{0}\'', ref.name),
      repos: scope.repos,
      check: async (repo) => {
        const lb = (await repo.git.getBranches()).local.find((b) => b.name === ref.name);
        if (!lb) return { block: t('branch \'{0}\' does not exist', ref.name) };
        if (!lb.upstreamRemote || !lb.upstreamBranch) return { skip: t('the branch has no upstream') };
        if (lb.gone) return { skip: t('upstream {0} no longer exists', lb.upstream) };
        info.set(repo, lb);
        return undefined;
      },
      run: async (repo) => {
        const lb = info.get(repo)!;
        if (lb.current) await repo.git.pull();
        else await repo.git.fetchIntoBranch(lb.upstreamRemote!, lb.upstreamBranch!, lb.name);
      },
    });
  }

  /** Rename… (F2). */
  async rename(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const newName = await this.askBranchName(scope, t('Rename \'{0}\' — {1}', ref.name, scope.label), ref.name);
    if (!newName || newName === ref.name) return;

    await runInRepos(this.manager, {
      title: t('Rename \'{0}\' to \'{1}\'', ref.name, newName),
      repos: scope.repos,
      check: async (repo) => {
        const branches = await repo.git.getBranches();
        if (!branches.local.some((b) => b.name === ref.name)) return { skip: t('\'{0}\' does not exist', ref.name) };
        if (branches.local.some((b) => b.name === newName)) return { block: t('branch \'{0}\' already exists', newName) };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.renameBranch(ref.name, newName);
      },
    });
  }

  /** Delete de una rama local, con confirmación y `-D` opcional para las no mergeadas. */
  async deleteLocal(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const name = ref.name;
    const unmerged = new Map<Repo, number>();
    const currentIn: string[] = [];
    const missing = new Set<Repo>();

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: checking branches…') }, () =>
      Promise.all(
        scope.repos.map(async (repo) => {
          const lb = (await repo.git.getBranches()).local.find((b) => b.name === name);
          if (!lb) return void missing.add(repo);
          if (lb.current) return void currentIn.push(repo.name);
          const merged =
            (await repo.git.isAncestor(name, 'HEAD')) ||
            (!!lb.upstream && !lb.gone && (await repo.git.isAncestor(name, lb.upstream)));
          if (!merged) unmerged.set(repo, await repo.git.countCommits(`HEAD..${name}`));
        }),
      ),
    );

    if (currentIn.length) {
      void vscode.window.showErrorMessage(t('MultiGit: \'{0}\' cannot be deleted', name), {
        modal: true,
        detail: t('It is the current branch in: {0}.\nCheck out another branch first.\n\nNo repository was modified.', currentIn.join(', ')),
      });
      return;
    }

    const targets = scope.repos.filter((r) => !missing.has(r));
    const detailLines = [t('Local branch \'{0}\' will be deleted in:', name), ...targets.map((r) => `  • ${r.name}`)];
    if (unmerged.size) {
      detailLines.push('', t('⚠ Not merged (commits will be lost if forced with -D):'));
      for (const [repo, count] of unmerged) detailLines.push(t('  • {0}: {1} commit(s) only in \'{2}\'', repo.name, count, name));
    }
    const FORCE = t('Delete and Force (-D) Unmerged');
    const SAFE = unmerged.size ? t('Delete Merged Only') : t('Delete');
    const choice = await vscode.window.showWarningMessage(
      t('Delete branch \'{0}\' in {1} repositories?', name, targets.length),
      { modal: true, detail: detailLines.join('\n') },
      ...(unmerged.size ? [SAFE, FORCE] : [SAFE]),
    );
    if (!choice) return;
    const force = choice === FORCE;

    await runInRepos(this.manager, {
      title: t('Delete branch \'{0}\'', name),
      repos: targets,
      check: (repo) => (unmerged.has(repo) && !force ? { skip: t('not merged (not forced)') } : undefined),
      run: async (repo) => {
        await repo.git.deleteBranch(name, unmerged.has(repo));
      },
    });
  }

  /** Delete de una rama remota (`git push <remote> --delete`), con confirmación. */
  async deleteRemote(scope: Scope, ref: BranchRef & { type: 'remote' }): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      t('Delete remote branch \'{0}\' from the server?', ref.full),
      {
        modal: true,
        detail: [
          t('"git push {0} --delete {1}" will run in:', ref.remote, ref.name),
          ...scope.repos.map((r) => `  • ${r.name}`),
          '',
          t('The branch will disappear from the remote for the whole team. Commits that only exist in it will be lost.'),
        ].join('\n'),
      },
      t('Delete from Remote'),
    );
    if (!choice) return;

    await runInRepos(this.manager, {
      title: t('Delete \'{0}\' from the remote', ref.full),
      repos: scope.repos,
      run: async (repo) => {
        await repo.git.deleteRemoteBranch(ref.remote, ref.name);
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private async askBranchName(scope: Scope, title: string, value?: string): Promise<string | undefined> {
    const probe = scope.repos[0];
    if (!probe) return undefined;
    const name = await vscode.window.showInputBox({
      title,
      value,
      prompt: t('Branch name'),
      validateInput: async (v) => {
        const n = v.trim();
        if (!n) return t('Type a name');
        return (await probe.git.isValidBranchName(n)) ? undefined : t('"{0}" is not a valid branch name', n);
      },
    });
    return name?.trim() || undefined;
  }

  /** Si hay repos con cambios sin commit, avisa (git los conserva si no chocan). */
  private async confirmDirty(scope: Scope, title: string): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('multigit').get<boolean>('confirmCheckoutWithChanges', true)) return true;
    const dirty = scope.repos.filter((r) => (r.status?.changes.total ?? 0) > 0);
    if (dirty.length === 0) return true;
    const choice = await vscode.window.showWarningMessage(
      t('{0}: there are uncommitted changes', title),
      {
        modal: true,
        detail: [
          ...dirty.map((r) => t('  • {0}: {1} change(s)', r.name, r.status!.changes.total)),
          '',
          t('Git will try to keep them. If they conflict with the other branch, the checkout fails in that repository and the operation stops.'),
        ].join('\n'),
      },
      t('Continue'),
    );
    return choice === t('Continue');
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
