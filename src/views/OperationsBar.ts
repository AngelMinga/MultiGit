// Operaciones a medias (merge / rebase / cherry-pick / revert), como el banner de IntelliJ:
// aviso en la barra de estado y acciones Resolve Conflicts / Continue / Skip / Abort, por repo o en todos.
import * as vscode from 'vscode';
import { errorText } from '../git/MultiRepoRunner';
import { canSkip, OPERATION_LABEL, type Operation } from '../git/operations';
import type { Repo, RepoManager } from '../git/RepoManager';
import { resolveConflicts } from './conflicts';
import { t } from '../i18n';

export class OperationsBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Botones al lado, como IntelliJ: » resolver/continuar y ■ abortar. */
  private readonly primaryItem: vscode.StatusBarItem;
  private readonly abortItem: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    this.item = vscode.window.createStatusBarItem('multigit.operation', vscode.StatusBarAlignment.Left, 999);
    this.item.name = t('MultiGit: operation in progress');
    this.item.command = 'multigit.operation.menu';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.primaryItem = vscode.window.createStatusBarItem('multigit.operation.primary', vscode.StatusBarAlignment.Left, 998.9);
    this.primaryItem.name = t('MultiGit: resolve conflicts or continue');
    this.primaryItem.command = 'multigit.operation.primary';
    this.primaryItem.text = '$(debug-continue)';
    this.primaryItem.color = new vscode.ThemeColor('testing.iconPassed');
    this.abortItem = vscode.window.createStatusBarItem('multigit.operation.abortAll', vscode.StatusBarAlignment.Left, 998.8);
    this.abortItem.name = t('MultiGit: abort the operation');
    this.abortItem.command = 'multigit.operation.abortAll';
    this.abortItem.text = '$(debug-stop)';
    this.abortItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.subscription = manager.onDidChange(() => this.update());
    this.update();
  }

  /** Repos con una operación a medias. */
  get inProgress(): Array<Repo & { operation: Operation }> {
    return this.manager.all.filter((r): r is Repo & { operation: Operation } => !!r.operation);
  }

  private update(): void {
    const repos = this.inProgress;
    void vscode.commands.executeCommand('setContext', 'multigit.operationInProgress', repos.length > 0);
    if (!repos.length) {
      this.item.hide();
      this.primaryItem.hide();
      this.abortItem.hide();
      return;
    }
    const conflicts = repos.reduce((n, r) => n + (r.status?.changes.conflicted ?? 0), 0);
    const first = repos[0]!;
    this.item.text =
      repos.length === 1
        ? t('$(warning) {0} in progress: {1}{2}', OPERATION_LABEL[first.operation], first.name, conflictsText(conflicts))
        : t('$(warning) {0} repos with operations in progress{1}', repos.length, conflictsText(conflicts));
    const lines = repos.map((r) => `${r.name}: ${OPERATION_LABEL[r.operation]}`).join('\n');
    this.item.tooltip = t('{0}\nClick: resolve, continue or abort', lines);
    this.item.show();
    const op = repos.length === 1 ? OPERATION_LABEL[first.operation] : t('operations');
    this.primaryItem.tooltip = conflicts ? t('Resolve Conflicts…') : t('Continue {0}', op);
    this.abortItem.tooltip = t('Abort {0}', op);
    this.primaryItem.show();
    this.abortItem.show();
  }

  /** Botón »: con conflictos abre la ventana Conflicts; sin conflictos continúa la operación en todos. */
  async primary(): Promise<void> {
    const repos = this.inProgress;
    if (!repos.length) return;
    if (repos.some((r) => (r.status?.changes.conflicted ?? 0) > 0)) {
      await vscode.commands.executeCommand('multigit.resolveConflicts');
      return;
    }
    await this.forAll('continue');
  }

  /** Botón ■: aborta la operación (pide confirmación). */
  async abortAll(): Promise<void> {
    const repos = this.inProgress;
    if (repos.length === 1) await this.abort(repos[0]!);
    else if (repos.length > 1) await this.forAll('abort');
  }

  /** Menú con las acciones de cada repo y para todos. */
  async showMenu(): Promise<void> {
    const repos = this.inProgress;
    if (!repos.length) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no operations in progress.'));
      return;
    }
    type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
    const items: Item[] = [];
    for (const repo of repos) {
      const op = repo.operation;
      const conflicts = repo.status?.changes.conflicted ?? 0;
      items.push({ label: `${repo.name} — ${OPERATION_LABEL[op]}${conflictsText(conflicts)}`, kind: vscode.QuickPickItemKind.Separator });
      if (conflicts) items.push({ label: '$(git-merge) Resolve Conflicts…', run: () => this.resolve(repo) });
      items.push({ label: '$(debug-continue) Continue', description: t('marks the resolved files and continues'), run: () => this.continue(repo) });
      if (canSkip(op)) items.push({ label: '$(debug-step-over) Skip', description: t('skips the current commit'), run: () => this.skip(repo) });
      items.push({ label: '$(debug-stop) Abort', description: t('goes back to how it was before the {0}', op), run: () => this.abort(repo) });
    }
    if (repos.length > 1) {
      items.push({ label: t('All'), kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: t('$(debug-continue) Continue in All'), run: () => this.forAll('continue') });
      items.push({ label: t('$(debug-stop) Abort in All'), run: () => this.forAll('abort') });
    }
    const picked = await vscode.window.showQuickPick(items, { title: t('MultiGit: operations in progress') });
    await picked?.run?.();
  }

  async resolve(repo: Repo): Promise<void> {
    const files = await repo.git.getConflictedFiles();
    if (!files.length) {
      void vscode.window.showInformationMessage(t('MultiGit: {0} has no pending conflicts. Use Continue.', repo.name));
      return;
    }
    await resolveConflicts(repo, files);
  }

  /** Continue: si los conflictos ya no tienen marcas, los marca como resueltos (git add) y continúa. */
  async continue(repo: Repo, quiet = false): Promise<boolean> {
    const op = repo.operation;
    if (!op) return true;
    try {
      const conflicted = await repo.git.getConflictedFiles();
      const unresolved = await repo.git.filesWithConflictMarkers(conflicted);
      if (unresolved.length) {
        const RESOLVE = t('Resolve Conflicts');
        const choice = await vscode.window.showWarningMessage(
          t('MultiGit: {0} still has {1} file(s) with conflicts', repo.name, unresolved.length),
          { modal: true, detail: unresolved.map((f) => `  • ${f}`).join('\n') },
          RESOLVE,
        );
        if (choice === RESOLVE) await resolveConflicts(repo, unresolved);
        return false;
      }
      await repo.git.addPaths(conflicted);
      await repo.git.continueOperation(op);
      if (!quiet) vscode.window.setStatusBarMessage(`$(check) ${repo.name}: ${op} continuado`, 4000);
      return true;
    } catch (error) {
      await this.afterFailure(repo, error);
      return false;
    } finally {
      await this.manager.refreshStatusesNow([repo]);
    }
  }

  async skip(repo: Repo): Promise<void> {
    const op = repo.operation;
    if (!op || !canSkip(op)) return;
    const ok = await vscode.window.showWarningMessage(
      t('Skip the current commit of the {0} in {1}?', op, repo.name),
      { modal: true, detail: t('That commit will not be applied and the changes you made while resolving it will be lost.') },
      'Skip',
    );
    if (ok !== 'Skip') return;
    try {
      await repo.git.skipOperation(op);
    } catch (error) {
      await this.afterFailure(repo, error);
    } finally {
      await this.manager.refreshStatusesNow([repo]);
    }
  }

  async abort(repo: Repo, confirmed = false): Promise<boolean> {
    const op = repo.operation;
    if (!op) return true;
    if (!confirmed) {
      const ok = await vscode.window.showWarningMessage(
        t('Abort the {0} in {1}?', op, repo.name),
        { modal: true, detail: t('The repository goes back to how it was before the {0}. What you resolved so far is lost.', op) },
        'Abort',
      );
      if (ok !== 'Abort') return false;
    }
    try {
      await repo.git.abortOperation(op);
      vscode.window.setStatusBarMessage(`$(debug-stop) ${repo.name}: ${op} abortado`, 4000);
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${repo.name}: ${errorText(error)}`);
      return false;
    } finally {
      await this.manager.refreshStatusesNow([repo]);
    }
  }

  private async forAll(action: 'continue' | 'abort'): Promise<void> {
    const repos = this.inProgress;
    if (action === 'abort') {
      const ok = await vscode.window.showWarningMessage(
        t('Abort the operations in progress in {0} repos?', repos.length),
        { modal: true, detail: repos.map((r) => `  • ${r.name}: ${r.operation}`).join('\n') },
        t('Abort in All'),
      );
      if (!ok) return;
    }
    for (const repo of repos) {
      const ok = action === 'continue' ? await this.continue(repo, true) : await this.abort(repo, true);
      if (!ok) return; // se detiene en el primero que no pudo
    }
  }

  /** Error al continuar: si aparecieron conflictos nuevos (rebase del siguiente commit), ofrecer resolverlos. */
  private async afterFailure(repo: Repo, error: unknown): Promise<void> {
    const conflicts = await repo.git.getConflictedFiles().catch(() => []);
    if (conflicts.length) {
      const RESOLVE = t('Resolve Conflicts');
      const choice = await vscode.window.showWarningMessage(
        t('MultiGit: {0} has {1} new conflict(s)', repo.name, conflicts.length),
        RESOLVE,
      );
      if (choice) await resolveConflicts(repo, conflicts);
      return;
    }
    void vscode.window.showErrorMessage(`MultiGit: ${repo.name}: ${errorText(error)}`);
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
    this.primaryItem.dispose();
    this.abortItem.dispose();
  }
}

/** " · 2 conflicto(s)" o vacío. */
function conflictsText(conflicts: number): string {
  return conflicts ? t(' · {0} conflict(s)', conflicts) : '';
}
