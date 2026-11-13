// Diálogo "Rollback Changes" (webview), como el de IntelliJ: árbol repo → carpetas → archivos con
// casillas (preseleccionadas las elegidas en Changes), contador, "Delete local copies of added
// files" y Close / Rollback. El rollback en sí lo hace ChangesActions.
import * as vscode from 'vscode';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo } from '../git/RepoManager';
import type { FileRef } from '../views/ChangesTree';
import type { RollbackState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';

export interface RollbackHandlers {
  run(refs: FileRef[], deleteAdded: boolean): Promise<boolean>;
  openDiff(ref: FileRef): Promise<void>;
}

export const rollbackKey = (ref: FileRef): string => `${ref.repo.root}\0${ref.file.path}`;

export class RollbackPanel implements vscode.Disposable {
  private static current: RollbackPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private busy = false;
  private repos: readonly Repo[] = [];
  private candidates: FileRef[] = [];
  private selected: string[] = [];

  /** Abre el diálogo (o lo reutiliza) con los archivos versionados y los preseleccionados. */
  static open(extensionUri: vscode.Uri, repos: readonly Repo[], candidates: FileRef[], selected: readonly FileRef[], handlers: RollbackHandlers): void {
    const panel = (RollbackPanel.current ??= new RollbackPanel(extensionUri, handlers));
    panel.candidates = candidates;
    panel.repos = repos;
    panel.selected = selected.map(rollbackKey);
    panel.busy = false;
    panel.panel.reveal();
    panel.post();
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly handlers: RollbackHandlers,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.rollback', 'Rollback Changes', vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'rollback', 'Rollback Changes');
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(): void {
    if (!this.ready) return;
    const state: RollbackState = {
      repos: this.repos
        .map((repo) => ({
          id: repo.root,
          name: repo.name,
          colorIndex: repo.colorIndex,
          files: this.candidates
            .filter((c) => c.repo === repo)
            .map(({ file }) => ({ path: file.path, status: file.status, ...(file.origPath ? { origPath: file.origPath } : {}) })),
        }))
        .filter((r) => r.files.length > 0),
      selected: this.selected,
      busy: this.busy,
    };
    void postToWebview(this.panel.webview, { type: 'rollback/state', payload: state });
  }

  private refOf(repoId: string, path: string): FileRef | undefined {
    return this.candidates.find((c) => c.repo.root === repoId && c.file.path === path);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'rollback' } });
          this.post();
          break;
        case 'rollback/openDiff': {
          const ref = this.refOf(message.payload.repoId, message.payload.path);
          if (ref) await this.handlers.openDiff(ref);
          break;
        }
        case 'rollback/run': {
          const keys = new Set(message.payload.keys);
          const refs = this.candidates.filter((c) => keys.has(rollbackKey(c)));
          if (!refs.length) return;
          this.busy = true;
          this.selected = [...keys];
          this.post();
          try {
            if (await this.handlers.run(refs, message.payload.deleteAdded)) this.panel.dispose();
          } finally {
            this.busy = false;
            this.post();
          }
          break;
        }
        case 'rollback/close':
          this.panel.dispose();
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (RollbackPanel.current === this) RollbackPanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
