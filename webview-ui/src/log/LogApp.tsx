// Panel Git Log: filtros arriba, ramas a la izquierda, commits al centro y detalle a la derecha.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogBranchAction, LogAction, LogDetails, LogFilters, LogRepoInfo, LogRow } from '../../../src/webview/protocol';
import { fullDate, isoDaysAgo } from '../format';
import { onHostMessage, post } from '../vscode';
import { BranchTree, type BranchTarget } from './BranchTree';
import { CommitList, key } from './CommitList';
import { t } from '../i18n';

const EMPTY: LogFilters = {
  text: '',
  regex: false,
  matchCase: false,
  branch: null,
  user: '',
  since: null,
  until: null,
  paths: [],
  repoIds: [],
  follow: false,
};

type DatePreset = 'all' | 'today' | '7' | '30' | 'custom';

const MENU: Array<{ action: LogAction; label: string } | 'sep'> = [
  { action: 'copyHash', label: 'Copy hash' },
  'sep',
  { action: 'checkout', label: 'Checkout revision' },
  { action: 'cherryPick', label: 'Cherry-pick' },
  { action: 'revert', label: 'Revert commit' },
  { action: 'reset', label: 'Reset current branch to here…' },
  { action: 'interactiveRebase', label: 'Interactively rebase from here…' },
  'sep',
  { action: 'newBranch', label: 'New branch here…' },
  { action: 'newTag', label: 'New tag…' },
];

type BranchMenuItem = { action: LogBranchAction; label: string; when?: (b: BranchTarget) => boolean } | 'sep';

/** El mismo menú que la vista Ramas (con "rama actual" se ocultan las que no aplican). */
const BRANCH_MENU: BranchMenuItem[] = [
  { action: 'checkout', label: 'Checkout', when: (b) => !b.current },
  { action: 'newBranch', label: 'New Branch from Selected…' },
  { action: 'checkoutAndRebase', label: 'Checkout and Rebase onto Current', when: (b) => b.kind === 'local' && !b.current },
  'sep',
  { action: 'compare', label: 'Compare with Current', when: (b) => !b.current },
  { action: 'compareFiles', label: 'Compare Files with Current', when: (b) => !b.current },
  { action: 'diffWorkingTree', label: 'Show Diff with Working Tree' },
  'sep',
  { action: 'rebaseOnto', label: 'Rebase Current onto Selected', when: (b) => !b.current },
  { action: 'merge', label: 'Merge Selected into Current', when: (b) => !b.current },
  'sep',
  { action: 'newWorktree', label: 'New Worktree from Selected…', when: (b) => b.kind !== 'tag' },
  'sep',
  { action: 'update', label: 'Update', when: (b) => b.kind === 'local' },
  { action: 'push', label: 'Push…', when: (b) => b.kind === 'local' },
  { action: 'pullRequests', label: 'Create Pull Requests…', when: (b) => b.kind === 'local' },
  'sep',
  { action: 'rename', label: 'Rename Branch…', when: (b) => b.kind === 'local' },
  { action: 'delete', label: 'Delete', when: (b) => b.kind !== 'tag' && !b.current },
  'sep',
  { action: 'navigate', label: 'Navigate Log to Branch Head' },
];

/** Ítems visibles, sin separadores repetidos ni en los extremos. */
function branchMenuFor(target: BranchTarget): BranchMenuItem[] {
  const items = BRANCH_MENU.filter((i) => i === 'sep' || !i.when || i.when(target));
  return items.filter((i, k) => i !== 'sep' || (k > 0 && k < items.length - 1 && items[k - 1] !== 'sep'));
}

