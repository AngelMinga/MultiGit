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

/** Merge editor de la extensión git integrada; si no está disponible, abre el archivo y Source Control. */
export async function openMergeEditor(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('git.openMergeEditor', uri);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
    await vscode.commands.executeCommand('workbench.view.scm');
  }
}
