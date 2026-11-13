// Árbol de ramas del log: HEAD / Local / Remote / Tags, agrupable por repositorio y por directorio
// (prefijos `feature/…`). Opciones en el menú ⋮, como IntelliJ: qué hace un clic (filtrar el log o
// navegar al último commit de la rama), Group by Directory / Repository y Show Tags.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { LogRepoInfo } from '../../../src/webview/protocol';
import { getState, setState } from '../vscode';
import { t } from '../i18n';

/** Qué hace un clic en una rama: filtrar el log o saltar a su último commit. */
export type ClickMode = 'filter' | 'navigate';

interface TreeOptions {
  clickMode: ClickMode;
  byRepo: boolean;
  byDir: boolean;
  showTags: boolean;
}

const DEFAULT_OPTIONS: TreeOptions = { clickMode: 'filter', byRepo: true, byDir: false, showTags: true };

/** Rama (o tag) sobre la que se abrió el menú contextual. */
export interface BranchTarget {
  branch: string;
  repoIds: string[];
  kind: 'local' | 'remote' | 'tag';
  /** Es la rama actual (en su repo o en alguno). */
  current: boolean;
  /** Menú de "HEAD (rama actual)": `branch` es la rama común, o `HEAD` si los repos están en ramas distintas. */
  head?: boolean;
}

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
  kind?: 'local' | 'remote' | 'tag';
  /** Commits por subir (↑) / bajar (↓) respecto al upstream. */
  ahead?: number;
  behind?: number;
}

export function BranchTree(props: {
  repos: LogRepoInfo[];
  favorites: string[];
  selected: BranchSelection;
  onSelect: (selection: BranchSelection, mode: ClickMode) => void;
  onContextMenu?: (target: BranchTarget, x: number, y: number) => void;
}) {
  const [options, setOptions] = useState<TreeOptions>(() => ({ ...DEFAULT_OPTIONS, ...getState('branchTree', {}) }));
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['remote', 'tags']));
  const [query, setQuery] = useState('');
  const { byRepo, byDir, showTags } = options;

  useEffect(() => setState('branchTree', options), [options]);
  // Cerrar el menú ⋮ al hacer clic fuera.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);
  const update = (patch: Partial<TreeOptions>) => setOptions((o) => ({ ...o, ...patch }));

  const tree = useMemo(() => {
    const full = buildTree(props.repos, props.favorites, byRepo, byDir, showTags);
    return query.trim() ? filterTree(full, query.trim().toLowerCase()) : full;
  }, [props.repos, props.favorites, byRepo, byDir, showTags, query]);
  const select = (selection: BranchSelection) => props.onSelect(selection, options.clickMode);

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
            n.children ? toggle(n.key) : select({ branch: n.branch ?? null, repoIds: n.repoIds ?? [] })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            if (n.branch === undefined || !props.onContextMenu) return;
            e.stopPropagation();
            props.onContextMenu({ branch: n.branch, repoIds: n.repoIds ?? [], kind: n.kind ?? 'local', current: !!n.current }, e.clientX, e.clientY);
          }}
          title={n.branch ?? n.label}
        >
          <span className="twisty">{n.children ? (open ? '▾' : '▸') : ''}</span>
          {n.colorIndex !== undefined && (
            <span className="dot" style={{ background: `var(--vscode-multigit-repo${n.colorIndex})` }} />
          )}
          {n.branch !== undefined && (
            <span className={`branch-icon${n.current ? ' current' : n.favorite ? ' favorite' : n.branch.startsWith('refs/tags/') ? ' tag' : ''}`}>
              {n.current ? '◆' : n.favorite ? '★' : n.branch.startsWith('refs/tags/') ? '🏷' : '⑂'}
            </span>
          )}
          <span className="tree-label">{n.label}</span>
          {!!n.behind && <span className="track incoming" title={t('{0} incoming commit(s) to pull', n.behind)}>↓{n.behind}</span>}
          {!!n.ahead && <span className="track outgoing" title={t('{0} outgoing commit(s) to push', n.ahead)}>↑{n.ahead}</span>}
          {n.count && <span className="muted small">{n.count}</span>}
        </li>
      );
      return n.children && open ? [row, ...render(n.children, depth + 1)] : [row];
    });

  return (
    <div
      className="branch-tree"
      onContextMenu={(e) => {
        // Sin el menú Cut/Copy/Paste del navegador en el árbol (sí en el buscador).
        if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
      }}
    >
      <div className="pane-toolbar">
        <span className="pane-title">{t('Branches')}</span>
        <button className={`icon-btn${menuOpen ? ' on' : ''}`} title={t('Options')} onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}>
          ⋮
        </button>
        {menuOpen && (
          <div className="menu tree-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title muted small">On Single Click</div>
            <MenuCheck checked={options.clickMode === 'filter'} radio onClick={() => update({ clickMode: 'filter' })}>
              Update Branch Filter
            </MenuCheck>
            <MenuCheck checked={options.clickMode === 'navigate'} radio onClick={() => update({ clickMode: 'navigate' })}>
              Navigate Log to Branch Head
            </MenuCheck>
            <div className="menu-sep" />
            <MenuCheck checked={byDir} onClick={() => update({ byDir: !byDir })}>
              Group by Directory
            </MenuCheck>
            <MenuCheck checked={byRepo} onClick={() => update({ byRepo: !byRepo })}>
              Group by Repository
            </MenuCheck>
            <MenuCheck checked={showTags} onClick={() => update({ showTags: !showTags })}>
              Show Tags
            </MenuCheck>
          </div>
        )}
      </div>
      <input className="tree-search" placeholder={t('Branch or tag')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="tree">
        <li
          className={`tree-row${props.selected.branch === null ? ' selected' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => select({ branch: null, repoIds: [] })}
        >
          <span className="twisty" />
          <span className="tree-label">{t('All branches')}</span>
        </li>
        <li
          className={`tree-row${props.selected.branch === 'HEAD' ? ' selected' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => select({ branch: 'HEAD', repoIds: [] })}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!props.onContextMenu) return;
            e.stopPropagation();
            const currents = [...new Set(props.repos.map((r) => r.current))];
            const common = currents.length === 1 && currents[0] ? currents[0] : null;
            props.onContextMenu({ branch: common ?? 'HEAD', repoIds: [], kind: 'local', current: true, head: true }, e.clientX, e.clientY);
          }}
        >
          <span className="twisty" />
          <span className="branch-icon current">◆</span>
          <span className="tree-label">{t('HEAD (current branch)')}</span>
        </li>
        {render(tree, 0)}
      </ul>
    </div>
  );
}

