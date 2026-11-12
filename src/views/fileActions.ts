// Acciones sobre UN archivo (submenú Git del Explorer, del editor y de Changes), como IntelliJ:
// Show History, Annotate with Git Blame, Show Diff, Compare with Revision / Branch or Tag,
// Show Current Revision, Add, Rollback y Local History.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitContentProvider } from '../git/GitContentProvider';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { LogView } from '../webview/LogView';
import type { ChangesActions } from './changesActions';
import type { ChangesTree } from './ChangesTree';
import { filesOf, type ChangeNode } from './ChangesTree';

/** Archivo resuelto: su repo y la ruta relativa (con `/`). */
interface Target {
  repo: Repo;
  rel: string;
  uri: vscode.Uri;
}

export class FileActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly log: LogView,
    private readonly changes: ChangesActions,
    private readonly tree: ChangesTree,
  ) {}

  /** Uri (Explorer/editor), nodo de Changes o, si no hay, el editor activo. */
  resolve(arg?: vscode.Uri | ChangeNode): Target | undefined {
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && 'kind' in arg) {
      const ref = filesOf(arg)[0];
      if (ref) uri = vscode.Uri.file(path.join(ref.repo.root, ref.file.path));
    }
    uri ??= vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') return undefined;
    // El repo más interno que contiene el archivo (por si hay repos anidados).
    const repo = this.manager.all
      .filter((r) => !path.relative(r.root, uri!.fsPath).startsWith('..') && !path.isAbsolute(path.relative(r.root, uri!.fsPath)))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!repo) {
      void vscode.window.showWarningMessage('MultiGit: el archivo no está en ningún repositorio detectado.');
      return undefined;
    }
    return { repo, rel: path.relative(repo.root, uri.fsPath).split(path.sep).join('/'), uri };
  }

  /** Show History: Git Log de ese archivo; al elegir un commit se abre su diff. */
  async showHistory(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (t) await this.log.showFileHistory(t.repo.root, t.rel);
  }

  /** Annotate with Git Blame: el blame integrado de VS Code en el editor. */
  async blame(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    await vscode.window.showTextDocument(t.uri, { preview: false });
    try {
      await vscode.commands.executeCommand('git.blame.toggleEditorDecoration');
    } catch {
      void vscode.window.showWarningMessage(
        'MultiGit: esta versión de VS Code no tiene blame integrado. Actualiza VS Code o usa Show History.',
      );
    }
  }

  /** Show Diff: cambios locales del archivo contra HEAD. */
  async showDiff(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    const file = (await t.repo.git.getChanges()).find((f) => f.path === t.rel);
    if (!file) {
      void vscode.window.showInformationMessage(`MultiGit: ${path.posix.basename(t.rel)} no tiene cambios locales.`);
      return;
    }
    await this.changes.openDiff({ repo: t.repo, file });
  }

  /** Compare with Revision…: elegir un commit que tocó el archivo y compararlo con la versión local. */
  async compareWithRevision(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    const commits = await t.repo.git.fileHistory(t.rel).catch(() => []);
    if (!commits.length) {
      void vscode.window.showInformationMessage('MultiGit: el archivo no tiene historial en Git.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: c.subject,
        description: `${c.shortHash} · ${c.author} · ${new Date(c.date).toLocaleString('es')}`,
        hash: c.hash,
        short: c.shortHash,
      })),
      { title: `Compare with Revision — ${path.posix.basename(t.rel)}`, placeHolder: 'Elige la revisión', matchOnDescription: true },
    );
    if (picked) await this.diffAgainstLocal(t, picked.hash, picked.short);
  }

  /** Compare with Branch or Tag…: el archivo en esa rama o tag contra la versión local. */
  async compareWithRef(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    const [branches, tags] = await Promise.all([t.repo.git.getBranches(), t.repo.git.listTags().catch(() => [])]);
    const items: Array<vscode.QuickPickItem & { ref?: string }> = [
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...branches.local.map((b) => ({ label: b.name, iconPath: new vscode.ThemeIcon(b.current ? 'tag' : 'git-branch'), ref: b.name })),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...branches.remote.map((b) => ({ label: b.full, iconPath: new vscode.ThemeIcon('cloud'), ref: b.full })),
      ...(tags.length ? [{ label: 'Tags', kind: vscode.QuickPickItemKind.Separator } as const] : []),
      ...tags.map((tag) => ({ label: tag, iconPath: new vscode.ThemeIcon('tag'), ref: `refs/tags/${tag}` })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Compare with Branch or Tag — ${path.posix.basename(t.rel)}`,
      placeHolder: 'Rama o tag',
    });
    if (picked?.ref) await this.diffAgainstLocal(t, picked.ref, picked.label);
  }

  /** Show Current Revision: el último commit que tocó el archivo, en el Git Log. */
  async showCurrentRevision(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    const [last] = await t.repo.git.fileHistory(t.rel, 1).catch(() => []);
    if (!last) {
      void vscode.window.showInformationMessage('MultiGit: el archivo no tiene historial en Git.');
      return;
    }
    await this.log.showFileHistory(t.repo.root, t.rel);
    void vscode.window.setStatusBarMessage(`$(git-commit) ${last.shortHash} ${last.subject} — ${last.author}`, 8000);
  }

  /** Add: `git add` del archivo. */
  async add(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    try {
      await t.repo.git.addPaths([t.rel]);
      await this.tree.refresh();
      vscode.window.setStatusBarMessage(`$(add) ${t.rel} agregado a Git`, 4000);
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    }
  }

  /** Rollback…: el mismo flujo de la vista Changes (con confirmación). */
  async rollback(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = this.resolve(arg);
    if (!t) return;
    const file = (await t.repo.git.getChanges()).find((f) => f.path === t.rel);
    if (!file || file.kind !== 'tracked') {
      void vscode.window.showInformationMessage(`MultiGit: ${path.posix.basename(t.rel)} no tiene cambios para revertir.`);
      return;
    }
    await this.changes.rollback([{ repo: t.repo, file }], true);
  }

  // ------------------------------------------------------------------ Local History (de VS Code)

  async localHistory(action: 'show' | 'project' | 'label', arg?: vscode.Uri | ChangeNode): Promise<void> {
    const t = action === 'project' ? undefined : this.resolve(arg);
    if (action !== 'project' && !t) return;
    try {
      if (action === 'show') {
        // El historial local de VS Code se ve en la vista Timeline del archivo abierto.
        await vscode.window.showTextDocument(t!.uri, { preview: false });
        await vscode.commands.executeCommand('timeline.focus');
      } else if (action === 'project') {
        await vscode.commands.executeCommand('workbench.action.localHistory.restoreViaPicker');
      } else {
        await vscode.window.showTextDocument(t!.uri, { preview: false });
        await vscode.commands.executeCommand('workbench.action.localHistory.create');
      }
    } catch (error) {
      void vscode.window.showWarningMessage(`MultiGit: Local History no está disponible (${errorText(error)}).`);
    }
  }

  private async diffAgainstLocal(t: Target, ref: string, label: string): Promise<void> {
    const left = GitContentProvider.uri(t.repo.root, ref, t.rel);
    const title = `${path.posix.basename(t.rel)} (${label} ↔ local)`;
    await vscode.commands.executeCommand('vscode.diff', left, t.uri, title, { preview: true });
  }
}
