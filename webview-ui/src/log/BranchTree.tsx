// Árbol de ramas del log: HEAD / Local / Remote, agrupable por repositorio y por directorio
// (prefijos `feature/…`). Clic en una rama → filtra el log.
import { useMemo, useState, type ReactElement } from 'react';
import type { LogRepoInfo } from '../../../src/webview/protocol';

export interface BranchSelection {
  branch: string | null;
  repoIds: string[];
}

interface Node {
  key: string;
  label: string;
  children?: Node[];
  /** Rama a filtrar (hoja). */
  branch?: string;
  repoIds?: string[];
  colorIndex?: number;
  current?: boolean;
  favorite?: boolean;
  /** "3/9" en el modo sin repos. */
  count?: string;
}

export function BranchTree(props: {
  repos: LogRepoInfo[];
  favorites: string[];
  selected: BranchSelection;
  onSelect: (selection: BranchSelection) => void;
}) {
  const [byRepo, setByRepo] = useState(true);
  const [byDir, setByDir] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['remote']));
  const [query, setQuery] = useState('');

  const tree = useMemo(() => {
    const full = buildTree(props.repos, props.favorites, byRepo, byDir);
    return query.trim() ? filterTree(full, query.trim().toLowerCase()) : full;
  }, [props.repos, props.favorites, byRepo, byDir, query]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const isSelected = (n: Node) =>
    n.branch !== undefined &&
    n.branch === (props.selected.branch ?? '') &&
    sameIds(n.repoIds ?? [], props.selected.repoIds);

  const render = (nodes: Node[], depth: number): ReactElement[] =>
    nodes.flatMap((n) => {
      // Con búsqueda todo se muestra expandido.
      const open = query.trim() !== '' || !collapsed.has(n.key);
      const row = (
        <li
          key={n.key}
          className={`tree-row${isSelected(n) ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() =>
            n.children ? toggle(n.key) : props.onSelect({ branch: n.branch ?? null, repoIds: n.repoIds ?? [] })
          }
          title={n.branch ?? n.label}
        >
          <span className="twisty">{n.children ? (open ? '▾' : '▸') : ''}</span>
          {n.colorIndex !== undefined && (
            <span className="dot" style={{ background: `var(--vscode-multigit-repo${n.colorIndex})` }} />
          )}
          {n.branch !== undefined && <span className={`branch-icon${n.current ? ' current' : n.favorite ? ' favorite' : ''}`}>{n.current ? '◆' : n.favorite ? '★' : '⑂'}</span>}
          <span className="tree-label">{n.label}</span>
          {n.count && <span className="muted small">{n.count}</span>}
        </li>
      );
      return n.children && open ? [row, ...render(n.children, depth + 1)] : [row];
    });

  return (
    <div className="branch-tree">
      <div className="pane-toolbar">
        <span className="pane-title">Ramas</span>
        <button className={`toggle${byRepo ? ' on' : ''}`} title="Agrupar por repositorio" onClick={() => setByRepo((v) => !v)}>
          Repo
        </button>
        <button className={`toggle${byDir ? ' on' : ''}`} title="Agrupar por directorio" onClick={() => setByDir((v) => !v)}>
          Dir
        </button>
      </div>
      <input className="tree-search" placeholder="Rama o tag" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="tree">
        <li
          className={`tree-row${props.selected.branch === null ? ' selected' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => props.onSelect({ branch: null, repoIds: [] })}
        >
          <span className="twisty" />
          <span className="tree-label">Todas las ramas</span>
        </li>
        <li
          className={`tree-row${props.selected.branch === 'HEAD' ? ' selected' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => props.onSelect({ branch: 'HEAD', repoIds: [] })}
        >
          <span className="twisty" />
          <span className="branch-icon current">◆</span>
          <span className="tree-label">HEAD (rama actual)</span>
        </li>
        {render(tree, 0)}
      </ul>
    </div>
  );
}

function buildTree(repos: LogRepoInfo[], favorites: string[], byRepo: boolean, byDir: boolean): Node[] {
  const section = (kind: 'local' | 'remote'): Node => {
    const namesOf = (r: LogRepoInfo) => (kind === 'local' ? r.local : r.remote);
    let children: Node[];
    if (byRepo) {
      children = repos.map((r) => ({
        key: `${kind}/repo/${r.id}`,
        label: r.name,
        colorIndex: r.colorIndex,
        children: leaves(
          `${kind}/${r.id}`,
          namesOf(r).map((name) => ({ name, repoIds: [r.id], current: kind === 'local' && r.current === name })),
          favorites,
          byDir,
        ),
      }));
    } else {
      const union = new Map<string, { repoIds: string[]; current: boolean }>();
      for (const r of repos) {
        for (const name of namesOf(r)) {
          const e = union.get(name) ?? { repoIds: [], current: false };
          e.repoIds.push(r.id);
          if (kind === 'local' && r.current === name) e.current = true;
          union.set(name, e);
        }
      }
      children = leaves(
        `${kind}/all`,
        [...union.entries()].map(([name, e]) => ({
          name,
          repoIds: [],
          current: e.current,
          count: `${e.repoIds.length}/${repos.length}`,
        })),
        favorites,
        byDir,
      );
    }
    return { key: kind, label: kind === 'local' ? 'Local' : 'Remote', children };
  };
  return [section('local'), section('remote')];
}

interface LeafInput {
  name: string;
  repoIds: string[];
  current: boolean;
  count?: string;
}

/** Hojas ordenadas (actual, favoritas, alfabético); con `byDir`, anidadas por prefijo `a/b/`. */
function leaves(prefix: string, items: LeafInput[], favorites: string[], byDir: boolean): Node[] {
  const short = (name: string) => name.replace(/^[^/]+\//, '');
  const favIndex = (i: LeafInput) => {
    const full = favorites.indexOf(i.name);
    return full >= 0 ? full : favorites.indexOf(short(i.name));
  };
  // Rama actual primero, luego favoritas en su orden y luego alfabético.
  const rank = (i: LeafInput) => (i.current ? -1 : favIndex(i) >= 0 ? favIndex(i) : 1000);
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const leaf = (i: LeafInput, label: string): Node => ({
    key: `${prefix}/${i.name}`,
    label,
    branch: i.name,
    repoIds: i.repoIds,
    current: i.current,
    favorite: favorites.includes(i.name) || favorites.includes(short(i.name)),
    count: i.count,
  });
  if (!byDir) return sorted.map((i) => leaf(i, i.name));

  const root: Node[] = [];
  for (const i of sorted) {
    const parts = i.name.split('/');
    let level = root;
    let path = prefix;
    for (const dir of parts.slice(0, -1)) {
      path += `/${dir}`;
      let folder = level.find((n) => n.children && n.label === dir);
      if (!folder) {
        folder = { key: `dir:${path}`, label: dir, children: [] };
        level.push(folder);
      }
      level = folder.children!;
    }
    level.push(leaf(i, parts[parts.length - 1]!));
  }
  return root;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Deja solo las ramas que contienen `q` (y las carpetas/repos que las contienen). */
function filterTree(nodes: Node[], q: string): Node[] {
  return nodes.flatMap((n) => {
    if (!n.children) return (n.branch ?? n.label).toLowerCase().includes(q) ? [n] : [];
    const children = filterTree(n.children, q);
    return children.length ? [{ ...n, children }] : [];
  });
}
