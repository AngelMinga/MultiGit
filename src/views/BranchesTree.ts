// Vista "Ramas": árbol Local / Remote / Tags como el panel de ramas del Git Log de IntelliJ.
// Opciones (menú ⋯ de la vista, recordadas):
//  - On Single Click: Show Actions (menú de acciones) / Update Branch Filter (Git Log filtrado por la
//    rama) / Navigate Log to Branch Head (Git Log en el último commit de la rama).
//  - Group by Repository: Local → repo → ramas. Sin ella: Local → rama (n/9 repos) → repos.
//  - Group by Directory: los prefijos `feature/…` se muestran como carpetas.
//  - Show Tags.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import { orderBranches, type RepoBranches } from '../git/branches';
import type { Repo, RepoManager } from '../git/RepoManager';
import { branchDecorationUri } from './BranchDecorations';
import type { BranchRef, Scope } from './branchActions';

type Section = 'local' | 'remote' | 'tags';
export type ClickMode = 'actions' | 'filter' | 'navigate';

export interface BranchesOptions {
  clickMode: ClickMode;
  byRepo: boolean;
  byDir: boolean;
  showTags: boolean;
}

const DEFAULT_OPTIONS: BranchesOptions = { clickMode: 'actions', byRepo: true, byDir: false, showTags: false };
const OPTIONS_KEY = 'multigit.branchesOptions';

export type BranchNode =
  | { kind: 'section'; section: Section }
  | { kind: 'repo'; section: Section; repo: Repo }
  | { kind: 'folder'; section: Section; id: string; label: string; items: BranchNode[] }
  /** Rama. Con "Group by Repository", `repos` tiene un solo elemento. */
  | { kind: 'branch'; section: Section; repos: Repo[]; ref: BranchRef; currentIn: Repo[]; label: string; track?: Track }
  | { kind: 'tag'; repos: Repo[]; name: string; label: string }
  /** Sin "Group by Repository": un repo dentro de una rama. */
  | { kind: 'branchRepo'; repo: Repo; ref: BranchRef; current: boolean; track?: Track }
  | { kind: 'message'; text: string };

/** Commits por subir (↑) / bajar (↓) respecto al upstream de una rama local. */
interface Track {
  ahead: number;
  behind: number;
}

interface RepoData {
  branches: RepoBranches;
  tags: string[];
}

