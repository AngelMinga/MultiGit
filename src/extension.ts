// Punto de entrada: crea los servicios compartidos y registra cada área (src/activation/*).
import * as vscode from 'vscode';
import type { Core } from './activation/core';
import { registerBranches } from './activation/branches';
import { registerChanges } from './activation/changes';
import { registerFileActions } from './activation/files';
import { registerLog } from './activation/log';
import { registerOperations } from './activation/operations';
import { registerRepositories } from './activation/repositories';
import { registerStashes } from './activation/stashes';
import { registerCompare } from './activation/compare';
import type { CompareFilesTree } from './views/CompareFilesTree';
import { registerToolbar, revealNewViewsOnce } from './activation/toolbar';
import { RepoManager, type Repo } from './git/RepoManager';
import { BranchActions } from './views/branchActions';
import { BranchPopup } from './views/branchPopup';
import type { BranchesTree } from './views/BranchesTree';
import type { ChangesTree } from './views/ChangesTree';
import type { ChangesActions } from './views/changesActions';
import { installTranslations } from './views/claudeCommit';
import { CompareView } from './views/compareView';
import { startCredentials } from './views/credentials';
import { RepoIcons } from './views/repoIcons';
import type { RepositoriesView } from './views/RepositoriesView';
import type { StashesTree } from './views/StashesTree';
import { PushPanel } from './webview/PushPanel';
import { ConflictsPanel, setConflictsHost } from './webview/ConflictsPanel';
import { setConflictsOpener } from './views/conflicts';
import { t } from './i18n';

/** Lo que devuelve `activate`: solo para los tests de la extensión (no es una API pública). */
export interface MultiGitTestApi {
  manager: RepoManager;
  repositories: RepositoriesView;
  branches: BranchesTree;
  changes: ChangesTree;
  changesActions: ChangesActions;
  stashes: StashesTree;
  compareFiles: CompareFilesTree;
}

export async function activate(context: vscode.ExtensionContext): Promise<MultiGitTestApi> {
  const log = vscode.window.createOutputChannel('MultiGit', { log: true });
  context.subscriptions.push(log);
  installTranslations();
  // Askpass antes de cualquier fetch/pull/push (también el auto-fetch).
  context.subscriptions.push(await startCredentials(context, log));

  const manager = new RepoManager(log, context.workspaceState);
  const compareView = new CompareView();
  const openPush = (repos?: readonly Repo[], branch?: string) => PushPanel.open(context.extensionUri, manager, { repos, branch });
  const actions = new BranchActions(manager, compareView, (scope, branch) => openPush(scope.repos, branch));
  const repoIcons = new RepoIcons(context.globalStorageUri, context.extension.packageJSON);
  void repoIcons.init();
  const popup = new BranchPopup(manager, actions, repoIcons);
  const core: Core = {
    context,
    log,
    manager,
    actions,
    popup,
    openPush,
    track: (...disposables) => context.subscriptions.push(...disposables),
  };
  core.track(manager);

  const repositories = registerRepositories(core, compareView);
  const logView = registerLog(core);
  const branches = registerBranches(core, logView);
  const changes = registerChanges(core, logView);
  const stashes = registerStashes(core);
  const compareFiles = registerCompare(core);
  registerFileActions(core, logView, changes);
  registerOperations(core, repositories.treeView);
  registerToolbar(core);

  // Resolver conflictos (tras pull, merge, rebase, Smart Checkout…) abre el diálogo Conflicts.
  setConflictsHost(context.extensionUri, manager);
  setConflictsOpener((repo) => ConflictsPanel.open(repo));
  core.track(vscode.commands.registerCommand('multigit.resolveConflicts', () => ConflictsPanel.open()));

  // Opciones de los menús ⋯ con estado: cada una tiene una versión "✓ …" (que se muestra cuando está
  // activa) que ejecuta la misma. Así el estado se ve también en los menús nativos de macOS, que no
  // dibujan el ✓ de `toggled`.
  for (const { command } of context.extension.packageJSON.contributes.commands as Array<{ command: string }>) {
    if (command.endsWith('.on')) {
      core.track(vscode.commands.registerCommand(command, (...args: unknown[]) => vscode.commands.executeCommand(command.slice(0, -3), ...args)));
    }
  }

  log.info('MultiGit activado.');
  void revealNewViewsOnce(context, log);
  try {
    await manager.initialize();
  } catch (error) {
    log.error('Error al inicializar MultiGit', error);
    void vscode.window.showErrorMessage(t('MultiGit: the repositories could not be loaded. {0}', String(error)));
  }
  return { manager, repositories: repositories.view, branches: branches.tree, changes: changes.tree, changesActions: changes.actions, stashes: stashes.tree, compareFiles };
}

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
