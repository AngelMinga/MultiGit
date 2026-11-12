import * as vscode from 'vscode';
import { RepoManager } from './git/RepoManager';
import { RepositoriesView } from './views/RepositoriesView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('MultiGit', { log: true });
  const manager = new RepoManager(log);
  const repositoriesView = new RepositoriesView(manager);

  context.subscriptions.push(
    log,
    manager,
    repositoriesView,
    vscode.window.createTreeView('multigit.repositories', {
      treeDataProvider: repositoriesView,
      showCollapseAll: false,
    }),
    vscode.commands.registerCommand('multigit.refresh', () =>
      vscode.window.withProgress(
        { location: { viewId: 'multigit.repositories' }, title: 'Refrescando repositorios…' },
        () => manager.refresh(),
      ),
    ),
    vscode.commands.registerCommand('multigit.showLog', () => log.show(true)),
  );

  log.info('MultiGit activado.');
  try {
    await manager.initialize();
  } catch (error) {
    log.error('Error al inicializar MultiGit', error);
    void vscode.window.showErrorMessage(`MultiGit: no se pudieron cargar los repositorios. ${String(error)}`);
  }
}

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
