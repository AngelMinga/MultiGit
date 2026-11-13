// Vista "Compare": archivos distintos entre otra rama y la actual, por repo (como la pestaña Files de
// "Compare with" de IntelliJ). Clic en un archivo → diff '<otra>' ↔ '<actual>'.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { statusLabel } from '../git/changes';
import { GitContentProvider } from '../git/GitContentProvider';
import { errorText } from '../git/MultiRepoRunner';
import type { ChangedFile } from '../git/parsers';
import type { Repo } from '../git/RepoManager';
import { t } from '../i18n';

interface RepoResult {
  repo: Repo;
  /** Rama (o HEAD) actual del repo. */
  current: string;
  files: ChangedFile[];
  error?: string;
}

export type CompareNode = { kind: 'repo'; result: RepoResult } | { kind: 'file'; result: RepoResult; file: ChangedFile } | { kind: 'info'; text: string };

const CONTEXT_KEY = 'multigit.compareActive';

export class CompareFilesTree implements vscode.TreeDataProvider<CompareNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CompareNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private other = '';
  private repos: readonly Repo[] = [];
  private results: RepoResult[] = [];
  /** Se llama cuando cambia el título ('develop' ↔ 'feature/x'). */
  onDidChangeTitle?: (description: string | undefined) => void;

  /** Compara `other` con la rama actual de cada repo y muestra la vista. */
  async compare(repos: readonly Repo[], other: string): Promise<void> {
    this.other = other;
    this.repos = repos;
    await vscode.window.withProgress(
      { location: { viewId: 'multigit.compareFiles' }, title: t("Comparing '{0}'…", other) },
      () => this.load(),
    );
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
    await vscode.commands.executeCommand('multigit.compareFiles.focus');
  }

  async load(): Promise<void> {
    this.results = await Promise.all(
      this.repos.map(async (repo): Promise<RepoResult> => {
        const current = repo.status?.branch ?? 'HEAD';
        try {
          if (!(await repo.git.revisionExists(this.other))) return { repo, current, files: [], error: t("'{0}' does not exist in this repository", this.other) };
          return { repo, current, files: await repo.git.diffRefs(this.other, 'HEAD') };
        } catch (error) {
          return { repo, current, files: [], error: errorText(error) };
        }
      }),
    );
    const currents = [...new Set(this.results.map((r) => r.current))];
    this.onDidChangeTitle?.(`${this.other} ↔ ${currents.length === 1 ? currents[0] : t('current branch')}`);
    this.emitter.fire(undefined);
  }

  async close(): Promise<void> {
    this.results = [];
    this.onDidChangeTitle?.(undefined);
    this.emitter.fire(undefined);
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  }

  getChildren(node?: CompareNode): CompareNode[] {
    if (!node) {
      const withFiles = this.results.filter((r) => r.files.length || r.error);
      const same = this.results.filter((r) => !r.files.length && !r.error).map((r) => r.repo.name);
      return [
        ...withFiles.map((result): CompareNode => ({ kind: 'repo', result })),
        ...(same.length ? [{ kind: 'info', text: t('No differences: {0}', same.join(', ')) } as CompareNode] : []),
      ];
    }
    if (node.kind === 'repo') return node.result.files.map((file) => ({ kind: 'file', result: node.result, file }));
    return [];
  }

  getTreeItem(node: CompareNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('check');
      return item;
    }
    const { result } = node;
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(result.repo.name, result.error ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
      item.description = result.error ?? `${t('{0} file(s)', result.files.length)} · ⎇ ${result.current}`;
      item.iconPath = result.error
        ? new vscode.ThemeIcon('error')
        : new vscode.ThemeIcon('repo', new vscode.ThemeColor(`multigit.repo${result.repo.colorIndex}`));
      item.id = `compare:${result.repo.root}`;
      return item;
    }
    const { file } = node;
    const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(file.path);
    item.description = [file.status, dir === '.' ? '' : dir, file.oldPath ? `← ${file.oldPath}` : ''].filter(Boolean).join('  ');
    item.resourceUri = vscode.Uri.file(path.join(result.repo.root, file.path));
    item.tooltip = `${statusLabel(file.status)}: ${result.repo.name}/${file.path}`;
    item.command = { command: 'multigit.compareFiles.openDiff', title: t('Show Diff'), arguments: [node] };
    item.contextValue = 'multigit.compare.file';
    item.id = `compare:${result.repo.root}:${file.path}`;
    return item;
  }

  /** Diff del archivo: '<otra rama>' ↔ HEAD (lado vacío si no existe en uno de los dos). */
  async openDiff(node: CompareNode): Promise<void> {
    if (node.kind !== 'file') return;
    const { result, file } = node;
    const left = GitContentProvider.uri(result.repo.root, file.status === 'A' ? '' : this.other, file.oldPath ?? file.path);
    const right = GitContentProvider.uri(result.repo.root, file.status === 'D' ? '' : 'HEAD', file.path);
    const title = `${path.posix.basename(file.path)} (${this.other} ↔ ${result.current})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