export class BranchesTree implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BranchNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private cache: Promise<Map<Repo, RepoData>> | undefined;
  private options: BranchesOptions;

  constructor(
    private readonly manager: RepoManager,
    private readonly memento: vscode.Memento,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...memento.get<Partial<BranchesOptions>>(OPTIONS_KEY) };
    this.publish();
  }

  /** Descarta la caché y vuelve a leer las ramas. */
  refresh(): void {
    this.cache = undefined;
    this.changeEmitter.fire(undefined);
  }

  get clickMode(): ClickMode {
    return this.options.clickMode;
  }

  toggle(key: 'byRepo' | 'byDir' | 'showTags'): void {
    this.setOption(key, !this.options[key]);
  }

  setOption<K extends keyof BranchesOptions>(key: K, value: BranchesOptions[K]): void {
    this.options = { ...this.options, [key]: value };
    void this.memento.update(OPTIONS_KEY, this.options);
    this.publish();
    this.changeEmitter.fire(undefined);
  }

  private publish(): void {
    const set = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
    set('multigit.branches.clickMode', this.options.clickMode);
    set('multigit.branches.byRepo', this.options.byRepo);
    set('multigit.branches.byDir', this.options.byDir);
    set('multigit.branches.showTags', this.options.showTags);
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

  /** Ref para el Git Log (rama o `refs/tags/<tag>`) y repos de un nodo. */
  logTargetOf(node: BranchNode): { ref: string; repoIds: string[] } | undefined {
    const all = this.manager.all.length;
    const ids = (repos: Repo[]) => (repos.length === all ? [] : repos.map((r) => r.root));
    if (node.kind === 'branch') {
      return { ref: node.ref.type === 'local' ? node.ref.name : node.ref.full, repoIds: ids(node.repos) };
    }
    if (node.kind === 'branchRepo') {
      return { ref: node.ref.type === 'local' ? node.ref.name : node.ref.full, repoIds: [node.repo.root] };
    }
    if (node.kind === 'tag') return { ref: `refs/tags/${node.name}`, repoIds: ids(node.repos) };
    return undefined;
  }

  async getChildren(node?: BranchNode): Promise<BranchNode[]> {
    if (!node) {
      if (this.manager.all.length === 0) return [];
      const sections: BranchNode[] = [
        { kind: 'section', section: 'local' },
        { kind: 'section', section: 'remote' },
      ];
      if (this.options.showTags) sections.push({ kind: 'section', section: 'tags' });
      return sections;
    }

    const data = await this.load();
    switch (node.kind) {
      case 'section': {
        if (this.options.byRepo) {
          return this.manager.all
            .filter((r) => data.has(r) && (node.section !== 'tags' || data.get(r)!.tags.length > 0))
            .map((repo) => ({ kind: 'repo', section: node.section, repo }));
        }
        return this.leaves(node.section, this.entriesAcrossRepos(node.section, data), 'all');
      }
      case 'repo': {
        const d = data.get(node.repo);
        if (!d) return [{ kind: 'message', text: 'no se pudieron leer las ramas' }];
        return this.leaves(node.section, this.entriesOfRepo(node.section, node.repo, d), node.repo.root);
      }
      case 'folder':
        return node.items;
      case 'branch':
        if (this.options.byRepo) return [];
        return node.repos.map((repo) => ({
          kind: 'branchRepo',
          repo,
          ref: node.ref,
          current: node.currentIn.includes(repo),
          track: node.ref.type === 'local' ? trackOf(data.get(repo)?.branches, node.ref.name) : undefined,
        }));
      default:
        return [];
    }
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
    const modeId = `${this.options.byRepo ? 'r' : ''}${this.options.byDir ? 'd' : ''}`;
    switch (node.kind) {
      case 'section': {
        const label = node.section === 'local' ? 'Local' : node.section === 'remote' ? 'Remote' : 'Tags';
        const item = new vscode.TreeItem(
          label,
          node.section === 'local' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `section/${node.section}/${modeId}`;
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(
          node.repo.name,
          node.section === 'local' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `repo/${node.section}/${node.repo.root}/${modeId}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.id;
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case 'branch': {
        const name = node.ref.type === 'local' ? node.ref.name : node.ref.full;
        const item = new vscode.TreeItem(
          node.label,
          this.options.byRepo ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `branch/${modeId}/${node.section}/${this.options.byRepo ? node.repos[0]!.root : ''}/${name}`;
        const total = this.manager.all.length;
        const current = node.currentIn.length > 0;
        item.iconPath = branchIcon(current, this.manager.favoriteBranches.includes(node.ref.name));
        const counters = node.track ? formatAheadBehind(node.track) : '';
        if (!this.options.byRepo) {
          const where = `${node.repos.length}/${total}`;
          item.description = joinDesc(counters, current ? `${where} · actual en ${node.currentIn.length}` : where);
          item.tooltip = `${name}\n${node.repos.map((r) => r.name).join(', ')}${trackTooltip(node.track)}`;
        } else {
          item.description = joinDesc(counters, current ? 'actual' : '');
          item.tooltip = `${name}${trackTooltip(node.track)}`;
        }
        // local.current = rama actual en todos sus repos (oculta Checkout, Merge, Delete…).
        const allCurrent = node.ref.type === 'local' && node.currentIn.length === node.repos.length;
        if (node.track) item.resourceUri = branchDecorationUri(item.id, node.track);
        item.contextValue = `multigit.branch.${node.ref.type}${allCurrent ? '.current' : ''}`;
        item.command = this.clickCommand(node, 'multigit.branchesTree.actions');
        return item;
      }
      case 'tag': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `tag/${modeId}/${node.repos.map((r) => r.root).join('|')}/${node.name}`;
        item.iconPath = new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.yellow'));
        item.tooltip = `${node.name}\n${node.repos.map((r) => r.name).join(', ')}`;
        if (!this.options.byRepo) item.description = `${node.repos.length}/${this.manager.all.length}`;
        item.contextValue = 'multigit.tag';
        item.command = this.clickCommand(node, 'multigit.branchesTree.tagActions');
        return item;
      }
      case 'branchRepo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.None);
        item.id = `branchRepo/${node.repo.root}/${node.ref.type === 'local' ? node.ref.name : node.ref.full}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(node.repo)));
        item.description = joinDesc(node.track ? formatAheadBehind(node.track) : '', node.current ? 'actual' : '');
        if (node.track) {
          item.tooltip = `${node.repo.name}${trackTooltip(node.track)}`;
          item.resourceUri = branchDecorationUri(item.id, node.track);
        }
        item.contextValue = `multigit.branch.${node.ref.type}${node.current ? '.current' : ''}`;
        item.command = this.clickCommand(node, 'multigit.branchesTree.actions');
        return item;
      }
      case 'message':
        return new vscode.TreeItem(node.text);
    }
  }

  getParent(): undefined {
    return undefined;
  }

  /** Comando del clic según "On Single Click". */
  private clickCommand(node: BranchNode, actionsCommand: string): vscode.Command {
    const command =
      this.options.clickMode === 'filter'
        ? 'multigit.branchesTree.showInLog'
        : this.options.clickMode === 'navigate'
          ? 'multigit.branchesTree.navigateLog'
          : actionsCommand;
    return { command, title: 'Abrir', arguments: [node] };
  }

  private load(): Promise<Map<Repo, RepoData>> {
    this.cache ??= (async () => {
      const map = new Map<Repo, RepoData>();
      await Promise.all(
        this.manager.all.map(async (repo) => {
          try {
            const [branches, tags] = await Promise.all([
              repo.git.getBranches(),
              this.options.showTags ? repo.git.listTags().catch(() => []) : Promise.resolve([]),
            ]);
            map.set(repo, { branches, tags });
          } catch {
            // el repo queda fuera del árbol
          }
        }),
      );
      return map;
    })();
    return this.cache;
  }

  /** Ramas o tags de un repo (Group by Repository). */
  private entriesOfRepo(section: Section, repo: Repo, d: RepoData): BranchNode[] {
    const favorites = this.manager.favoriteBranches;
    if (section === 'tags') return d.tags.map((name) => ({ kind: 'tag', repos: [repo], name, label: name }));
    if (section === 'local') {
      return sortLocal(d.branches.local, favorites).map((b) => ({
        kind: 'branch',
        section,
        repos: [repo],
        ref: { type: 'local', name: b.name },
        currentIn: b.current ? [repo] : [],
        label: b.name,
        track: b.upstream && !b.gone ? { ahead: b.ahead, behind: b.behind } : undefined,
      }));
    }
    return orderBranches(d.branches.remote, favorites, (b) => b.name).map((b) => ({
      kind: 'branch',
      section,
      repos: [repo],
      ref: { type: 'remote', remote: b.remote, name: b.name, full: b.full },
      currentIn: [],
      label: b.full,
    }));
  }

  /** Sin "Group by Repository": unión de ramas o tags de todos los repos. */
  private entriesAcrossRepos(section: Section, data: Map<Repo, RepoData>): BranchNode[] {
    const favorites = this.manager.favoriteBranches;
    if (section === 'tags') {
      const byName = new Map<string, Repo[]>();
      for (const repo of this.manager.all) {
        for (const t of data.get(repo)?.tags ?? []) byName.set(t, [...(byName.get(t) ?? []), repo]);
      }
      return [...byName.entries()].map(([name, repos]) => ({ kind: 'tag', repos, name, label: name }));
    }
    const byName = new Map<string, { ref: BranchRef; repos: Repo[]; currentIn: Repo[]; track?: Track }>();
    for (const repo of this.manager.all) {
      const b = data.get(repo)?.branches;
      if (!b) continue;
      if (section === 'local') {
        for (const l of b.local) {
          const e = byName.get(l.name) ?? { ref: { type: 'local', name: l.name }, repos: [], currentIn: [] };
          e.repos.push(repo);
          if (l.current) e.currentIn.push(repo);
          if (l.upstream && !l.gone) {
            // Suma de todos los repos, como el contador de la barra de estado.
            e.track = { ahead: (e.track?.ahead ?? 0) + l.ahead, behind: (e.track?.behind ?? 0) + l.behind };
          }
          byName.set(l.name, e);
        }
      } else {
        for (const r of b.remote) {
          const e = byName.get(r.full) ?? { ref: { type: 'remote', remote: r.remote, name: r.name, full: r.full }, repos: [], currentIn: [] };
          e.repos.push(repo);
          byName.set(r.full, e);
        }
      }
    }
    const entries = orderBranches([...byName.values()], favorites, (e) => e.ref.name).sort(
      (a, b) => Number(b.currentIn.length > 0) - Number(a.currentIn.length > 0),
    );
    return entries.map((e) => ({
      kind: 'branch',
      section,
      repos: e.repos,
      ref: e.ref,
      currentIn: e.currentIn,
      label: e.ref.type === 'local' ? e.ref.name : e.ref.full,
      track: e.track,
    }));
  }

  /** Con "Group by Directory", agrupa por prefijos `a/b/` en carpetas; si no, devuelve la lista. */
  private leaves(section: Section, entries: BranchNode[], scope: string): BranchNode[] {
    if (!this.options.byDir) return entries;
    const root: BranchNode[] = [];
    const folders = new Map<string, Extract<BranchNode, { kind: 'folder' }>>();
    for (const entry of entries) {
      if (entry.kind !== 'branch' && entry.kind !== 'tag') continue;
      const parts = entry.label.split('/');
      let level = root;
      let pathSoFar = '';
      for (const dir of parts.slice(0, -1)) {
        pathSoFar += `${dir}/`;
        const id = `folder/${section}/${scope}/${pathSoFar}`;
        let folder = folders.get(id);
        if (!folder) {
          folder = { kind: 'folder', section, id, label: dir, items: [] };
          folders.set(id, folder);
          level.push(folder);
        }
        level = folder.items;
      }
      level.push({ ...entry, label: parts[parts.length - 1]! });
    }
    // Carpetas primero, como IntelliJ.
    const sortLevel = (nodes: BranchNode[]): BranchNode[] => {
      nodes.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'));
      for (const n of nodes) if (n.kind === 'folder') sortLevel(n.items);
      return nodes;
    };
    return sortLevel(root);
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

function trackOf(branches: RepoBranches | undefined, name: string): Track | undefined {
  const b = branches?.local.find((l) => l.name === name);
  return b?.upstream && !b.gone ? { ahead: b.ahead, behind: b.behind } : undefined;
}

/** `↓16 · actual`, omitiendo las partes vacías (undefined si no queda nada). */
function joinDesc(...parts: string[]): string | undefined {
  return parts.filter(Boolean).join(' · ') || undefined;
}

function trackTooltip(track: Track | undefined): string {
  if (!track || (!track.ahead && !track.behind)) return '';
  const lines: string[] = [];
  if (track.behind) lines.push(`↓ ${track.behind} commit(s) entrantes por bajar`);
  if (track.ahead) lines.push(`↑ ${track.ahead} commit(s) salientes por subir`);
  return `\n${lines.join('\n')}`;
}
