// Vista Proyecto (Explorer) y mostrar una vez las vistas nuevas que VS Code deja ocultas.
import * as vscode from 'vscode';
import { ToolbarView } from '../views/ToolbarView';
import type { Core } from './core';

export function registerToolbar(core: Core): void {
  const toolbar = new ToolbarView(core.context.extensionUri, core.manager);
  core.track(toolbar, vscode.window.registerWebviewViewProvider(ToolbarView.viewId, toolbar));
}

/**
 * VS Code recuerda qué vistas tenía visibles el contenedor MultiGit y deja ocultas las que se
 * agregan en versiones nuevas. Enfocar una vista la vuelve visible; se hace una sola vez por vista
 * y luego el usuario decide (puede ocultarlas o moverlas).
 */
export async function revealNewViewsOnce(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  // 'multigit.branchesViewRevealed' es la clave de la 0.0.6 (vista Ramas).
  const views = [
    { id: 'multigit.branches', key: 'multigit.branchesViewRevealed' },
    { id: 'multigit.changes', key: 'multigit.viewRevealed.changes' },
    { id: 'multigit.commit', key: 'multigit.viewRevealed.commit' },
    // 0.1.5: la vista Proyecto pasó al Explorer; se muestra una vez allí.
    { id: 'multigit.toolbar', key: 'multigit.viewRevealed.toolbarExplorer' },
  ].filter((v) => !context.globalState.get<boolean>(v.key));
  if (views.length === 0) return;
  for (const view of views) {
    try {
      await vscode.commands.executeCommand(`${view.id}.focus`);
      await context.globalState.update(view.key, true);
      log.info(`Vista ${view.id} mostrada.`);
    } catch (error) {
      log.error(`No se pudo mostrar la vista ${view.id}`, error);
    }
  }
  await vscode.commands.executeCommand('multigit.changes.focus').then(undefined, () => undefined);
}
