// Operaciones a medias (merge / rebase / cherry-pick / revert), como el banner de IntelliJ:
// aviso en la barra de estado y acciones Resolve Conflicts / Continue / Skip / Abort, por repo o en todos.
import * as vscode from 'vscode';
import { errorText } from '../git/MultiRepoRunner';
import { canSkip, OPERATION_LABEL, type Operation } from '../git/operations';
import type { Repo, RepoManager } from '../git/RepoManager';
import { resolveConflicts } from './conflicts';

export class OperationsBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    this.item = vscode.window.createStatusBarItem('multigit.operation', vscode.StatusBarAlignment.Left, 999);
    this.item.name = 'MultiGit: operación en curso';
    this.item.command = 'multigit.operation.menu';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
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
      return;
    }
    const conflicts = repos.reduce((n, r) => n + (r.status?.changes.conflicted ?? 0), 0);
    const first = repos[0]!;
    this.item.text =
      repos.length === 1
        ? `$(warning) ${OPERATION_LABEL[first.operation]} en curso: ${first.name}${conflicts ? ` · ${conflicts} conflicto(s)` : ''}`
        : `$(warning) ${repos.length} repos con operaciones en curso${conflicts ? ` · ${conflicts} conflicto(s)` : ''}`;
    this.item.tooltip = `${repos.map((r) => `${r.name}: ${OPERATION_LABEL[r.operation]}`).join('\n')}\nClic: resolver, continuar o abortar`;
    this.item.show();
  }

  /** Menú con las acciones de cada repo y para todos. */
  async showMenu(): Promise<void> {
    const repos = this.inProgress;
    if (!repos.length) {
      void vscode.window.showInformationMessage('MultiGit: no hay operaciones en curso.');
      return;
    }
    type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
    const items: Item[] = [];
    for (const repo of repos) {
      const op = repo.operation;
      const conflicts = repo.status?.changes.conflicted ?? 0;
      items.push({ label: `${repo.name} — ${OPERATION_LABEL[op]}${conflicts ? ` · ${conflicts} conflicto(s)` : ''}`, kind: vscode.QuickPickItemKind.Separator });
      if (conflicts) items.push({ label: '$(git-merge) Resolve Conflicts…', run: () => this.resolve(repo) });
      items.push({ label: '$(debug-continue) Continue', description: 'marca los resueltos y continúa', run: () => this.continue(repo) });
      if (canSkip(op)) items.push({ label: '$(debug-step-over) Skip', description: 'salta el commit actual', run: () => this.skip(repo) });
      items.push({ label: '$(debug-stop) Abort', description: `vuelve a como estaba antes del ${op}`, run: () => this.abort(repo) });
    }
    if (repos.length > 1) {
      items.push({ label: 'Todos', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(debug-continue) Continue en todos', run: () => this.forAll('continue') });
      items.push({ label: '$(debug-stop) Abort en todos', run: () => this.forAll('abort') });
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'MultiGit: operaciones en curso' });
    await picked?.run?.();
  }

  async resolve(repo: Repo): Promise<void> {
    const files = await repo.git.getConflictedFiles();
    if (!files.length) {
      void vscode.window.showInformationMessage(`MultiGit: ${repo.name} no tiene conflictos pendientes. Usa Continue.`);
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
        const RESOLVE = 'Resolver conflictos';
        const choice = await vscode.window.showWarningMessage(
          `MultiGit: ${repo.name} todavía tiene ${unresolved.length} archivo(s) con conflictos`,
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
      `¿Saltar el commit actual del ${op} en ${repo.name}?`,
      { modal: true, detail: 'Ese commit no se aplicará y se perderán los cambios que hayas hecho al resolverlo.' },
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
        `¿Abortar el ${op} en ${repo.name}?`,
        { modal: true, detail: `El repo vuelve a como estaba antes del ${op}. Se pierde lo que hayas resuelto hasta ahora.` },
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
        `¿Abortar las operaciones en curso de ${repos.length} repos?`,
        { modal: true, detail: repos.map((r) => `  • ${r.name}: ${r.operation}`).join('\n') },
        'Abort en todos',
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
      const RESOLVE = 'Resolver conflictos';
      const choice = await vscode.window.showWarningMessage(
        `MultiGit: ${repo.name} tiene ${conflicts.length} conflicto(s) nuevos`,
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
  }
}
