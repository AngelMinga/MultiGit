// Popup de ramas al estilo IntelliJ: Acciones / Repositorios / Common Local Branches /
// Common Remote Branches. Al elegir una rama se abre un segundo QuickPick con sus acciones.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import { computeAlignment } from '../git/alignment';
import { commonLocalBranches, commonRemoteBranches, type RepoBranchesInput } from '../git/branches';
import { errorText } from '../git/MultiRepoRunner';
import { describeHead } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';
import { currentLabel, refName, type BranchActions, type BranchRef, type Scope } from './branchActions';
import type { RepoIcons } from './repoIcons';

const CONTEXT_KEY = 'multigit.branchPopupOpen';

interface PopupItem extends vscode.QuickPickItem {
  action?: () => Promise<unknown>;
  repo?: Repo;
  ref?: BranchRef;
}

export class BranchPopup {
  private active: { qp: vscode.QuickPick<PopupItem>; scope: Scope } | undefined;

  constructor(
    private readonly manager: RepoManager,
    private readonly actions: BranchActions,
    private readonly icons: RepoIcons,
  ) {}

  /** Abre el popup para todos los repos, o solo para `repo`. */
  async show(repo?: Repo): Promise<void> {
    const repos = repo ? [repo] : [...this.manager.all];
    if (repos.length === 0) {
      void vscode.window.showInformationMessage('MultiGit: no hay repositorios detectados.');
      return;
    }
    const scope: Scope = { repos, label: repo ? repo.name : 'todos los repositorios' };

    const qp = vscode.window.createQuickPick<PopupItem>();
    qp.title = repo ? `MultiGit: ramas de ${repo.name}` : `MultiGit: ramas (${repos.length} repositorios)`;
    qp.placeholder = 'Buscar ramas, acciones y repositorios';
    qp.matchOnDescription = true;
    qp.busy = true;
    if (repo) qp.buttons = [vscode.QuickInputButtons.Back];
    this.active = { qp, scope };
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);

    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        qp.hide();
        void this.show();
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (!item) return;
      qp.hide();
      if (item.action) void this.safely(item.action);
      else if (item.repo) void this.show(item.repo);
      else if (item.ref) void this.safely(() => this.showBranchActions(scope, item.ref!));
    });
    qp.onDidHide(() => {
      if (this.active?.qp === qp) {
        this.active = undefined;
        void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
      }
      qp.dispose();
    });
    qp.show();

    const loaded = await Promise.all(
      repos.map(async (r) => {
        try {
          return { repo: r.name, branches: await r.git.getBranches() } satisfies RepoBranchesInput;
        } catch {
          return undefined;
        }
      }),
    );
    const data = loaded.filter((d): d is RepoBranchesInput => !!d);
    const failed = repos.filter((_, i) => !loaded[i]).map((r) => r.name);
    if (failed.length) qp.title += ` — sin datos de: ${failed.join(', ')}`;

    qp.items = this.buildItems(scope, data, !repo);
    qp.busy = false;
  }

  /** F2 dentro del popup: renombrar la rama local resaltada. */
  renameActive(): void {
    const active = this.active;
    const ref = active?.qp.activeItems[0]?.ref;
    if (!active || ref?.type !== 'local') return;
    active.qp.hide();
    void this.safely(() => this.actions.rename(active.scope, ref));
  }

  /** Ítems del popup, en el orden y con el aspecto del popup de ramas de IntelliJ. */
  private buildItems(scope: Scope, data: RepoBranchesInput[], allRepos: boolean): PopupItem[] {
    const items: PopupItem[] = [];
    const sep = (label = '') => items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    const favorites = this.manager.favoriteBranches;
    const total = scope.repos.length;
    const a = this.actions;
    const key = shortcutLabels();

    // ---- Desalineados: primero la acción para alinear
    const alignment = allRepos ? computeAlignment(scope.repos) : null;
    if (alignment) {
      items.push({
        label: `Alinear ${alignment.outliers.length} repo(s) con '${alignment.target}'`,
        iconPath: new vscode.ThemeIcon('warning'),
        description: alignment.outliers.map((o) => `${o.repo}: ${o.branch}`).join(' · '),
        action: () => a.alignTo(alignment.target, scope.repos.filter((r) => alignment.outliers.some((o) => o.repo === r.name))),
      });
    }

    // ---- Acciones (con los atajos, como IntelliJ)
    items.push(
      { label: 'Update Project…', iconPath: new vscode.ThemeIcon('repo-pull'), description: key.update, action: () => a.updateProject(scope) },
      ...(allRepos
        ? [{ label: 'Commit…', iconPath: new vscode.ThemeIcon('git-commit'), description: key.commit, action: () => a.commit() }]
        : []),
      { label: 'Push…', iconPath: new vscode.ThemeIcon('repo-push'), description: key.push, action: () => a.push(scope) },
      { label: 'Pull…', iconPath: new vscode.ThemeIcon('arrow-down'), description: 'remote, rama y modo', action: () => a.pull(scope) },
    );
    sep();
    items.push(
      { label: 'New Branch…', iconPath: new vscode.ThemeIcon('add'), description: `desde '${currentLabel(scope)}'`, action: () => a.newBranch(scope) },
      { label: 'New Worktree…', iconPath: new vscode.ThemeIcon('folder-opened'), action: () => this.pickWorktreeBranch(scope, data) },
      { label: 'Checkout Tag or Revision…', iconPath: new vscode.ThemeIcon('tag'), action: () => a.checkoutRevision(scope) },
    );

    // ---- Repositorios: cuadrado de color + rama actual + ›
    if (allRepos && scope.repos.length > 1) {
      sep('Repositorios');
      for (const repo of scope.repos) {
        const s = repo.status;
        const counters = s ? formatAheadBehind(s) : '';
        items.push({
          label: repo.name,
          iconPath: this.icons.iconFor(repo.colorIndex),
          description: s ? `${describeHead(s)}${counters ? `  ${counters}` : ''}  ›` : '⚠ sin estado',
          repo,
        });
      }
    }

    // ---- Ramas locales: actual primero (🏷), favoritas (★), tracking a la derecha
    const locals = commonLocalBranches(data, favorites);
    const ordered = [
      ...locals.filter((b) => b.currentIn.length === total),
      ...locals.filter((b) => b.currentIn.length !== total),
    ];
    if (ordered.length) sep(allRepos ? 'Common Local Branches' : 'Local Branches');
    for (const b of ordered) {
      const isCurrent = b.currentIn.length === total;
      const upstream = commonUpstreamOf(data, b.name);
      const single = !allRepos ? data[0]?.branches.local.find((x) => x.name === b.name) : undefined;
      const desc = [
        !isCurrent && b.currentIn.length ? `actual en ${b.currentIn.length}/${total}` : '',
        single ? formatAheadBehind(single) : '',
        upstream ?? '',
        '›',
      ].filter(Boolean);
      items.push({
        label: b.name,
        iconPath: new vscode.ThemeIcon(isCurrent ? 'tag' : b.favorite ? 'star-full' : 'git-branch'),
        description: desc.join('  '),
        ref: { type: 'local', name: b.name },
      });
    }

    // ---- Ramas remotas, agrupadas por remote (origin)
    for (const [remote, list] of commonRemoteBranches(data, favorites)) {
      sep(`${allRepos ? 'Common Remote Branches' : 'Remote Branches'}  ›  ${remote}`);
      for (const b of list) {
        const name = b.name.slice(remote.length + 1);
        items.push({
          label: name,
          iconPath: new vscode.ThemeIcon(b.favorite ? 'star-full' : 'git-branch'),
          description: `${remote}  ›`,
          ref: { type: 'remote', remote, name, full: b.name },
        });
      }
    }

    if (allRepos && locals.length === 0 && data.length > 1) {
      sep('Common Local Branches');
      items.push({ label: 'No hay ramas locales comunes a todos los repos', iconPath: new vscode.ThemeIcon('info'), description: 'elige un repositorio arriba' });
    }
    return items;
  }

  /** New Worktree… (acción general): elegir la rama y crear el worktree. */
  private async pickWorktreeBranch(scope: Scope, data: RepoBranchesInput[]): Promise<void> {
    const favorites = this.manager.favoriteBranches;
    type Item = vscode.QuickPickItem & { ref?: BranchRef };
    const items: Item[] = [{ label: 'Local', kind: vscode.QuickPickItemKind.Separator }];
    for (const b of commonLocalBranches(data, favorites)) {
      if (b.currentIn.length) continue; // un worktree no puede usar la rama actual
      items.push({ label: b.name, iconPath: new vscode.ThemeIcon(b.favorite ? 'star-full' : 'git-branch'), ref: { type: 'local', name: b.name } });
    }
    for (const [remote, list] of commonRemoteBranches(data, favorites)) {
      items.push({ label: remote, kind: vscode.QuickPickItemKind.Separator });
      for (const b of list) {
        items.push({
          label: b.name,
          iconPath: new vscode.ThemeIcon('cloud'),
          ref: { type: 'remote', remote, name: b.name.slice(remote.length + 1), full: b.name },
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: `New Worktree — ${scope.label}`, placeHolder: 'Rama del worktree' });
    if (picked?.ref) await this.actions.newWorktree(scope, picked.ref);
  }

  /** Segundo QuickPick: acciones disponibles para `ref` en `scope`. */
  async showBranchActions(scope: Scope, ref: BranchRef): Promise<void> {
    const name = refName(ref);
    const cur = currentLabel(scope);
    const currentIn = scope.repos.filter((r) => r.status?.branch === name).length;
    const isCurrentEverywhere = ref.type === 'local' && currentIn === scope.repos.length;
    const isCurrentSomewhere = ref.type === 'local' && currentIn > 0;
    const a = this.actions;

    type ActionItem = vscode.QuickPickItem & { run?: () => Promise<unknown> };
    const items: ActionItem[] = [];
    const add = (when: boolean, label: string, run: () => Promise<unknown>, description?: string) => {
      if (when) items.push({ label, run, description });
    };

    add(!isCurrentEverywhere, '$(check) Checkout', () => a.checkout(scope, ref));
    add(true, `$(add) New Branch from '${name}'…`, () => a.newBranch(scope, ref));
    if (ref.type === 'local') {
      add(!isCurrentEverywhere, `$(git-pull-request) Checkout and Rebase onto '${cur}'`, () => a.checkoutAndRebase(scope, ref));
    }
    add(!isCurrentEverywhere, `$(git-compare) Compare with '${cur}'`, () => a.compare(scope, ref));
    add(true, '$(diff) Show Diff with Working Tree', () => a.diffWithWorkingTree(scope, ref));
    add(true, '$(history) Show in Git Log', async () => {
      const ids = scope.repos.length === this.manager.all.length ? [] : scope.repos.map((r) => r.root);
      await vscode.commands.executeCommand('multigit.log.showBranch', name, ids);
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    add(!isCurrentEverywhere, `$(git-pull-request) Rebase '${cur}' onto '${name}'`, () => a.rebaseOnto(scope, ref));
    add(!isCurrentEverywhere, `$(git-merge) Merge '${name}' into '${cur}'`, () => a.merge(scope, ref));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    add(!isCurrentSomewhere, `$(folder-opened) New Worktree from '${name}'…`, () => a.newWorktree(scope, ref));
    add(true, '$(sync) Update', () => a.update(scope, ref), ref.type === 'local' ? 'pull de esta rama' : 'fetch de esta rama');
    if (ref.type === 'local') {
      add(true, '$(repo-push) Push…', () => a.push(scope, ref.name));
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      add(true, '$(edit) Rename…', () => a.rename(scope, ref), 'F2');
      add(!isCurrentSomewhere, '$(trash) Delete', () => a.deleteLocal(scope, ref));
    } else {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      add(true, '$(trash) Delete', () => a.deleteRemote(scope, ref), 'elimina la rama del remote');
    }

    const picked = await vscode.window.showQuickPick(items, { title: `'${name}' — ${scope.label}` });
    if (picked?.run) await picked.run();
  }

  /** Ejecuta una acción mostrando cualquier error inesperado. */
  async safely(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    }
  }
}

/** Upstream de una rama local si es el mismo en todos los repos (p. ej. `origin/develop`). */
function commonUpstreamOf(data: readonly RepoBranchesInput[], branch: string): string | undefined {
  let upstream: string | undefined;
  for (const d of data) {
    const lb = d.branches.local.find((b) => b.name === branch);
    if (!lb?.upstream || lb.gone) return undefined;
    if (upstream !== undefined && upstream !== lb.upstream) return undefined;
    upstream = lb.upstream;
  }
  return upstream;
}

/** Atajos como los muestra IntelliJ, según la plataforma. */
function shortcutLabels(): { update: string; commit: string; push: string } {
  return process.platform === 'darwin'
    ? { update: '⌘T', commit: '⌘K', push: '⇧⌘K' }
    : { update: 'Ctrl+T', commit: 'Ctrl+K', push: 'Ctrl+Shift+K' };
}
