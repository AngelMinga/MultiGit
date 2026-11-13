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
import { setConflictsOpener, setMergeOpener } from './views/conflicts';
import { MergePanel } from './webview/MergePanel';
import * as path from 'node:path';
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

  // Cada área se activa por separado: si una falla (p. ej. "No view is registered" tras actualizar sin
  // recargar la ventana), las demás siguen funcionando y se avisa una vez.
  const failed: string[] = [];
  const area = <T>(name: string, register: () => T): T | undefined => {
    try {
      return register();
    } catch (error) {
      failed.push(name);
      log.error(`No se pudo activar ${name}`, error);
      return undefined;
    }
  };
  const repositories = area(t('Repositories'), () => registerRepositories(core, compareView));
  const logView = area('Git Log', () => registerLog(core));
  const branches = logView && area(t('Branches'), () => registerBranches(core, logView));
  const changes = logView && area('Changes', () => registerChanges(core, logView));
  const stashes = area('Stashes', () => registerStashes(core));
  const compareFiles = area(t('Compare'), () => registerCompare(core));
  if (logView && changes) area(t('File actions'), () => registerFileActions(core, logView, changes));
  if (repositories) area(t('Operations'), () => registerOperations(core, repositories.treeView));
  area(t('Project'), () => registerToolbar(core));
  if (failed.length) {
    const RELOAD = t('Reload Window');
    void vscode.window
      .showWarningMessage(t('MultiGit: some parts could not be loaded ({0}). Reload the window; details in the MultiGit output.', failed.join(', ')), RELOAD)
      .then((choice) => choice === RELOAD && vscode.commands.executeCommand('workbench.action.reloadWindow'));
  }

  // Resolver conflictos (tras pull, merge, rebase, Smart Checkout…) abre el diálogo Conflicts.
  setConflictsHost(context.extensionUri, manager);
  setConflictsOpener((repo) => ConflictsPanel.open(repo));
  setMergeOpener(async (uri) => {
    // El repo más profundo que contiene el archivo.
    const repo = [...manager.allRepos]
      .filter((r) => !path.relative(r.root, uri.fsPath).startsWith('..') && !path.isAbsolute(path.relative(r.root, uri.fsPath)))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!repo) return false;
    return MergePanel.open(context.extensionUri, manager, repo, path.relative(repo.root, uri.fsPath).split(path.sep).join('/'));
  });
  core.track(vscode.commands.registerCommand('multigit.resolveConflicts', () => ConflictsPanel.open()));

  // Botones del merge editor como la ventana de IntelliJ (↑↓ conflictos, Accept Left/Right, varita,
  // Apply Changes): cada uno ejecuta la acción equivalente del merge editor de VS Code.
  for (const [id, builtin] of [
    ['prevConflict', 'merge.goToPreviousUnhandledConflict'],
    ['nextConflict', 'merge.goToNextUnhandledConflict'],
    ['acceptLeft', 'merge.acceptAllInput1'],
    ['acceptRight', 'merge.acceptAllInput2'],
    ['resolveSimple', 'mergeEditor.acceptAllCombination'],
    ['reset', 'mergeEditor.resetResultToBaseAndAutoMerge'],
    ['complete', 'mergeEditor.acceptMerge'],
  ] as const) {
    core.track(vscode.commands.registerCommand(`multigit.merge.${id}`, () => vscode.commands.executeCommand(builtin)));
  }

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
  return {
    manager,
    repositories: repositories?.view as RepositoriesView,
    branches: branches?.tree as BranchesTree,
    changes: changes?.tree as ChangesTree,
    changesActions: changes?.actions as ChangesActions,
    stashes: stashes?.tree as StashesTree,
    compareFiles: compareFiles as CompareFilesTree,
  };
}

export function deactivate(): void {
  // Todo se libera vía context.subscriptions.
}
