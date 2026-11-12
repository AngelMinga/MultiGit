// Vista Stashes: los stashes de todos los repos. Los creados juntos en varios repos (mismo mensaje,
// pocos minutos de diferencia) se muestran como uno solo, con un hijo por repo.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';
import { groupStashes, shelfName, type StashEntry, type StashGroup } from '../git/stashes';
import { statusLabel } from '../git/changes';
import { t } from '../i18n';

export type StashFile = ChangedFile & { untracked?: boolean };

export type StashNode =
  | { kind: 'group'; group: StashGroup<Repo> }
  | { kind: 'entry'; repo: Repo; stash: StashEntry; inGroup: boolean }
  | { kind: 'file'; repo: Repo; stash: StashEntry; file: StashFile };

/** Un stash concreto de un repo (lo que operan Apply, Pop, Drop…). */
export interface StashTarget {
  repo: Repo;
  stash: StashEntry;
}

export class StashesTree implements vscode.TreeDataProvider<StashNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<StashNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private groups: Array<StashGroup<Repo>> | undefined;
  private loading: Promise<Array<StashGroup<Repo>>> | undefined;
  private readonly files = new Map<string, Promise<StashFile[]>>();

  constructor(private readonly manager: RepoManager) {}

  dispose(): void {
    this.emitter.dispose();
  }

  refresh(): void {
    this.groups = undefined;
    this.loading = undefined;
    this.files.clear();
    this.emitter.fire(undefined);
  }

  /** Stashes agrupados (se leen de git la primera vez tras cada refresh). */
  async load(): Promise<Array<StashGroup<Repo>>> {
    if (this.groups) return this.groups;
    this.loading ??= (async () => {
      const perRepo = await Promise.all(
        this.manager.all.map(async (repo) => ({ repo, stashes: await repo.git.listStashes().catch(() => []) })),
      );
      const groups = groupStashes(perRepo);
      void vscode.commands.executeCommand('setContext', 'multigit.hasStashes', groups.length > 0);
      return groups;
    })();
    this.groups = await this.loading;
    return this.groups;
  }

  /** Stashes a los que se aplica una acción sobre el nodo (todos los del grupo, o uno). */
  targetsOf(node: StashNode): StashTarget[] {
    if (node.kind === 'group') return node.group.entries.map((e) => ({ repo: e.repo, stash: e.stash }));
    return [{ repo: node.repo, stash: node.stash }];
  }

  /** Mensaje visible (los de Shelve sin el prefijo). */
  static title(message: string): string {
    return shelfName(message) ?? (message || t('(no message)'));
  }

  async getChildren(node?: StashNode): Promise<StashNode[]> {
    if (!node) return (await this.load()).map((group) => ({ kind: 'group', group }));
    if (node.kind === 'group') {
      const [only] = node.group.entries;
      if (node.group.entries.length === 1 && only) return this.fileNodes(only.repo, only.stash);
      return node.group.entries.map((e) => ({ kind: 'entry', repo: e.repo, stash: e.stash, inGroup: true }));
    }
    if (node.kind === 'entry') return this.fileNodes(node.repo, node.stash);
    return [];
  }

  private async fileNodes(repo: Repo, stash: StashEntry): Promise<StashNode[]> {
    const key = `${repo.root}\0${stash.hash}`;
    let files = this.files.get(key);
    if (!files) {
      files = repo.git.stashFiles(stash.hash).catch(() => []);
      this.files.set(key, files);
    }
    return (await files).map((file) => ({ kind: 'file', repo, stash, file }));
  }

  getTreeItem(node: StashNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const { group } = node;
      const [first] = group.entries;
      const single = group.entries.length === 1 && first;
      const item = new vscode.TreeItem(StashesTree.title(group.message), vscode.TreeItemCollapsibleState.Collapsed);
      const where = single ? `${first.repo.name} · ${first.stash.ref}` : t('{0} repositories', group.entries.length);
      item.description = `${where} · ${formatDate(group.time)}`;
      item.iconPath = new vscode.ThemeIcon(shelfName(group.message) !== undefined ? 'archive' : 'git-stash');
      item.tooltip = tooltip(group);
      item.contextValue = 'multigit.stash.group';
      item.id = `stash:${group.key}`;
      return item;
    }
    if (node.kind === 'entry') {
      const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = [node.stash.ref, node.stash.branch && `⎇ ${node.stash.branch}`].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor(`multigit.repo${node.repo.colorIndex}`));
      item.contextValue = 'multigit.stash.entry';
      item.id = `stash:${node.repo.root}:${node.stash.hash}`;
      return item;
    }
    const { file } = node;
    const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(file.path);
    item.description = [dir === '.' ? '' : dir, file.untracked ? t('untracked') : ''].filter(Boolean).join(' · ');
    item.resourceUri = vscode.Uri.file(path.join(node.repo.root, file.path));
    item.tooltip = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}\n${file.untracked ? t('untracked') : statusLabel(file.status)}`;
    item.contextValue = 'multigit.stash.file';
    item.command = { command: 'multigit.stashes.openDiff', title: t('Show Diff'), arguments: [node] };
    item.id = `stash:${node.repo.root}:${node.stash.hash}:${file.path}`;
    return item;
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(vscode.env.language, { dateStyle: 'short', timeStyle: 'short' });
}

function tooltip(group: StashGroup<Repo>): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendText(`${StashesTree.title(group.message)}\n\n`);
  for (const { repo, stash } of group.entries) {
    md.appendMarkdown(`- **${escape(repo.name)}** \`${stash.ref}\`${stash.branch ? ` · ⎇ ${escape(stash.branch)}` : ''}\n`);
  }
  md.appendText(`\n${formatDate(group.time)}`);
  return md;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
