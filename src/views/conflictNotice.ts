// Aviso de IntelliJ al abrir un archivo con conflictos sin resolver: arriba del archivo,
// "File has unresolved merge conflicts · Resolve Conflicts…", y un botón en la barra del editor.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoManager } from '../git/RepoManager';
import { openMergeEditor } from './conflicts';
import { t } from '../i18n';

const CONTEXT_KEY = 'multigit.activeFileConflicted';

export class ConflictNotice implements vscode.CodeLensProvider, vscode.Disposable {
  /** Rutas absolutas de los archivos en conflicto de todos los repos. */
  private files = new Set<string>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private updating: Promise<void> | undefined;

  constructor(private readonly manager: RepoManager) {
    this.disposables.push(
      this.lensEmitter,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      manager.onDidChange(() => void this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.commands.registerCommand('multigit.resolveFileConflicts', (uri?: vscode.Uri) => {
        const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
        return target ? openMergeEditor(target) : undefined;
      }),
    );
    void this.update();
  }

  /** ¿Tiene conflictos sin resolver? */
  isConflicted(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.files.has(path.normalize(uri.fsPath));
  }

  /** Relee los archivos en conflicto (solo de los repos que tienen alguno). */
  update(): Promise<void> {
    this.updating ??= (async () => {
      try {
        const next = new Set<string>();
        await Promise.all(
          this.manager.all
            .filter((r) => (r.status?.changes.conflicted ?? 0) > 0)
            .map(async (r) => {
              for (const f of await r.git.getConflictedFiles().catch(() => [])) next.add(path.normalize(path.join(r.root, f)));
            }),
        );
        const changed = next.size !== this.files.size || [...next].some((f) => !this.files.has(f));
        this.files = next;
        if (changed) {
          this.lensEmitter.fire();
          this.updateContext();
        }
      } finally {
        this.updating = undefined;
      }
    })();
    return this.updating;
  }

  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!uri && this.isConflicted(uri));
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isConflicted(document.uri)) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, { title: `$(warning) ${t('File has unresolved merge conflicts')}`, command: 'multigit.resolveFileConflicts', arguments: [document.uri] }),
      new vscode.CodeLens(top, { title: t('Resolve Conflicts…'), command: 'multigit.resolveFileConflicts', arguments: [document.uri] }),
      new vscode.CodeLens(top, { title: t('Open Conflicts Window'), command: 'multigit.resolveConflicts' }),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
