// Manage Remotes (webview), como el de IntelliJ: los remotes de cada repo con su URL y botones para
// añadir, editar y quitar. Además, añadir un remote a todos los repos con una plantilla de URL ({repo}).
import * as vscode from 'vscode';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import { fromTemplate, isValidRemoteName, urlTemplate } from '../git/remotes';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { RemotesState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

export class RemotesPanel implements vscode.Disposable {
  private static current: RemotesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private state: RemotesState = { repos: [], busy: true };

  static async open(extensionUri: vscode.Uri, manager: RepoManager): Promise<void> {
    const panel = (RemotesPanel.current ??= new RemotesPanel(extensionUri, manager));
    panel.panel.reveal();
    await panel.reload();
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.remotes', t('Git Remotes'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'remotes', t('Git Remotes'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private async reload(): Promise<void> {
    const repos = await Promise.all(
      this.manager.all.map(async (repo) => ({
        id: repo.root,
        name: repo.name,
        colorIndex: repo.colorIndex,
        remotes: await repo.git.listRemotes().catch(() => []),
      })),
    );
    this.state = { repos, busy: false };
    this.post();
  }

  private post(): void {
    if (this.ready) void postToWebview(this.panel.webview, { type: 'remotes/state', payload: this.state });
  }

  private repoById(id: string): Repo | undefined {
    return this.manager.all.find((r) => r.root === id);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'remotes' } });
          this.post();
          break;
        case 'remotes/add':
          await this.add(message.payload.repoId);
          break;
        case 'remotes/addAll':
          await this.addAll();
          break;
        case 'remotes/edit':
          await this.edit(message.payload.repoId, message.payload.name);
          break;
        case 'remotes/remove':
          await this.remove(message.payload.repoId, message.payload.name);
          break;
        case 'remotes/close':
          this.panel.dispose();
          return;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
    await this.reload();
  }

  private askName(title: string, taken: readonly string[], value = ''): Thenable<string | undefined> {
    return vscode.window.showInputBox({
      title,
      prompt: t('Remote name'),
      value,
      ignoreFocusOut: true,
      validateInput: (v) =>
        !isValidRemoteName(v.trim()) ? t('Invalid remote name') : taken.includes(v.trim()) && v.trim() !== value ? t("Remote '{0}' already exists", v.trim()) : undefined,
    });
  }

  private askUrl(title: string, value = '', prompt = t('Remote URL')): Thenable<string | undefined> {
    return vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : t('Type a URL')) });
  }

  /** + : añadir un remote a un repo (el elegido, o se pregunta cuál). */
  private async add(repoId?: string): Promise<void> {
    let repo = repoId ? this.repoById(repoId) : undefined;
    if (!repo) {
      const picked = await vscode.window.showQuickPick(
        this.manager.all.map((r) => ({ label: `$(repo) ${r.name}`, repo: r })),
        { title: t('Add Remote'), placeHolder: t('Repository') },
      );
      repo = picked?.repo;
    }
    if (!repo) return;
    const remotes = await repo.git.listRemotes();
    const title = t('Add Remote — {0}', repo.name);
    const name = (await this.askName(title, remotes.map((r) => r.name), remotes.length ? '' : 'origin'))?.trim();
    if (!name) return;
    const url = (await this.askUrl(title))?.trim();
    if (!url) return;
    await repo.git.addRemote(name, url);
  }

  /** Añadir un remote a todos los repos con una plantilla de URL (`{repo}` = nombre de cada repo). */
  private async addAll(): Promise<void> {
    const repos = this.manager.all;
    const title = t('Add Remote to All Repositories');
    const name = (await this.askName(title, []))?.trim();
    if (!name) return;
    // Sugerencia: la URL de origin de un repo con su nombre cambiado por {repo}.
    let suggestion = '';
    for (const r of this.state.repos) {
      const origin = r.remotes.find((x) => x.name === 'origin') ?? r.remotes[0];
      const tpl = origin && urlTemplate(origin.url, r.name);
      if (tpl) {
        suggestion = tpl;
        break;
      }
    }
    const template = (await this.askUrl(title, suggestion, t('URL template: {repo} is replaced by each repository name')))?.trim();
    if (!template) return;
    await runInRepos(this.manager, {
      title: t("Add remote '{0}'", name),
      repos,
      check: async (repo) => ((await repo.git.listRemotes()).some((r) => r.name === name) ? { skip: t("remote '{0}' already exists", name) } : undefined),
      run: async (repo) => {
        const url = fromTemplate(template, repo.name);
        await repo.git.addRemote(name, url);
        return url;
      },
    });
  }

  /** ✎ : cambiar nombre y URL. */
  private async edit(repoId: string, name: string): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) return;
    const remotes = await repo.git.listRemotes();
    const remote = remotes.find((r) => r.name === name);
    if (!remote) return;
    const title = t("Edit Remote '{0}' — {1}", name, repo.name);
    const newName = (await this.askName(title, remotes.map((r) => r.name), name))?.trim();
    if (!newName) return;
    const url = (await this.askUrl(title, remote.url))?.trim();
    if (!url) return;
    if (newName !== name) await repo.git.renameRemote(name, newName);
    if (url !== remote.url) await repo.git.setRemoteUrl(newName, url);
  }

  /** − : quitar un remote (con confirmación). */
  private async remove(repoId: string, name: string): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) return;
    const REMOVE = t('Remove');
    const ok = await vscode.window.showWarningMessage(
      t("Remove remote '{0}' from {1}?", name, repo.name),
      { modal: true, detail: t('Its remote-tracking branches ({0}/…) are removed too. The server is not touched.', name) },
      REMOVE,
    );
    if (ok === REMOVE) await repo.git.removeRemote(name);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (RemotesPanel.current === this) RemotesPanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