function MenuCheck(props: { checked: boolean; radio?: boolean; onClick: () => void; children: string }) {
  return (
    <button role={props.radio ? 'menuitemradio' : 'menuitemcheckbox'} aria-checked={props.checked} onClick={props.onClick}>
      <span className="menu-check">{props.checked ? (props.radio ? '●' : '✓') : ''}</span>
      {props.children}
    </button>
  );
}

function buildTree(repos: LogRepoInfo[], favorites: string[], byRepo: boolean, byDir: boolean, showTags: boolean): Node[] {
  const section = (kind: 'local' | 'remote' | 'tags'): Node => {
    // Los tags se filtran como `refs/tags/<nombre>` para no confundirlos con ramas del mismo nombre.
    const namesOf = (r: LogRepoInfo) =>
      kind === 'local' ? r.local : kind === 'remote' ? r.remote : r.tags.map((t) => `refs/tags/${t}`);
    let children: Node[];
    if (byRepo) {
      children = repos.filter((r) => kind !== 'tags' || r.tags.length > 0).map((r) => ({
        key: `${kind}/repo/${r.id}`,
        label: r.name,
        colorIndex: r.colorIndex,
        children: leaves(
          `${kind}/${r.id}`,
          namesOf(r).map((name) => ({
            name,
            repoIds: [r.id],
            current: kind === 'local' && r.current === name,
            ...(kind === 'local' ? r.track?.[name] : undefined),
          })),
          favorites,
          byDir,
        ),
      }));
    } else {
      const union = new Map<string, { repoIds: string[]; current: boolean; ahead: number; behind: number }>();
      for (const r of repos) {
        for (const name of namesOf(r)) {
          const e = union.get(name) ?? { repoIds: [], current: false, ahead: 0, behind: 0 };
          e.repoIds.push(r.id);
          if (kind === 'local' && r.current === name) e.current = true;
          // Suma de todos los repos.
          const t = kind === 'local' ? r.track?.[name] : undefined;
          if (t) {
            e.ahead += t.ahead;
            e.behind += t.behind;
          }
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
          ahead: e.ahead,
          behind: e.behind,
        })),
        favorites,
        byDir,
      );
    }
    return { key: kind, label: kind === 'local' ? 'Local' : kind === 'remote' ? 'Remote' : 'Tags', children };
  };
  const sections = [section('local'), section('remote')];
  if (showTags && repos.some((r) => r.tags.length > 0)) sections.push(section('tags'));
  return sections;
}

interface LeafInput {
  name: string;
  repoIds: string[];
  current: boolean;
  count?: string;
  ahead?: number;
  behind?: number;
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
  const section = prefix.split('/')[0];
  const leaf = (i: LeafInput, label: string): Node => ({
    key: `${prefix}/${i.name}`,
    kind: section === 'tags' ? 'tag' : section === 'remote' ? 'remote' : 'local',
    label,
    branch: i.name,
    repoIds: i.repoIds,
    current: i.current,
    favorite: favorites.includes(i.name) || favorites.includes(short(i.name)),
    count: i.count,
    ahead: i.ahead,
    behind: i.behind,
  });
  const shown = (name: string) => name.replace(/^refs\/tags\//, '');
  if (!byDir) return sorted.map((i) => leaf(i, shown(i.name)));

  const root: Node[] = [];
  for (const i of sorted) {
    const parts = shown(i.name).split('/');
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
