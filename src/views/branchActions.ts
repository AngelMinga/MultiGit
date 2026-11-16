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
import { resolveConflicts } from './conflicts';
import type { PullMode } from '../git/pull';
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

/** Repo que recibió commits en un Update (para la ventana Update Info). */
export interface UpdatedRepo {
  repo: Repo;
  /** HEAD antes del update. */
  before: string;
  /** Hasta dónde llegó lo nuevo (HEAD tras el merge; el upstream tras un rebase). */
  after: string;
  branch: string;
}

/** Cómo se cambia de rama en cada repo (ver planSwitch). */
interface SwitchPlan {
  mode: 'normal' | 'smart' | 'force';
  /** Repos donde el cambio pisaría cambios locales, con esos archivos. */
  collisions: Map<Repo, string[]>;
  /** Repos donde Smart Checkout dejó conflictos al reaplicar los cambios. */
  conflicts: Map<Repo, string[]>;
  label: string;
}

export class BranchActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly compareView: CompareView,
    private readonly openPush: (scope: Scope, branch?: string) => Promise<void>,
    private readonly openUpdateInfo: (updated: readonly UpdatedRepo[]) => Promise<void> = async () => undefined,
  ) {}

  // ------------------------------------------------------------------ acciones generales

  /**
   * Update Project (como IntelliJ): pregunta Merge o Rebase (salvo que se haya elegido "no volver a
   * preguntar"), hace fetch + pull del upstream en cada repo y al final ofrece ver lo que llegó (Update Info).
   */
  async updateProject(scope: Scope): Promise<void> {
    const method = await askUpdateMethod();
    if (!method) return;
    const updated: UpdatedRepo[] = [];
    await runInRepos(this.manager, {
      title: method === 'rebase' ? t('Update Project (rebase)') : t('Update Project (merge)'),
      repos: scope.repos,
      continueAfterConflict: true,
      check: (_repo, status) => {
        if (!status.branch) return { skip: 'HEAD detached' };
        if (!status.upstream) return { skip: t('the branch has no upstream') };
        if (status.ahead === null) return { skip: t('upstream {0} no longer exists', status.upstream) };
        return undefined;
      },
      run: (repo) => this.updateRepo(repo, method, updated),
      finish: () => updateFinish(updated, this.openUpdateInfo),
    });
  }

  /** Fetch + pull (merge o rebase) del upstream de un repo; si llegó algo, lo apunta en `updated`. */
  private async updateRepo(repo: Repo, method: PullMode, updated: UpdatedRepo[]): Promise<string> {
    await repo.git.fetchAll();
    const after = await repo.git.getStatus();
    if (!after.behind) return t('already up to date');
    const before = await repo.git.headSha();
    const upstream = after.upstream ? (await repo.git.resolveCommit(after.upstream)) ?? undefined : undefined;
    await repo.git.pullWith(method);
    const head = await repo.git.headSha();
    // Con rebase los commits locales se rehacen: lo que llegó es lo del upstream, no before..HEAD.
    if (before && head && before !== head) updated.push({ repo, before, after: method === 'rebase' && upstream ? upstream : head, branch: after.branch ?? '' });
    return t('updated (↓{0})', after.behind);
  }

  /** Pull…: diálogo como IntelliJ (con el repo ya elegido si el alcance es uno). */
  async pull(scope: Scope): Promise<void> {
    await vscode.commands.executeCommand('multigit.pull', scope.repos.length === 1 ? scope.repos[0] : undefined);
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
    // Cambiar a la rama nueva desde otra revisión puede pisar cambios locales: Smart Checkout.
    const plan =
      mode.checkout && start
        ? await this.planSwitch(scope, startRef, t('New branch \'{0}\' from \'{1}\'', name, startRef), async () => startRef)
        : ({ mode: 'normal', collisions: new Map(), conflicts: new Map(), label: startRef } as SwitchPlan);
    if (!plan) return;

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
      run: (repo) =>
        mode.checkout
          ? this.runSwitch(repo, plan, async (force) => {
              await repo.git.createBranch(name, startRef, true, force);
              return undefined;
            })
          : repo.git.createBranch(name, startRef, false).then(() => undefined),
    });
    await this.finishSwitch(plan);
  }

  /**
   * Alinear: checkout de `target` en los repos que están en otra rama (local si existe; si no,
   * se crea siguiendo a la remota). Los repos sin esa rama se omiten.
   */
  async alignTo(target: string, repos: readonly Repo[]): Promise<void> {
    const scope: Scope = { repos, label: t('{0} repositories', repos.length) };
    const plan = await this.planSwitch(scope, target, t('Checkout of \'{0}\'', target), async (repo) => {
      if (repo.status?.branch === target) return undefined;
      const b = await repo.git.getBranches();
      if (b.local.some((l) => l.name === target)) return target;
      return (b.remote.find((r) => r.name === target && r.remote === 'origin') ?? b.remote.find((r) => r.name === target))?.full;
    });
    if (!plan) return;
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
      run: (repo) =>
        this.runSwitch(repo, plan, async (force) => {
          const remote = remoteRef.get(repo);
          if (remote) {
            await repo.git.checkoutTracking(target, remote, force);
            return t('new local branch from {0}', remote);
          }
          await repo.git.checkout(target, force);
          return undefined;
        }),
    });
    await this.finishSwitch(plan);
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
    const title = t('Checkout of \'{0}\'', refName(ref));
    // Rama a la que se cambia en cada repo: la local, o la remota si todavía no hay local.
    const plan = await this.planSwitch(scope, refName(ref), title, async (repo) => {
      if (ref.type === 'local') return repo.status?.branch === ref.name ? undefined : ref.name;
      const branches = await repo.git.getBranches();
      return branches.local.some((b) => b.name === ref.name) ? ref.name : ref.full;
    });
    if (!plan) return;

    await runInRepos(this.manager, {
      title,
      repos: scope.repos,
      check: (_repo, status) =>
        ref.type === 'local' && status.branch === ref.name ? { skip: t('already on that branch') } : undefined,
      run: (repo) =>
        this.runSwitch(repo, plan, async (force) => {
          if (ref.type === 'local') {
            await repo.git.checkout(ref.name, force);
            return undefined;
          }
          const branches = await repo.git.getBranches();
          if (branches.local.some((b) => b.name === ref.name)) {
            await repo.git.checkout(ref.name, force);
            return t('used the existing local branch \'{0}\'', ref.name);
          }
          await repo.git.checkoutTracking(ref.name, ref.full, force);
          return t('new local branch \'{0}\' → {1}', ref.name, ref.full);
        }),
    });
    await this.finishSwitch(plan);
  }

  // ------------------------------------------------------------------ Smart Checkout (común)

  /**
   * Antes de cambiar de rama: en qué repos el cambio sobrescribiría cambios locales (git fallaría ahí).
   * Si hay alguno, pregunta Smart Checkout / Force Checkout; si no, el aviso de cambios de siempre.
   * `targetOf` da la revisión a la que irá cada repo (undefined = ese repo no cambia).
   * Devuelve undefined si se cancela.
   */
  private async planSwitch(scope: Scope, label: string, title: string, targetOf: (repo: Repo) => Promise<string | undefined>): Promise<SwitchPlan | undefined> {
    const collisions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('MultiGit: checking local changes…') }, async () => {
      const found = new Map<Repo, string[]>();
      await Promise.all(
        scope.repos
          .filter((r) => (r.status?.changes.total ?? 0) > 0)
          .map(async (repo) => {
            const target = await targetOf(repo).catch(() => undefined);
            if (!target || !(await repo.git.revisionExists(target))) return;
            const files = await repo.git.wouldBeOverwritten(target, await repo.git.getChanges()).catch(() => []);
            if (files.length) found.set(repo, files);
          }),
      );
      return found;
    });
    let mode: SwitchPlan['mode'] = 'normal';
    if (collisions.size) {
      const chosen = await askCheckoutProblem(label, collisions);
      if (!chosen) return undefined;
      mode = chosen;
    } else if (!(await this.confirmDirty(scope, title))) {
      return undefined;
    }
    return { mode, collisions, conflicts: new Map(), label };
  }

  /** Hace el cambio de rama en un repo según el plan (normal, Smart Checkout o Force Checkout). */
  private async runSwitch(repo: Repo, plan: SwitchPlan, doCheckout: (force: boolean) => Promise<string | undefined>): Promise<string | undefined> {
    if (plan.mode === 'smart' && plan.collisions.has(repo)) {
      let note: string | undefined;
      const result = await repo.git.smartCheckout(plan.label, async () => {
        note = await doCheckout(false);
      });
      if (result.conflicts.length) {
        plan.conflicts.set(repo, result.conflicts);
        return t('local changes restored with {0} conflict(s)', result.conflicts.length);
      }
      return [note, t('local changes kept (Smart Checkout)')].filter(Boolean).join(' · ');
    }
    const force = plan.mode === 'force' && plan.collisions.has(repo);
    return (await doCheckout(force)) ?? (force ? t('local changes discarded (Force Checkout)') : undefined);
  }

  /** Tras un Smart Checkout con conflictos: ofrecer resolverlos. */
  private async finishSwitch(plan: SwitchPlan): Promise<void> {
    if (plan.conflicts.size) await offerSmartCheckoutConflicts(plan.label, plan.conflicts);
  }

  /** Checkout and Rebase onto '<actual>': `git rebase <actual> <rama>`. */
  async checkoutAndRebase(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const current = new Map<Repo, string>();
    await runInRepos(this.manager, {
      title: t('Checkout of \'{0}\' and rebase onto \'{1}\'', ref.name, currentLabel(scope)),
      repos: scope.repos,
      continueAfterConflict: true,
      // Sin exigir repo limpio: `rebase --autostash` aparta los cambios y los vuelve a aplicar.
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
      continueAfterConflict: true,
      // Sin exigir repo limpio: `rebase --autostash` aparta los cambios y los vuelve a aplicar.
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

  /**
   * Merge '<rama>' into '<actual>'. Como IntelliJ, desde el menú de una rama es directo (sin preguntar);
   * las opciones (--no-ff, --squash, mensaje…) llegan desde "Merge…" (mergeWithOptions).
   */
  async merge(scope: Scope, ref: BranchRef, chosen: { options: string[]; message?: string } = { options: [] }): Promise<void> {
    const source = refName(ref);
    const { options, message } = chosen;
    await runInRepos(this.manager, {
      title: t('Merge of \'{0}\' into \'{1}\'', source, currentLabel(scope)),
      repos: scope.repos,
      continueAfterConflict: true,
      // Sin requireClean: los cambios sin commit se apartan y se restauran solos (`--autostash`).
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === source) return { skip: t('it is the current branch') };
        if (!(await repo.git.revisionExists(source))) return { block: t('\'{0}\' does not exist', source) };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.merge(source, options, message);
        if (options.includes('--squash')) return t('changes merged and staged: commit them');
        if (options.includes('--no-commit')) return t('merged without commit: review and commit');
        return undefined;
      },
    });
  }

  /**
   * Merge… (como Git → Merge… de IntelliJ): elegir la rama a integrar en la actual y las opciones.
   * Sin `ref`, se ofrecen las ramas locales y remotas de los repos.
   */
  async mergeWithOptions(scope: Scope, ref?: BranchRef): Promise<void> {
    let target = ref;
    if (!target) {
      const lists = await Promise.all(scope.repos.map((r) => r.git.getBranches().catch(() => undefined)));
      const current = new Set(scope.repos.map((r) => r.status?.branch).filter(Boolean));
      const locals = new Map<string, number>();
      const remotes = new Map<string, { ref: BranchRef; count: number }>();
      for (const b of lists) {
        for (const l of b?.local ?? []) if (!current.has(l.name)) locals.set(l.name, (locals.get(l.name) ?? 0) + 1);
        for (const r of b?.remote ?? []) {
          const e = remotes.get(r.full) ?? { ref: { type: 'remote', remote: r.remote, name: r.name, full: r.full } as BranchRef, count: 0 };
          e.count++;
          remotes.set(r.full, e);
        }
      }
      const n = scope.repos.length;
      const picked = await vscode.window.showQuickPick(
        [
          { label: t('Local'), kind: vscode.QuickPickItemKind.Separator },
          ...[...locals].sort().map(([name, count]) => ({ label: `$(git-branch) ${name}`, description: count < n ? `${count}/${n}` : '', ref: { type: 'local', name } as BranchRef })),
          { label: t('Remote'), kind: vscode.QuickPickItemKind.Separator },
          ...[...remotes.values()]
            .sort((a, b) => refName(a.ref).localeCompare(refName(b.ref)))
            .map((e) => ({ label: `$(cloud) ${refName(e.ref)}`, description: e.count < n ? `${e.count}/${n}` : '', ref: e.ref })),
        ] as Array<vscode.QuickPickItem & { ref?: BranchRef }>,
        { title: t("Merge into '{0}'", currentLabel(scope)), placeHolder: t('Branch to merge into the current one') },
      );
      target = picked?.ref;
    }
    if (!target) return;
    const chosen = await askMergeOptions(refName(target), currentLabel(scope));
    if (!chosen) return;
    await this.merge(scope, target, chosen);
  }

  /**
   * Pull into '<actual>' Using Merge / Using Rebase (menú de una rama remota, como IntelliJ): fetch de esa
   * rama y merge o rebase de la actual sobre ella. Los cambios sin commit se apartan (`--autostash`).
   */
  async pullInto(scope: Scope, ref: BranchRef & { type: 'remote' }, mode: 'merge' | 'rebase'): Promise<void> {
    const updated: UpdatedRepo[] = [];
    await runInRepos(this.manager, {
      title: mode === 'rebase' ? t("Pull '{0}' into '{1}' (rebase)", ref.full, currentLabel(scope)) : t("Pull '{0}' into '{1}' (merge)", ref.full, currentLabel(scope)),
      repos: scope.repos,
      continueAfterConflict: true,
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (!(await repo.git.revisionExists(ref.full))) return { skip: t("'{0}' does not exist", ref.full) };
        return undefined;
      },
      run: async (repo) => {
        const before = await repo.git.headSha();
        await repo.git.pullWith(mode, ref.remote, ref.name);
        const head = await repo.git.headSha();
        if (!before || !head || before === head) return t('already up to date');
        const after = mode === 'rebase' ? ((await repo.git.resolveCommit(ref.full)) ?? head) : head;
        updated.push({ repo, before, after, branch: repo.status?.branch ?? '' });
        const count = await repo.git.countCommits(`${before}..${after}`);
        return count ? t('updated (+{0} commit(s))', count) : t('updated');
      },
      finish: () => updateFinish(updated, this.openUpdateInfo),
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
        : t('Base folder: each repository goes in a subfolder with its relative path (e.g. <base>/web-theme)'),
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

    // La rama actual se actualiza como Update Project (merge o rebase); las demás solo avanzan (fast-forward).
    const method = scope.repos.some((r) => r.status?.branch === ref.name) ? await askUpdateMethod() : 'merge';
    if (!method) return;
    const updated: UpdatedRepo[] = [];
    const info = new Map<Repo, LocalBranch>();
    await runInRepos(this.manager, {
      title: t('Update of \'{0}\'', ref.name),
      repos: scope.repos,
      continueAfterConflict: true,
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
        if (lb.current) return this.updateRepo(repo, method!, updated);
        await repo.git.fetchIntoBranch(lb.upstreamRemote!, lb.upstreamBranch!, lb.name);
        return undefined;
      },
      finish: () => updateFinish(updated, this.openUpdateInfo),
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

/**
 * "Git Checkout Problem" (como IntelliJ): los cambios locales de estos archivos se sobrescribirían.
 * Smart Checkout los guarda, cambia de rama y los vuelve a aplicar; Force Checkout los descarta.
 */
async function askCheckoutProblem(target: string, collisions: ReadonlyMap<Repo, string[]>): Promise<'smart' | 'force' | undefined> {
  const lines: string[] = [];
  for (const [repo, files] of collisions) {
    lines.push(`${repo.name} — ${t('{0} file(s)', files.length)}`);
    for (const f of files.slice(0, 8)) lines.push(`    ${f}`);
    if (files.length > 8) lines.push(`    ${t('…and {0} more', files.length - 8)}`);
  }
  const SMART = t('Smart Checkout');
  const FORCE = t('Force Checkout');
  const choice = await vscode.window.showWarningMessage(
    t("Your local changes would be overwritten by the checkout of '{0}'", target),
    {
      modal: true,
      detail: [
        ...lines,
        '',
        t('Smart Checkout: MultiGit puts your changes aside, checks out and applies them again (if they conflict, you resolve them in the merge editor).'),
        t('Force Checkout: discards your local changes in those repositories.'),
      ].join('\n'),
    },
    SMART,
    FORCE,
  );
  if (choice === SMART) return 'smart';
  if (choice !== FORCE) return undefined;
  const DISCARD = t('Discard and Checkout');
  const sure = await vscode.window.showWarningMessage(
    t('Discard the local changes of {0} repo(s)?', collisions.size),
    { modal: true, detail: t('git checkout -f discards ALL the uncommitted changes of tracked files in: {0}. This cannot be undone.', [...collisions.keys()].map((r) => r.name).join(', ')) },
    DISCARD,
  );
  return sure === DISCARD ? 'force' : undefined;
}

/** Tras un Smart Checkout con conflictos: abrir el merge editor (el stash queda como copia). */
async function offerSmartCheckoutConflicts(target: string, conflicts: ReadonlyMap<Repo, string[]>): Promise<void> {
  const RESOLVE = t('Resolve Conflicts');
  const choice = await vscode.window.showWarningMessage(
    t("Your local changes conflict with '{0}'", target),
    {
      modal: true,
      detail: [
        ...[...conflicts].map(([repo, files]) => `${repo.name}: ${files.join(', ')}`),
        '',
        t('Resolve them in the merge editor (Current = the branch, Incoming = your changes). A copy of your changes stays in the Stashes view; drop it when you are done.'),
      ].join('\n'),
    },
    RESOLVE,
  );
  if (choice !== RESOLVE) return;
  const repos = [...conflicts.keys()];
  const repo =
    repos.length === 1
      ? repos[0]
      : (await vscode.window.showQuickPick(repos.map((r) => ({ label: `$(repo) ${r.name}`, description: t('{0} file(s)', conflicts.get(r)!.length), r })), { title: RESOLVE }))?.r;
  if (repo) await resolveConflicts(repo, conflicts.get(repo)!);
}

/** Opciones de merge elegidas la última vez (durante la sesión). */
let lastMergeOptions: string[] = [];

/**
 * Opciones del merge, como el diálogo de IntelliJ: --no-ff, --ff-only, --squash, --no-commit y mensaje
 * propio. Enter sin marcar nada = merge normal. Devuelve undefined si se cancela.
 */
async function askMergeOptions(source: string, current: string): Promise<{ options: string[]; message?: string } | undefined> {
  const MESSAGE = '-m';
  const items = [
    { label: '--no-ff', description: t('always create the merge commit'), value: '--no-ff' },
    { label: '--ff-only', description: t('only if it can move forward without a merge commit'), value: '--ff-only' },
    { label: '--squash', description: t('bring the changes in a single block, without commit; then you commit them'), value: '--squash' },
    { label: '--no-commit', description: t('do the merge but stop before the commit to review'), value: '--no-commit' },
    { label: `-m  ${t('Custom message…')}`, description: t('merge commit message'), value: MESSAGE },
  ];
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      items.map((i) => ({ ...i, picked: lastMergeOptions.includes(i.value) })),
      {
        title: t("Merge '{0}' into '{1}'", source, current),
        placeHolder: t('Options (Enter without checking anything = normal merge)'),
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked) return undefined;
    const values = picked.map((p) => p.value);
    const has = (v: string) => values.includes(v);
    const invalid =
      has('--squash') && (has('--no-ff') || has('--no-commit'))
        ? t('--squash cannot be combined with --no-ff or --no-commit')
        : has('--ff-only') && (has('--no-ff') || has('--squash'))
          ? t('--ff-only cannot be combined with --no-ff or --squash')
          : has(MESSAGE) && (has('--squash') || has('--ff-only'))
            ? t('A custom message needs a merge commit (not with --squash or --ff-only)')
            : undefined;
    if (invalid) {
      void vscode.window.showWarningMessage(`MultiGit: ${invalid}`);
      continue;
    }
    lastMergeOptions = values;
    let message: string | undefined;
    if (has(MESSAGE)) {
      message = (
        await vscode.window.showInputBox({
          title: t('Merge commit message'),
          value: `Merge branch '${source}' into ${current}`,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : t('Type a message')),
        })
      )?.trim();
      if (!message) return undefined;
    }
    return { options: values.filter((v) => v !== MESSAGE), message };
  }
}

/** Último método elegido (preseleccionado la próxima vez). */
let lastUpdateMethod: PullMode = 'merge';

/**
 * Método del Update Project: el del ajuste `multigit.update.method`, o lo que elija el usuario (Merge /
 * Rebase, como el diálogo de IntelliJ). "No volver a preguntar" lo guarda en el ajuste.
 */
export async function askUpdateMethod(): Promise<PullMode | undefined> {
  const config = vscode.workspace.getConfiguration('multigit.update');
  const saved = config.get<string>('method', 'ask');
  if (saved === 'merge' || saved === 'rebase') return saved;
  type Item = vscode.QuickPickItem & { method?: PullMode; remember?: boolean };
  const merge: Item = { label: '$(git-merge) Merge', description: t('integrates the incoming commits with a merge commit'), method: 'merge' };
  const rebase: Item = { label: '$(git-pull-request) Rebase', description: t('puts your local commits on top of the incoming ones'), method: 'rebase' };
  const items: Item[] = [
    ...(lastUpdateMethod === 'rebase' ? [rebase, merge] : [merge, rebase]),
    { label: t("Don't ask again"), kind: vscode.QuickPickItemKind.Separator },
    { label: t('Always Merge'), description: t('saved in the setting multigit.update.method'), method: 'merge', remember: true },
    { label: t('Always Rebase'), description: t('saved in the setting multigit.update.method'), method: 'rebase', remember: true },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: t('Update Project'), placeHolder: t('Update type') });
  if (!picked?.method) return undefined;
  lastUpdateMethod = picked.method;
  if (picked.remember) await config.update('method', picked.method, vscode.ConfigurationTarget.Global);
  return picked.method;
}

/** Mensaje final del update como IntelliJ ("N commits en M repositorios") y el botón para ver lo que llegó. */
function updateFinish(updated: readonly UpdatedRepo[], open: (updated: readonly UpdatedRepo[]) => Promise<void>) {
  if (!updated.length) return {};
  return {
    message: t('✅ MultiGit: project updated in {0} repositories — View Updates to see the incoming commits and files', updated.length),
    action: { label: t('View Updates'), run: () => void open(updated) },
  };
}
