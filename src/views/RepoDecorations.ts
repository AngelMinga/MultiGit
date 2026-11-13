// Badge a la derecha de cada repo en la vista "Repositorios" con la cantidad de cambios
// sin commit (como el indicador de IntelliJ). Usa un esquema propio para no mezclarse con
// las decoraciones de archivos del git integrado.
import * as vscode from 'vscode';
import type { RepoManager } from '../git/RepoManager';
import { t } from '../i18n';

const SCHEME = 'multigit-repo';

export function repoDecorationUri(root: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: vscode.Uri.file(root).path });
}

export class RepoDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeFileDecorations = this.changeEmitter.event;

  constructor(private readonly manager: RepoManager) {
    this.subscription = manager.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const repo = this.manager.allRepos.find((r) => vscode.Uri.file(r.root).path === uri.path);
    const changes = repo?.status?.changes;
    if (!changes || changes.total === 0) return undefined;

    const badge = changes.total > 99 ? '99+' : String(changes.total);
    const conflicted = changes.conflicted > 0;
    return {
      // FileDecoration admite badges de hasta 2 caracteres.
      badge: badge.length > 2 ? '●' : badge,
      tooltip: conflicted
        ? t('{0} conflicted file(s)', changes.conflicted)
        : t('{0} uncommitted change(s)', changes.total),
      color: new vscode.ThemeColor(
        conflicted ? 'gitDecoration.conflictingResourceForeground' : 'gitDecoration.modifiedResourceForeground',
      ),
      propagate: false,
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}
