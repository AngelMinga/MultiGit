// Diálogo "Conflicts" (webview), como el de IntelliJ: archivos en conflicto de todos los repos con sus
// columnas Yours / Theirs, Accept de un lado (por archivo o varios a la vez), Resolve Manually (merge
// editor de VS Code) y Finish (continúa el merge/rebase/cherry-pick/revert cuando ya no queda ninguno).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { countConflictBlocks, sidesOf } from '../git/conflicts';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import { openMergeEditor } from '../views/conflicts';
import type { ConflictRepoView, ConflictsState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

let host: { extensionUri: vscode.Uri; manager: RepoManager } | undefined;

/** Se llama al activar: a partir de ahí "Resolver conflictos" abre este diálogo. */
export function setConflictsHost(extensionUri: vscode.Uri, manager: RepoManager): void {
  host = { extensionUri, manager };
}


export class ConflictsPanel implements vscode.Disposable {
  private static current: ConflictsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private busy = false;
  private state: ConflictsState = { repos: [], busy: false };
  private loading: Promise<void> | undefined;
  /** Archivos vistos en conflicto (repo → ruta → bloques que tenía), para listarlos como resueltos. */
  private readonly seen = new Map<string, Map<string, number>>();

  /** Abre el diálogo con los conflictos de todos los repos (el repo indicado, primero). */
  static async open(first?: Repo): Promise<void> {
    if (!host) return;
    const panel = (ConflictsPanel.current ??= new ConflictsPanel(host.extensionUri, host.manager));
    panel.first = first?.root;
    await panel.reload();
    panel.panel.reveal();
  }

  private first: string | undefined;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.conflicts', t('Conflicts'), vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'conflicts', t('Conflicts'));
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
      // Resolver en el merge editor (Complete Merge) o desde Changes cambia el estado: se recarga.
      manager.onDidChange(() => void this.reload()),
    );
  }

  /** Relee los conflictos de todos los repos. */
  private reload(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const repos = await Promise.all(this.manager.all.map((repo) => this.readRepo(repo)));
        const withConflicts = repos.filter((r): r is ConflictRepoView => !!r && (r.files.length > 0 || r.operation !== null));
        withConflicts.sort((a, b) => Number(b.id === this.first) - Number(a.id === this.first));
        this.state = { repos: withConflicts, busy: this.busy };
        this.post();
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  private async readRepo(repo: Repo): Promise<ConflictRepoView | undefined> {
    const changes = await repo.git.getChanges().catch(() => []);
    const conflicted = changes.filter((f) => f.kind === 'conflict');
    const op = await repo.git.getOperationInProgress().catch(() => null);
    if (!conflicted.length && !op) {
      this.seen.delete(repo.root);
      return undefined;
    }
    const labels = await repo.git.conflictLabels();
    const files = await Promise.all(
      conflicted.map(async (f) => {
        const text = await fs.readFile(path.join(repo.root, f.path), 'utf8').catch(() => '');
        return { path: f.path, ...sidesOf(f.index, f.worktree), blocks: countConflictBlocks(text) };
      }),
    );
    const title =
      labels.operation === 'merge'
        ? t('Merging branch {0} into branch {1}', labels.incoming, labels.current)
        : labels.operation === 'rebase'
          ? t('Rebasing {0} onto {1}', labels.incoming, labels.current)
          : labels.operation === 'cherry-pick'
            ? t('Cherry-picking {0} onto {1}', labels.incoming, labels.current)
            : labels.operation === 'revert'
              ? t('Reverting {0} on {1}', labels.incoming, labels.current)
              : t('Applying stashed changes on {0}', labels.current);
    // Los que estaban en conflicto y ya no: "Resolved" (con cuántos bloques tenían).
    const seen = this.seen.get(repo.root) ?? new Map<string, number>();
    for (const f of files) seen.set(f.path, Math.max(seen.get(f.path) ?? 0, f.blocks));
    this.seen.set(repo.root, seen);
    const open = new Set(files.map((f) => f.path));
    const resolved = [...seen].filter(([p]) => !open.has(p)).map(([p, blocks]) => ({ path: p, blocks }));
    return {
      id: repo.root,
      name: repo.name,
      colorIndex: repo.colorIndex,
      resolved: resolved.sort((a, b) => a.path.localeCompare(b.path)),
      title,
      yours: labels.operation === 'stash' ? t('Updated upstream') : labels.current,
      theirs: labels.operation === 'stash' ? t('Stashed changes') : labels.incoming,
      operation: op,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private post(): void {
    if (this.ready) void postToWebview(this.panel.webview, { type: 'conflicts/state', payload: { ...this.state, busy: this.busy } });
  }

  private repoById(id: string): Repo | undefined {
    return this.manager.all.find((r) => r.root === id);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'conflicts' } });
          this.post();
          break;
        case 'conflicts/open': {
          const repo = this.repoById(message.payload.repoId);
          if (repo) await openMergeEditor(vscode.Uri.file(path.join(repo.root, message.payload.path)));
          break;
        }
        case 'conflicts/accept': {
          const { repoId, paths, side } = message.payload;
          const repo = this.repoById(repoId);
          const view = this.state.repos.find((r) => r.id === repoId);
          if (!repo || !view || !paths.length) return;
          // Si ese lado borró el archivo, aceptarlo es borrarlo.
          const deleted = view.files.filter((f) => paths.includes(f.path) && (side === 'ours' ? f.yours : f.theirs) === 'deleted').map((f) => f.path);
          await this.withBusy(() => repo.git.acceptConflictSide(paths, side, deleted));
          await this.manager.refreshStatusesNow([repo]);
          break;
        }
        case 'conflicts/finish':
          await this.finish();
          break;
        case 'conflicts/close':
          this.panel.dispose();
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
      await this.reload();
    }
  }

  /** Finish: continúa la operación a medias en cada repo sin conflictos (con su barra de operaciones). */
  private async finish(): Promise<void> {
    const pending = this.state.repos.filter((r) => r.files.length === 0);
    for (const view of pending) {
      const repo = this.repoById(view.id);
      if (!repo) continue;
      if (view.operation) {
        const ok = await vscode.commands.executeCommand<boolean>('multigit.operation.continue', repo);
        if (ok === false) break;
      }
    }
    await this.reload();
    if (this.state.repos.length === 0) {
      vscode.window.setStatusBarMessage(t('$(check) MultiGit: conflicts resolved'), 4000);
      this.panel.dispose();
    }
  }

  private async withBusy(fn: () => Promise<unknown>): Promise<void> {
    this.busy = true;
    this.post();
    try {
      await fn();
    } finally {
      this.busy = false;
      await this.reload();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ConflictsPanel.current === this) ConflictsPanel.current = undefined;
    this.ready = false;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
