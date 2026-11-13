// Ventana de merge propia (webview), como "Merge Revisions" de IntelliJ: Tuyos | Resultado | Otros, con
// » « ✕ en cada bloque, aplicar cambios sin conflicto, Aceptar izquierda / derecha, Guardar y cerrar y
// Aplicar cambios. Los bloques los calcula src/git/merge3.ts con los cambios que da `git diff`.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseHunks } from '../git/hunks';
import { merge3 } from '../git/merge3';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { MergeState, WebviewMessage } from './protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

export class MergePanel implements vscode.Disposable {
  private static readonly open_ = new Map<string, MergePanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private state!: MergeState;
  /** Fin de línea del archivo en disco (para escribir el resultado igual). */
  private eol = '\n';

  /**
   * Abre la ventana para un archivo en conflicto. Devuelve false si no se puede (un lado lo borró, es
   * binario o ya no está en conflicto): entonces se usa el merge editor de VS Code.
   */
  static async open(extensionUri: vscode.Uri, manager: RepoManager, repo: Repo, filePath: string): Promise<boolean> {
    const versions = await repo.git.conflictVersions(filePath).catch(() => undefined);
    if (!versions) return false;
    const oursHunks = parseHunks(versions.oursDiff);
    const theirsHunks = parseHunks(versions.theirsDiff);
    if (!oursHunks || !theirsHunks) return false;
    const key = `${repo.root}\0${filePath}`;
    const panel = MergePanel.open_.get(key) ?? new MergePanel(extensionUri, manager, repo, filePath, key);
    const labels = await repo.git.conflictLabels();
    const disk = await fs.readFile(path.join(repo.root, filePath), 'utf8').catch(() => '');
    panel.eol = disk.includes('\r\n') ? '\r\n' : '\n';
    panel.state = {
      repo: repo.name,
      colorIndex: repo.colorIndex,
      path: filePath,
      yours: labels.operation === 'stash' ? t('Updated upstream') : labels.current,
      theirs: labels.operation === 'stash' ? t('Stashed changes') : labels.incoming,
      blocks: merge3(versions.base, oursHunks, theirsHunks),
      busy: false,
    };
    panel.panel.reveal();
    panel.post();
    return true;
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly repo: Repo,
    private readonly filePath: string,
    private readonly key: string,
  ) {
    MergePanel.open_.set(key, this);
    const title = t('Merge: {0}', path.posix.basename(filePath));
    this.panel = vscode.window.createWebviewPanel('multigit.merge', title, vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'merge', title);
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(): void {
    if (this.ready && this.state) void postToWebview(this.panel.webview, { type: 'merge/state', payload: this.state });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'merge' } });
          this.post();
          break;
        case 'merge/save': {
          const { content, resolve } = message.payload;
          const text = this.eol === '\r\n' ? content.replace(/\r?\n/g, '\r\n') : content;
          await fs.writeFile(path.join(this.repo.root, this.filePath), text);
          if (resolve) await this.repo.git.addPaths([this.filePath]);
          await this.manager.refreshStatusesNow([this.repo]);
          this.panel.dispose();
          break;
        }
        case 'merge/acceptSide':
          await this.repo.git.acceptConflictSide([this.filePath], message.payload.side);
          await this.manager.refreshStatusesNow([this.repo]);
          this.panel.dispose();
          break;
        case 'merge/close':
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
    MergePanel.open_.delete(this.key);
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
