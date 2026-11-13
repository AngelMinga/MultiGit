// Abre los archivos en conflicto de un repo en el merge editor de VS Code.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repo } from '../git/RepoManager';
import { t } from '../i18n';

/** Diálogo de conflictos (src/webview/ConflictsPanel.ts), registrado al activar la extensión. */
let opener: ((repo: Repo) => Promise<void>) | undefined;
export function setConflictsOpener(fn: (repo: Repo) => Promise<void>): void {
  opener = fn;
}

export async function resolveConflicts(repo: Repo, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  if (opener) return opener(repo);
  let file = files[0]!;
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: `$(warning) ${path.posix.basename(f)}`, description: path.posix.dirname(f), file: f })),
      { title: t('Conflicts in {0} ({1})', repo.name, files.length), placeHolder: t('Choose a file to open it in the merge editor') },
    );
    if (!picked) return;
    file = picked.file;
  }
  await openMergeEditor(vscode.Uri.file(path.join(repo.root, file)));
}

/** Ventana de merge propia (src/webview/MergePanel.ts): devuelve false si no puede abrir ese archivo. */
let mergeOpener: ((uri: vscode.Uri) => Promise<boolean>) | undefined;
export function setMergeOpener(fn: (uri: vscode.Uri) => Promise<boolean>): void {
  mergeOpener = fn;
}

/**
 * Abre un archivo en conflicto: en la ventana de merge de MultiGit (como IntelliJ) o, si se configura
 * `multigit.mergeTool: vscode` o el archivo no se puede (binario, borrado en un lado), en el de VS Code.
 */
export async function openMergeEditor(uri: vscode.Uri): Promise<void> {
  const tool = vscode.workspace.getConfiguration('multigit').get<string>('mergeTool', 'multigit');
  if (tool !== 'vscode' && mergeOpener && (await mergeOpener(uri).catch(() => false))) return;
  try {
    await vscode.commands.executeCommand('git.openMergeEditor', uri);
    // Como IntelliJ: las tres columnas seguidas, con el resultado en el centro (Incoming | Result | Current).
    const layout = vscode.workspace.getConfiguration('multigit').get<string>('mergeEditorLayout', 'columns');
    if (layout !== 'keep') await vscode.commands.executeCommand(layout === 'mixed' ? 'merge.mixedLayout' : 'merge.columnLayout').then(undefined, () => undefined);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
    await vscode.commands.executeCommand('workbench.view.scm');
  }
}
