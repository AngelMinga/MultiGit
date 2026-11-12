// Popup de ramas al estilo IntelliJ: Acciones / Repositorios / Common Local Branches /
// Common Remote Branches. Al elegir una rama se abre un segundo QuickPick con sus acciones.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import { commonLocalBranches, commonRemoteBranches, type RepoBranchesInput } from '../git/branches';
import { errorText } from '../git/MultiRepoRunner';
import { describeHead } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';
import { currentLabel, refName, type BranchActions, type BranchRef, type Scope } from './branchActions';

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
    qp.placeholder = 'Buscar rama o acción…';
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

  private buildItems(scope: Scope, data: RepoBranchesInput[], allRepos: boolean): PopupItem[] {
    const items: PopupItem[] = [];
    const sep = (label: string) => items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    const favorites = this.manager.favoriteBranches;
    const total = scope.repos.length;
    const a = this.actions;

    // Acciones
    sep('Acciones');
    items.push(
      { label: '$(sync) Update Project…', description: 'fetch + pull del upstream', action: () => a.updateProject(scope) },
      ...(allRepos ? [{ label: '$(git-commit) Commit…', description: 'archivos marcados en Changes', action: () => a.commit() }] : []),
      { label: '$(repo-pull) Pull…', description: 'elige remote, rama y modo', action: () => a.pull(scope) },
      { label: '$(repo-push) Push…', action: () => a.push(scope) },
      { label: '$(add) New Branch…', description: `desde '${currentLabel(scope)}'`, action: () => a.newBranch(scope) },
      { label: '$(tag) Checkout Tag or Revision…', action: () => a.checkoutRevision(scope) },
    );

    // Repositorios
    if (allRepos && scope.repos.length > 1) {
      sep('Repositorios');
      for (const repo of scope.repos) {
        const s = repo.status;
        items.push({
          label: `$(repo) ${repo.name}`,
          description: s ? `⎇ ${describeHead(s)}  ${formatAheadBehind(s)}` : '⚠ sin estado',
          repo,
        });
      }
    }

    // Ramas locales
    const singleLocal = !allRepos ? data[0]?.branches.local : undefined;
    const locals = commonLocalBranches(data, favorites);
    if (locals.length) sep(allRepos ? 'Common Local Branches' : 'Local Branches');
    for (const b of locals) {
      const lb = singleLocal?.find((x) => x.name === b.name);
      const isCurrent = b.currentIn.length === total;
      const desc = [
        isCurrent ? '$(check) actual' : b.currentIn.length ? `actual en ${b.currentIn.length}/${total}` : '',
        lb ? formatAheadBehind(lb) : '',
        lb?.upstream ? `→ ${lb.upstream}` : '',
      ].filter(Boolean);
      items.push({
        label: `${b.favorite ? '$(star-full)' : isCurrent ? '$(check)' : '$(git-branch)'} ${b.name}`,
        description: desc.join('  '),
        ref: { type: 'local', name: b.name },
      });
    }

    // Ramas remotas, agrupadas por remote
    for (const [remote, list] of commonRemoteBranches(data, favorites)) {
      sep(`${allRepos ? 'Common Remote Branches' : 'Remote Branches'} · ${remote}`);
      for (const b of list) {
        const name = b.name.slice(remote.length + 1);
        items.push({
          label: `${b.favorite ? '$(star-full)' : '$(cloud)'} ${b.name}`,
          ref: { type: 'remote', remote, name, full: b.name },
        });
      }
    }

    if (allRepos && locals.length === 0 && data.length > 1) {
      sep('Common Local Branches');
      items.push({ label: '$(info) No hay ramas locales comunes a todos los repos', description: 'elige un repositorio arriba' });
    }
    return items;
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
