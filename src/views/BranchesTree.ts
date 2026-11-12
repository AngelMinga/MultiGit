// Vista "Ramas": árbol Local / Remote como el panel de ramas del Git Log de IntelliJ.
//  - Agrupar por repositorio: Local → repo → ramas
//  - Agrupar por rama:        Local → rama (n/9 repos) → repos donde existe
// Al hacer clic en una rama se abre el mismo menú de acciones que en el popup.
import * as vscode from 'vscode';
import { orderBranches, type RepoBranches } from '../git/branches';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { BranchRef, Scope } from './branchActions';

export type GroupBy = 'repo' | 'branch';
type Section = 'local' | 'remote';

export type BranchNode =
  | { kind: 'section'; section: Section }
  | { kind: 'repo'; section: Section; repo: Repo }
  /** Rama. En modo repo, `repos` tiene un solo elemento. */
  | { kind: 'branch'; section: Section; repos: Repo[]; ref: BranchRef; currentIn: Repo[] }
  /** Modo rama: un repo dentro de una rama. */
  | { kind: 'branchRepo'; repo: Repo; ref: BranchRef; current: boolean }
  | { kind: 'message'; text: string };

export class BranchesTree implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BranchNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private cache: Promise<Map<Repo, RepoBranches>> | undefined;
  private groupBy: GroupBy = 'repo';

  constructor(private readonly manager: RepoManager) {
    void vscode.commands.executeCommand('setContext', 'multigit.branchesGroupBy', this.groupBy);
  }

  /** Descarta la caché y vuelve a leer las ramas. */
  refresh(): void {
    this.cache = undefined;
    this.changeEmitter.fire(undefined);
  }

  setGroupBy(groupBy: GroupBy): void {
    this.groupBy = groupBy;
    void vscode.commands.executeCommand('setContext', 'multigit.branchesGroupBy', groupBy);
    this.changeEmitter.fire(undefined);
  }

  /** Repos y rama sobre los que actúa un nodo (para el menú de acciones y F2). */
  scopeOf(node: BranchNode): { scope: Scope; ref: BranchRef } | undefined {
    if (node.kind === 'branch') {
      const label = node.repos.length === 1 ? node.repos[0]!.name : `${node.repos.length} repositorios`;
      return { scope: { repos: node.repos, label }, ref: node.ref };
    }
    if (node.kind === 'branchRepo') return { scope: { repos: [node.repo], label: node.repo.name }, ref: node.ref };
    return undefined;
  }

  async getChildren(node?: BranchNode): Promise<BranchNode[]> {
    if (!node) {
      if (this.manager.all.length === 0) return [];
      return [
        { kind: 'section', section: 'local' },
        { kind: 'section', section: 'remote' },
      ];
    }

    const data = await this.load();
    const favorites = this.manager.favoriteBranches;

    if (node.kind === 'section') {
      if (this.groupBy === 'repo') {
        return this.manager.all.filter((r) => data.has(r)).map((repo) => ({ kind: 'repo', section: node.section, repo }));
      }
      return this.branchesAcrossRepos(node.section, data, favorites);
    }

    if (node.kind === 'repo') {
      const branches = data.get(node.repo);
      if (!branches) return [{ kind: 'message', text: 'no se pudieron leer las ramas' }];
      return node.section === 'local'
        ? sortLocal(branches.local, favorites).map((b) => ({
            kind: 'branch' as const,
            section: 'local' as const,
            repos: [node.repo],
            ref: { type: 'local' as const, name: b.name },
            currentIn: b.current ? [node.repo] : [],
          }))
        : orderBranches(branches.remote, favorites, (b) => b.name).map((b) => ({
            kind: 'branch' as const,
            section: 'remote' as const,
            repos: [node.repo],
            ref: { type: 'remote' as const, remote: b.remote, name: b.name, full: b.full },
            currentIn: [],
          }));
    }

    if (node.kind === 'branch' && this.groupBy === 'branch') {
      return node.repos.map((repo) => ({ kind: 'branchRepo', repo, ref: node.ref, current: node.currentIn.includes(repo) }));
    }
    return [];
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(
          node.section === 'local' ? 'Local' : 'Remote',
          node.section === 'local' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `section/${node.section}/${this.groupBy}`;
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(
          node.repo.name,
          node.section === 'local' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `repo/${node.section}/${node.repo.root}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        return item;
      }
      case 'branch': {
        const name = node.ref.type === 'local' ? node.ref.name : node.ref.full;
        const short = node.ref.name;
        const byBranch = this.groupBy === 'branch';
        const item = new vscode.TreeItem(
          name,
          byBranch ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `branch/${this.groupBy}/${node.section}/${byBranch ? '' : node.repos[0]!.root}/${name}`;
        const total = this.manager.all.length;
        const current = node.currentIn.length > 0;
        item.iconPath = branchIcon(current, this.manager.favoriteBranches.includes(short));
        if (byBranch) {
          const where = node.repos.length === total ? `${total}/${total}` : `${node.repos.length}/${total}`;
          item.description = current ? `${where} · actual en ${node.currentIn.length}` : where;
          item.tooltip = node.repos.map((r) => r.name).join(', ');
        } else if (current) {
          item.description = 'actual';
        }
        // local.current = rama actual en todos sus repos (oculta Checkout, Merge, Delete…).
        const allCurrent = node.ref.type === 'local' && node.currentIn.length === node.repos.length;
        item.contextValue = `multigit.branch.${node.ref.type}${allCurrent ? '.current' : ''}`;
        item.command = { command: 'multigit.branchesTree.actions', title: 'Acciones', arguments: [node] };
        return item;
      }
      case 'branchRepo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.None);
        item.id = `branchRepo/${node.repo.root}/${node.ref.type === 'local' ? node.ref.name : node.ref.full}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        if (node.current) item.description = 'actual';
        item.contextValue = `multigit.branch.${node.ref.type}${node.current ? '.current' : ''}`;
        item.command = { command: 'multigit.branchesTree.actions', title: 'Acciones', arguments: [node] };
        return item;
      }
      case 'message':
        return new vscode.TreeItem(node.text);
    }
  }

  getParent(): undefined {
    return undefined;
  }

  private load(): Promise<Map<Repo, RepoBranches>> {
    this.cache ??= (async () => {
      const map = new Map<Repo, RepoBranches>();
      await Promise.all(
        this.manager.all.map(async (repo) => {
          try {
            map.set(repo, await repo.git.getBranches());
          } catch {
            // el repo queda fuera del árbol
          }
        }),
      );
      return map;
    })();
    return this.cache;
  }

  /** Modo "agrupar por rama": unión de ramas de todos los repos, con los repos donde existe cada una. */
  private branchesAcrossRepos(section: Section, data: Map<Repo, RepoBranches>, favorites: string[]): BranchNode[] {
    const byName = new Map<string, { ref: BranchRef; repos: Repo[]; currentIn: Repo[] }>();
    for (const repo of this.manager.all) {
      const branches = data.get(repo);
      if (!branches) continue;
      if (section === 'local') {
        for (const b of branches.local) {
          const entry = byName.get(b.name) ?? { ref: { type: 'local', name: b.name }, repos: [], currentIn: [] };
          entry.repos.push(repo);
          if (b.current) entry.currentIn.push(repo);
          byName.set(b.name, entry);
        }
      } else {
        for (const b of branches.remote) {
          const entry =
            byName.get(b.full) ?? { ref: { type: 'remote', remote: b.remote, name: b.name, full: b.full }, repos: [], currentIn: [] };
          entry.repos.push(repo);
          byName.set(b.full, entry);
        }
      }
    }
    const entries = [...byName.values()];
    const rank = (e: (typeof entries)[number]) => (e.currentIn.length ? 0 : 1);
    return orderBranches(entries, favorites, (e) => e.ref.name)
      .sort((a, b) => rank(a) - rank(b))
      .map((e) => ({ kind: 'branch', section, repos: e.repos, ref: e.ref, currentIn: e.currentIn }));
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Orden como en IntelliJ: rama actual, favoritas y luego alfabético. */
function sortLocal<T extends { name: string; current: boolean }>(branches: readonly T[], favorites: readonly string[]): T[] {
  return orderBranches(branches, favorites, (b) => b.name).sort((a, b) => Number(b.current) - Number(a.current));
}

function branchIcon(current: boolean, favorite: boolean): vscode.ThemeIcon {
  if (current) return new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.green'));
  if (favorite) return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
  return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.blue'));
}