export function LogApp() {
  const [repos, setRepos] = useState<LogRepoInfo[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [me, setMe] = useState({ name: '', email: '' });
  const [filters, setFilters] = useState<LogFilters>(EMPTY);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [details, setDetails] = useState<LogDetails | null>(null);
  const [menu, setMenu] = useState<{ row: LogRow; x: number; y: number } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ target: BranchTarget; x: number; y: number } | null>(null);
  const [showBranches, setShowBranches] = useState(true);
  /** Navigate Log to Branch Head: commit a mostrar cuando aparezca en la lista. */
  const [pendingReveal, setPendingReveal] = useState<{ key: string; pages: number } | null>(null);
  const [scrollTo, setScrollTo] = useState<{ index: number; token: number } | null>(null);
  const [showDetails, setShowDetails] = useState(true);

  // Campos de texto con edición local (se aplican con debounce / Enter).
  const [text, setText] = useState('');
  const [user, setUser] = useState('');
  const [paths, setPaths] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');

  useEffect(
    () =>
      onHostMessage((m) => {
        switch (m.type) {
          case 'log/init':
            setRepos(m.payload.repos);
            setMe(m.payload.me);
            setFavorites(m.payload.favorites);
            syncFilters(m.payload.filters);
            break;
          case 'log/filters':
            syncFilters(m.payload);
            break;
          case 'log/rows':
            generation.current = m.payload.generation;
            setRows((prev) => (m.payload.reset ? m.payload.rows : [...prev, ...m.payload.rows]));
            setHasMore(m.payload.hasMore);
            if (m.payload.reset) {
              setSelected(null);
              setDetails(null);
            }
            break;
          case 'log/loading':
            generation.current = Math.max(generation.current, m.payload.generation);
            setLoading(m.payload.loading);
            break;
          case 'log/details':
            setDetails(m.payload);
            break;
          case 'log/reveal':
            setPendingReveal({ key: `${m.payload.repoId}@${m.payload.hash}`, pages: 0 });
            break;
        }
      }),
    [],
  );

  function syncFilters(f: LogFilters): void {
    setFilters(f);
    setText(f.text);
    setUser(f.user);
    setPaths(f.paths.join(', '));
  }

  const apply = (patch: Partial<LogFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    post({ type: 'log/setFilters', payload: next });
  };

  // Debounce del texto.
  useEffect(() => {
    if (text === filters.text) return;
    const t = setTimeout(() => apply({ text }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const authors = useMemo(() => [...new Set(rows.map((r) => r.author))].sort().slice(0, 200), [rows]);
  const branchOptions = useMemo(() => {
    const local = [...new Set(repos.flatMap((r) => r.local))].sort();
    const remote = [...new Set(repos.flatMap((r) => r.remote))].sort();
    return { local, remote };
  }, [repos]);

  // Navigate Log to Branch Head: si el commit ya está cargado se selecciona; si no, se cargan más
  // páginas (hasta 40, unos 12 000 commits) mientras haya.
  useEffect(() => {
    if (!pendingReveal) return;
    const index = rows.findIndex((r) => `${r.repoId}@${r.hash}` === pendingReveal.key);
    if (index >= 0) {
      select(rows[index]!);
      setScrollTo({ index, token: Date.now() });
      setPendingReveal(null);
    } else if (hasMore && pendingReveal.pages < 40) {
      if (!loading) {
        setPendingReveal({ ...pendingReveal, pages: pendingReveal.pages + 1 });
        post({ type: 'log/loadMore', payload: { generation: generation.current } });
      }
    } else {
      setPendingReveal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal, rows, hasMore, loading]);

  const select = (row: LogRow) => {
    setSelected(row);
    setDetails(null);
    post({ type: 'log/select', payload: { repoId: row.repoId, hash: row.hash } });
  };

  const setDate = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset === 'custom') return;
    const since = preset === 'all' ? null : preset === 'today' ? isoDaysAgo(0) : isoDaysAgo(Number(preset));
    apply({ since, until: null });
  };

  const selectedKey = selected ? key(selected) : null;
  const detailsMatch = details && selected && details.hash === selected.hash && details.repoId === selected.repoId;

  return (
    <div
      className="log"
      onClick={() => {
        setMenu(null);
        setBranchMenu(null);
      }}
    >
      {/* ---------------------------------------------------- filtros */}
      <div className="log-filters">
        <button className={`icon-btn${showBranches ? ' on' : ''}`} title={t('Show branches')} onClick={() => setShowBranches((v) => !v)}>
          ☰
        </button>
        <div className="search">
          <input
            value={text}
            placeholder={t('Text or hash')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply({ text })}
          />
          <button className={`toggle${filters.regex ? ' on' : ''}`} title={t('Regular expression')} onClick={() => apply({ regex: !filters.regex })}>
            .*
          </button>
          <button className={`toggle${filters.matchCase ? ' on' : ''}`} title={t('Match case')} onClick={() => apply({ matchCase: !filters.matchCase })}>
            Aa
          </button>
        </div>
        <label className="filter">
          <span className="muted">Branch</span>
          <select
            value={filters.branch ?? ''}
            onChange={(e) => apply({ branch: e.target.value || null, repoIds: [] })}
          >
            <option value="">{t('All')}</option>
            <option value="HEAD">{t('HEAD (current)')}</option>
            <optgroup label="Local">
              {branchOptions.local.map((b) => (
                <option key={`l:${b}`} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
            <optgroup label="Remote">
              {branchOptions.remote.map((b) => (
                <option key={`r:${b}`} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="filter">
          <span className="muted">User</span>
          <input
            list="log-authors"
            value={user}
            placeholder={t('All')}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply({ user })}
            onBlur={() => user !== filters.user && apply({ user })}
          />
          <datalist id="log-authors">
            {authors.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          {me.email && (
            <button
              className={`toggle${filters.user === me.email ? ' on' : ''}`}
              title={t('Only my commits ({0})', me.email)}
              onClick={() => {
                const next = filters.user === me.email ? '' : me.email;
                setUser(next);
                apply({ user: next });
              }}
            >
              {t('Me')}
            </button>
          )}
        </label>
        <label className="filter">
          <span className="muted">Date</span>
          <select value={datePreset} onChange={(e) => setDate(e.target.value as DatePreset)}>
            <option value="all">{t('All')}</option>
            <option value="today">{t('Today')}</option>
            <option value="7">{t('Last 7 days')}</option>
            <option value="30">{t('Last 30 days')}</option>
            <option value="custom">{t('Range…')}</option>
          </select>
          {datePreset === 'custom' && (
            <>
              <input type="date" value={filters.since ?? ''} onChange={(e) => apply({ since: e.target.value || null })} />
              <input type="date" value={filters.until ?? ''} onChange={(e) => apply({ until: e.target.value || null })} />
            </>
          )}
        </label>
        <label className="filter">
          <span className="muted">Paths</span>
          <input
            value={paths}
            placeholder={t('Paths…')}
            onChange={(e) => setPaths(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply({ paths: splitPaths(paths) })}
            onBlur={() => paths !== filters.paths.join(', ') && apply({ paths: splitPaths(paths) })}
          />
        </label>
        <label className="filter">
          <span className="muted">Repo</span>
          <select
            value={filters.repoIds.length === 1 ? filters.repoIds[0] : ''}
            onChange={(e) => apply({ repoIds: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">{t('All')}</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {loading && <span className="muted small">{t('Loading…')}</span>}
        <span className="muted small">{t('{0} commits', `${rows.length}${hasMore ? '+' : ''}`)}</span>
        <button className="icon-btn" title={t('Reset filters')} onClick={() => { syncFilters(EMPTY); setDatePreset('all'); post({ type: 'log/setFilters', payload: EMPTY }); }}>
          ✕
        </button>
        <button className="icon-btn" title={t('Refresh')} onClick={() => post({ type: 'log/refresh', payload: {} })}>
          ↻
        </button>
        <button className={`icon-btn${showDetails ? ' on' : ''}`} title={t('Show details')} onClick={() => setShowDetails((v) => !v)}>
          ▤
        </button>
      </div>

      {/* ---------------------------------------------------- paneles */}
      <div className={`log-body${showBranches ? '' : ' no-branches'}${showDetails ? '' : ' no-details'}`}>
        {showBranches && (
          <BranchTree
            onContextMenu={(target, x, y) => {
              setMenu(null);
              setBranchMenu({ target, x, y });
            }}
            repos={repos}
            favorites={favorites}
            selected={{ branch: filters.branch, repoIds: filters.repoIds }}
            onSelect={(s, mode) => {
              if (mode === 'navigate' && s.branch) {
                post({ type: 'log/resolveRef', payload: { ref: s.branch, repoIds: s.repoIds } });
              } else {
                apply({ branch: s.branch, repoIds: s.repoIds });
              }
            }}
          />
        )}
        <CommitList
          rows={rows}
          repos={repoMap}
          hasMore={hasMore}
          loading={loading}
          selected={selectedKey}
          onSelect={select}
          onLoadMore={() => post({ type: 'log/loadMore', payload: { generation: generation.current } })}
          onContextMenu={(row, x, y) => {
            setBranchMenu(null);
            setMenu({ row, x, y });
          }}
          scrollTo={scrollTo}
        />
        {showDetails && (
          <aside className="log-details">
            {!selected && <div className="muted pad">{t('Choose a commit to see its details.')}</div>}
            {selected && (
              <>
                <div className="detail-head">
                  <span className="dot" style={{ background: `var(--vscode-multigit-repo${repoMap.get(selected.repoId)?.colorIndex ?? 0})` }} />
                  <strong>{repoMap.get(selected.repoId)?.name}</strong>
                  <button className="link hash-link" title={t('Copy hash')} onClick={() => post({ type: 'log/action', payload: { action: 'copyHash', repoId: selected.repoId, hash: selected.hash } })}>
                    {selected.shortHash}
                  </button>
                </div>
                <div className="detail-message">{detailsMatch ? details!.body : selected.subject}</div>
                <div className="detail-meta small">
                  <div>
                    {selected.author} &lt;{selected.email}&gt; · {fullDate(selected.date)}
                  </div>
                  {detailsMatch && details!.committer && details!.committer !== selected.author && (
                    <div className="muted">
                      commit: {details!.committer} · {fullDate(details!.commitTime)}
                    </div>
                  )}
                  {selected.refs.length > 0 && (
                    <div className="detail-refs">
                      {selected.refs.map((r) => (
                        <span key={`${r.kind}:${r.name}`} className={`ref ref-${r.kind}`}>
                          {r.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="pane-header small">
                  {detailsMatch ? t('{0} file(s) — double-click to see the diff', details!.files.length) : t('Loading files…')}
                </div>
                <ul className="list">
                  {detailsMatch &&
                    details!.files.map((f) => (
                      <li
                        key={`${f.status}:${f.oldPath ?? ''}:${f.path}`}
                        className="row file-row"
                        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                        onDoubleClick={() => post({ type: 'log/openDiff', payload: { repoId: selected.repoId, hash: selected.hash, file: f } })}
                      >
                        <span className={`status status-${f.status}`}>{f.status}</span>
                        <span className="file-name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                        <span className="muted small">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ---------------------------------------------------- menú contextual de una rama */}
      {branchMenu && (
        <div
          className="menu context"
          style={{ left: Math.min(branchMenu.x, window.innerWidth - 260), top: Math.max(4, Math.min(branchMenu.y, window.innerHeight - 470)) }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-title muted small">{branchMenu.target.branch.replace(/^refs\/tags\//, '')}</div>
          {branchMenuFor(branchMenu.target).map((item, i) =>
            item === 'sep' ? (
              <div key={`sep${i}`} className="menu-sep" />
            ) : (
              <button
                key={item.action}
                role="menuitem"
                onClick={() => {
                  setBranchMenu(null);
                  post({ type: 'log/branchAction', payload: { action: item.action, branch: branchMenu.target.branch, repoIds: branchMenu.target.repoIds } });
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}

      {/* ---------------------------------------------------- menú contextual */}
      {menu && (
        <div className="menu context" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 260) }} role="menu">
          <div className="menu-title muted small">
            {repoMap.get(menu.row.repoId)?.name} · {menu.row.shortHash}
          </div>
          {MENU.map((item, i) =>
            item === 'sep' ? (
              <div key={`sep${i}`} className="menu-sep" />
            ) : (
              <button
                key={item.action}
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  post({ type: 'log/action', payload: { action: item.action, repoId: menu.row.repoId, hash: menu.row.hash } });
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function splitPaths(text: string): string[] {
  return text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}
