// Contenido de un archivo en una revisión (`git show <ref>:<path>`), para abrir diffs nativos
// (`vscode.diff`) de commits que no son el working tree.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from './GitService';
import type { ChangedFile } from './parsers';
import type { RepoManager } from './RepoManager';

interface Query {
  root: string;
  /** Vacío = archivo inexistente en ese lado del diff (añadido/borrado). */
  ref: string;
  path: string;
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'multigit-git';

  constructor(private readonly manager: RepoManager) {}

  static uri(root: string, ref: string, filePath: string): vscode.Uri {
    const query: Query = { root, ref, path: filePath };
    return vscode.Uri.from({ scheme: GitContentProvider.scheme, path: `/${filePath}`, query: JSON.stringify(query) });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref, path: filePath } = JSON.parse(uri.query) as Query;
    if (!ref) return '';
    const git = this.manager.allRepos.find((r) => r.root === root)?.git ?? new GitService(root);
    try {
      return await git.showFile(ref, filePath);
    } catch {
      return '';
    }
  }
}

/** Abre el diff de un archivo de un commit contra su primer padre. */
export async function openCommitFileDiff(root: string, hash: string, file: ChangedFile): Promise<void> {
  const added = file.status === 'A';
  const deleted = file.status === 'D';
  const left = GitContentProvider.uri(root, added ? '' : `${hash}^`, file.oldPath ?? file.path);
  const right = GitContentProvider.uri(root, deleted ? '' : hash, file.path);
  const title = `${path.posix.basename(file.path)} (${hash.slice(0, 7)}^ ↔ ${hash.slice(0, 7)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}
