// Diálogo Rollback Changes, como el de IntelliJ: árbol repo → carpetas (compactadas, `lib/l10n`)
// → archivos con casillas (con estado parcial en carpetas), contador, "Delete local copies of
// added files" y Close / Rollback. Doble clic o Show Diff → diff del archivo contra HEAD.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { RollbackFile, RollbackRepo, RollbackState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

interface TreeNode {
  id: string;
  label: string;
  /** Claves `${repoId}\0${path}` de los archivos bajo este nodo. */
  keys: string[];
  children: TreeNode[];
  repo?: RollbackRepo;
  file?: RollbackFile;
  repoId: string;
}

const keyOf = (repoId: string, path: string) => `${repoId}\0${path}`;
const isAdded = (f: RollbackFile) => f.status === 'A' || f.status === 'C';

export function RollbackDialog() {
  const [state, setState] = useState<RollbackState>({ repos: [], selected: [], busy: true });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [deleteAdded, setDeleteAdded] = useState(false);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'rollback/state') return;
        setState(m.payload);
        setChecked(new Set(m.payload.selected));
      }),
    [],
  );

  const tree = useMemo(() => state.repos.map(buildRepoNode), [state.repos]);
  const nodes = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (n: TreeNode) => {
      map.set(n.id, n);
      n.children.forEach(walk);
    };
    tree.forEach(walk);
    return map;
  }, [tree]);
  const files = useMemo(
    () => new Map(state.repos.flatMap((r) => r.files.map((f) => [keyOf(r.id, f.path), f] as const))),
    [state.repos],
  );

  const selectedFiles = [...checked].map((k) => files.get(k)).filter((f): f is RollbackFile => !!f);
  const anyAdded = selectedFiles.some(isAdded);
  const total = files.size;

  const toggleKeys = (keys: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const toggleOpen = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openDiff = (n: TreeNode | undefined) => {
    if (n?.file) post({ type: 'rollback/openDiff', payload: { repoId: n.repoId, path: n.file.path } });
  };
  const allIds = [...nodes.values()].filter((n) => n.children.length > 0).map((n) => n.id);

  const render = (list: TreeNode[], depth: number): ReactElement[] =>
    list.flatMap((n) => {
      const open = !collapsed.has(n.id);
      const count = n.keys.filter((k) => checked.has(k)).length;
      const row = (
        <li
          key={n.id}
          className={`tree-row rb-row${focused === n.id ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => setFocused(n.id)}
          onDoubleClick={() => (n.file ? openDiff(n) : toggleOpen(n.id))}
          title={n.file ? (n.file.origPath ? `${n.file.origPath} → ${n.file.path}` : n.file.path) : undefined}
        >
          <span
            className="twisty"
            onClick={(e) => {
              e.stopPropagation();
              if (n.children.length) toggleOpen(n.id);
            }}
          >
            {n.children.length ? (open ? '▾' : '▸') : ''}
          </span>
          <TriCheckbox
            checked={count > 0 && count === n.keys.length}
            indeterminate={count > 0 && count < n.keys.length}
            disabled={state.busy}
            onChange={(on) => toggleKeys(n.keys, on)}
            label={n.label}
          />
          {n.repo && <span className="dot" style={{ background: `var(--vscode-multigit-repo${n.repo.colorIndex})` }} />}
          {!n.repo && !n.file && <span className="rb-icon">🗀</span>}
          <span className={`tree-label${n.file ? ` rb-status-${n.file.status}` : ''}`}>{n.label}</span>
          {!n.file && <span className="muted small">{t('{0} file(s)', n.keys.length)}</span>}
          {n.file?.origPath && <span className="muted small">← {n.file.origPath}</span>}
        </li>
      );
      return n.children.length && open ? [row, ...render(n.children, depth + 1)] : [row];
    });

  return (
    <div className="rollback" onKeyDown={(e) => e.key === 'Escape' && post({ type: 'rollback/close', payload: {} })}>
      <div className="pane-toolbar rb-toolbar">
        <button className="icon-btn" title={t('Show Diff (double-click a file)')} disabled={!nodes.get(focused ?? '')?.file} onClick={() => openDiff(nodes.get(focused ?? ''))}>
          ⇄
        </button>
        <span className="spacer" />
        <button className="icon-btn" title={t('Expand all')} onClick={() => setCollapsed(new Set())}>
          ⊞
        </button>
        <button className="icon-btn" title={t('Collapse all')} onClick={() => setCollapsed(new Set(allIds))}>
          ⊟
        </button>
      </div>
      <div className="rb-body">
        <ul className="tree">
          {total > 0 && (
            <li className="tree-row rb-row" style={{ paddingLeft: 6 }}>
              <span className="twisty" />
              <TriCheckbox
                checked={checked.size > 0 && selectedFiles.length === total}
                indeterminate={selectedFiles.length > 0 && selectedFiles.length < total}
                disabled={state.busy}
                onChange={(on) => setChecked(on ? new Set(files.keys()) : new Set())}
                label="Changes"
              />
              <span className="tree-label rb-strong">Changes</span>
              <span className="muted small">{t('{0} file(s)', total)}</span>
            </li>
          )}
          {render(tree, 1)}
          {total === 0 && !state.busy && <li className="muted pad">{t('There are no tracked changes to roll back.')}</li>}
        </ul>
      </div>
      <div className="rb-summary small">
        <span className="link-text">{describe(selectedFiles)}</span>
      </div>
      <footer className="push-footer">
        <label className={`check${anyAdded ? '' : ' disabled'}`} title={t('Otherwise, added files are left untracked')}>
          <input type="checkbox" checked={deleteAdded && anyAdded} disabled={!anyAdded || state.busy} onChange={(e) => setDeleteAdded(e.target.checked)} />
          <span>Delete local copies of added files</span>
        </label>
        <span className="spacer" />
        {state.busy && <span className="muted">{t('Working…')}</span>}
        <button className="secondary" onClick={() => post({ type: 'rollback/close', payload: {} })}>
          Close
        </button>
        <button
          className="primary"
          disabled={state.busy || selectedFiles.length === 0}
          onClick={() => post({ type: 'rollback/run', payload: { keys: [...checked].filter((k) => files.has(k)), deleteAdded: deleteAdded && anyAdded } })}
        >
          Rollback
        </button>
      </footer>
    </div>
  );
}

function TriCheckbox(props: { checked: boolean; indeterminate: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={t('Include {0}', props.label)}
      onClick={(e) => e.stopPropagation()}
      onChange={() => props.onChange(!props.checked)}
    />
  );
}

/** Repo → carpetas (las cadenas de una sola subcarpeta se compactan: `lib/l10n`) → archivos. */
function buildRepoNode(repo: RollbackRepo): TreeNode {
  interface Dir {
    dirs: Map<string, Dir>;
    files: RollbackFile[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of repo.files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.dirs.get(p);
      if (!next) dir.dirs.set(p, (next = { dirs: new Map(), files: [] }));
      dir = next;
    }
    dir.files.push(f);
  }
  const toNodes = (dir: Dir, prefix: string): TreeNode[] => {
    const dirs = [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, d]) => {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [childName, child] = [...d.dirs.entries()][0]!;
        label += `/${childName}`;
        path += `/${childName}`;
        d = child;
      }
      const children = toNodes(d, path);
      return { id: `${repo.id}\0dir:${path}`, label, children, keys: children.flatMap((c) => c.keys), repoId: repo.id } satisfies TreeNode;
    });
    const files = [...dir.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        id: keyOf(repo.id, f.path),
        label: f.path.slice(f.path.lastIndexOf('/') + 1),
        children: [],
        keys: [keyOf(repo.id, f.path)],
        file: f,
        repoId: repo.id,
      }));
    return [...dirs, ...files];
  };
  const children = toNodes(root, '');
  return { id: `${repo.id}\0repo`, label: repo.name, children, keys: children.flatMap((c) => c.keys), repo, repoId: repo.id };
}

function describe(files: RollbackFile[]): string {
  const count = (pred: (f: RollbackFile) => boolean) => files.filter(pred).length;
  const parts = [
    [count((f) => f.status === 'M' || f.status === 'T'), (n: number) => t('{0} modified', n)],
    [count(isAdded), (n: number) => t('{0} added', n)],
    [count((f) => f.status === 'D'), (n: number) => t('{0} deleted', n)],
    [count((f) => f.status === 'R'), (n: number) => t('{0} renamed', n)],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => label(n));
  return text.length ? text.join(', ') : t('no files selected');
}
