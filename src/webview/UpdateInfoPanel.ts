// Ventana "Update Info" (como la pestaña de IntelliJ tras Update Project): por cada repo que recibió
// commits, la lista de commits y los archivos que cambiaron (de todo lo que llegó o de un commit).
import * as vscode from 'vscode';
import { GitContentProvider, openCommitFileDiff } from '../git/GitContentProvider';
import type { UpdatedRepo } from '../views/branchActions';
import { errorText } from '../git/MultiRepoRunner';
import type { UpdateInfoState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

const MAX_COMMITS = 500;

export class UpdateInfoPanel implements vscode.Disposable {
  private static current: UpdateInfoPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private state: UpdateInfoState = { repos: [], time: Date.now() };
  private updated: readonly UpdatedRepo[] = [];

  static async open(extensionUri: vscode.Uri, updated: readonly UpdatedRepo[]): Promise<void> {
    const panel = UpdateInfoPanel.current ?? new UpdateInfoPanel(extensionUri);
    UpdateInfoPanel.current = panel;
    panel.panel.reveal();
    await panel.load(updated);
  }

  private constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel('multigit.updateInfo', t('Update Info'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'updateInfo', t('Update Info'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private async load(updated: readonly UpdatedRepo[]): Promise<void> {
    this.updated = updated;
    const repos = await Promise.all(
      updated.map(async (u) => {
        const commits = await u.repo.git.logCommits([`${u.before}..${u.after}`], MAX_COMMITS + 1).catch(() => []);
        return {
          id: u.repo.root,
          name: u.repo.name,
          colorIndex: u.repo.colorIndex,
          branch: u.branch,
          commits: commits.slice(0, MAX_COMMITS),
          truncated: commits.length > MAX_COMMITS,
        };
      }),
    );
    this.state = { repos: repos.filter((r) => r.commits.length > 0), time: Date.now() };
    this.post();
  }

  private post(): void {
    if (this.ready) void postToWebview(this.panel.webview, { type: 'update/state', payload: this.state });
  }

  private find(repoId: string): UpdatedRepo | undefined {
    return this.updated.find((u) => u.repo.root === repoId);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'updateInfo' } });
          this.post();
          break;
        case 'update/select': {
          const u = this.find(message.payload.repoId);
          if (!u) return;
          const { hash } = message.payload;
          const [files, details] = hash
            ? await Promise.all([u.repo.git.commitFiles(hash), u.repo.git.commitInfo(hash).catch(() => undefined)])
            : [await u.repo.git.diffRefs(u.before, u.after), undefined];
          void postToWebview(this.panel.webview, { type: 'update/files', payload: { repoId: u.repo.root, hash, files, details } });
          break;
        }
        case 'update/openDiff': {
          const { repoId, hash, file } = message.payload;
          const u = this.find(repoId);
          if (!u) return;
          if (hash) {
            await openCommitFileDiff(repoId, hash, file);
            break;
          }
          // Todo lo que llegó: antes del update ↔ después.
          const left = GitContentProvider.uri(repoId, file.status === 'A' ? '' : u.before, file.oldPath ?? file.path);
          const right = GitContentProvider.uri(repoId, file.status === 'D' ? '' : u.after, file.path);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path.split('/').pop()} (${t('updated')})`, { preview: true });
          break;
        }
        case 'update/showInLog':
          await vscode.commands.executeCommand('multigit.log.navigate', message.payload.hash, [message.payload.repoId]);
          break;
        case 'update/close':
          this.panel.dispose();
          break;
        default:
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  dispose(): void {
    if (UpdateInfoPanel.current === this) UpdateInfoPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
