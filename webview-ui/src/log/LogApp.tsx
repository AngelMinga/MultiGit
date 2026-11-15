// Panel Git Log: filtros arriba, ramas a la izquierda, commits al centro y detalle a la derecha.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogBranchAction, LogAction, LogDetails, LogFileAction, LogFilters, LogMultiAction, LogRepoInfo, LogRow, PushFile } from '../../../src/webview/protocol';
import { fullDate, isoDaysAgo } from '../format';
import { onHostMessage, post } from '../vscode';
import { BranchTree, type BranchTarget } from './BranchTree';
import { FileTree } from './FileTree';
import { MessageBody } from '../MessageBody';
import { CommitList, key, type SelectMode } from './CommitList';
import { RepoFilter } from './RepoFilter';
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
  { action: 'createPatch', label: 'Create Patch…' },
  { action: 'showRepoAtRevision', label: 'Show Repository at Revision…' },
  { action: 'openOnRemote', label: 'Open on {web}' },
  'sep',
  { action: 'checkout', label: 'Checkout revision' },
  { action: 'cherryPick', label: 'Cherry-pick' },
  { action: 'revert', label: 'Revert commit' },
  { action: 'reset', label: 'Reset current branch to here…' },
  'sep',
  { action: 'undoCommit', label: 'Undo Commit…' },
  { action: 'editMessage', label: 'Edit Commit Message…' },
  { action: 'fixup', label: 'Fixup…' },
  { action: 'squashInto', label: 'Squash Into…' },
  { action: 'drop', label: 'Drop Commit…' },
  { action: 'interactiveRebase', label: 'Interactively rebase from here…' },
  'sep',
  { action: 'pushUpTo', label: 'Push All up to Here…' },
  'sep',
  { action: 'newBranch', label: 'New branch here…' },
  { action: 'newTag', label: 'New tag…' },
  'sep',
  { action: 'goParent', label: 'Go to Parent Commit' },
  { action: 'goChild', label: 'Go to Child Commit' },
];

type MultiItem = { action: LogMultiAction; label: string; when?: (s: { repos: number; count: number }) => boolean } | 'sep';

/** Menú con varios commits elegidos (como IntelliJ): lo que no aplica a la selección se oculta. */
const MULTI_MENU: MultiItem[] = [
  { action: 'copyHashes', label: 'Copy hashes' },
  { action: 'createPatch', label: 'Create Patch…' },
  { action: 'compareVersions', label: 'Compare Versions', when: (s) => s.repos === 1 && s.count === 2 },
  'sep',
  { action: 'cherryPick', label: 'Cherry-pick' },
  { action: 'revert', label: 'Revert commits' },
  'sep',
  { action: 'squash', label: 'Squash Commits…', when: (s) => s.repos === 1 },
];

type FileItem = { action: LogFileAction; label: string; when?: (f: PushFile, web: string | null) => boolean } | 'sep';

/** Menú de un archivo del detalle del commit. */
const FILE_MENU: FileItem[] = [
  { action: 'showDiff', label: 'Show Diff' },
  { action: 'compareWithLocal', label: 'Compare with Local' },
  { action: 'openRevision', label: 'Open Repository Version', when: (f) => f.status !== 'D' },
  'sep',
  { action: 'getFromRevision', label: 'Get from Revision…' },
  'sep',
  { action: 'showHistory', label: 'Show History', when: (f) => f.status !== 'D' },
  { action: 'openOnRemote', label: 'Open on {web}', when: (_f, web) => !!web },
];

/** Quita separadores repetidos o en los extremos. */
function tidy<T>(items: Array<T | 'sep'>): Array<T | 'sep'> {
  return items.filter((i, k) => i !== 'sep' || (k > 0 && k < items.length - 1 && items[k - 1] !== 'sep'));
}

type BranchMenuItem = { action: LogBranchAction; label: string; when?: (b: BranchTarget) => boolean } | 'sep';

/** El mismo menú que la vista Ramas (con "rama actual" se ocultan las que no aplican). */
const BRANCH_MENU: BranchMenuItem[] = [
  { action: 'checkout', label: 'Checkout', when: (b) => !b.current },
  { action: 'newBranch', label: 'New Branch from Selected…', when: (b) => !b.head },
  { action: 'newBranch', label: 'New Branch from Current…', when: (b) => !!b.head },
  { action: 'checkoutAndRebase', label: 'Checkout and Rebase onto Current', when: (b) => b.kind === 'local' && !b.current },
  'sep',
  { action: 'compare', label: 'Compare with Current', when: (b) => !b.current },
  { action: 'compareFiles', label: 'Compare Files with Current', when: (b) => !b.current },
  { action: 'diffWorkingTree', label: 'Show Diff with Working Tree' },
  'sep',
  { action: 'rebaseOnto', label: 'Rebase Current onto Selected', when: (b) => !b.current },
  { action: 'merge', label: 'Merge Selected into Current', when: (b) => !b.current },
  { action: 'pullMerge', label: 'Pull into Current Using Merge', when: (b) => b.kind === 'remote' },
  { action: 'pullRebase', label: 'Pull into Current Using Rebase', when: (b) => b.kind === 'remote' },
  'sep',
  { action: 'newWorktree', label: 'New Worktree from Selected…', when: (b) => b.kind !== 'tag' && !b.current },
  'sep',
  { action: 'update', label: 'Update', when: (b) => b.kind === 'local' },
  { action: 'push', label: 'Push…', when: (b) => b.kind === 'local' },
  { action: 'pullRequests', label: 'Create Pull Requests…', when: (b) => b.kind === 'local' },
  'sep',
  { action: 'rename', label: 'Rename Branch…', when: (b) => b.kind === 'local' && b.branch !== 'HEAD' },
  { action: 'delete', label: 'Delete', when: (b) => b.kind !== 'tag' && !b.current },
  { action: 'pushTag', label: 'Push Tag…', when: (b) => b.kind === 'tag' },
  { action: 'deleteTag', label: 'Delete Tag…', when: (b) => b.kind === 'tag' },
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
  /** Commits elegidos (claves `repo@hash`); `selected` es el principal (el del detalle). */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [details, setDetails] = useState<LogDetails | null>(null);
  /** Grupos de archivos abiertos en el detalle de un merge (`hash:índice`): empiezan plegados. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [menu, setMenu] = useState<{ row: LogRow; x: number; y: number } | null>(null);
  const [fileMenu, setFileMenu] = useState<{ file: PushFile; base: string | null | undefined; x: number; y: number } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ target: BranchTarget; x: number; y: number } | null>(null);
  // Los menús contextuales se cierran al pulsar fuera (también fuera del panel: el webview pierde el
  // foco), con Escape, al desplazar o al cambiar el tamaño.
  useEffect(() => {
    if (!menu && !branchMenu && !fileMenu) return;
    const close = () => {
      setMenu(null);
      setBranchMenu(null);
      setFileMenu(null);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu.context')) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu, branchMenu, fileMenu]);
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
              setSelection(new Set());
              anchor.current = null;
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
    setSelection(new Set([key(row)]));
    anchor.current = key(row);
    setDetails(null);
    post({ type: 'log/select', payload: { repoId: row.repoId, hash: row.hash } });
  };

  /** Clic en un commit: normal, Ctrl/Cmd (añadir o quitar) o Mayús (rango desde el último clic). */
  const onSelect = (row: LogRow, mode: SelectMode) => {
    const k = key(row);
    if (mode === 'single' || !anchor.current) return select(row);
    if (mode === 'toggle') {
      const next = new Set(selection);
      if (next.has(k) && next.size > 1) {
        next.delete(k);
        setSelection(next);
        if (selected && key(selected) === k) {
          const other = rows.find((r) => next.has(key(r)));
          if (other) openDetails(other);
        }
        return;
      }
      next.add(k);
      setSelection(next);
      anchor.current = k;
      openDetails(row);
      return;
    }
    const from = rows.findIndex((r) => key(r) === anchor.current);
    const to = rows.findIndex((r) => key(r) === k);
    if (from < 0 || to < 0) return select(row);
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelection(new Set(rows.slice(a, b + 1).map(key)));
    openDetails(row);
  };

  /** Cambia el commit del detalle sin tocar la selección. */
  const openDetails = (row: LogRow) => {
    setSelected(row);
    setDetails(null);
    post({ type: 'log/select', payload: { repoId: row.repoId, hash: row.hash } });
  };

  /** Commits elegidos en el orden del log (del más nuevo al más viejo). */
  const chosen = useMemo(() => rows.filter((r) => selection.has(key(r))), [rows, selection]);

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
        setFileMenu(null);
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
            onChange={(e) => apply({ branch: e.target.value || null })}
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
        <div className="filter">
          <span className="muted">Repo</span>
          <RepoFilter repos={repos} value={filters.repoIds} onChange={(repoIds) => apply({ repoIds })} />
        </div>
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
                // Como IntelliJ: solo cambia la rama; el filtro Repo lo decide el usuario.
                apply({ branch: s.branch });
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
          selection={selection}
          onSelect={onSelect}
          onLoadMore={() => post({ type: 'log/loadMore', payload: { generation: generation.current } })}
          onContextMenu={(row, x, y) => {
            setBranchMenu(null);
            setFileMenu(null);
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
                {/* Archivos arriba (en un merge, un grupo por padre) e información del commit abajo, como IntelliJ. */}
                <ul className="list detail-files">
                  {!detailsMatch && <li className="muted pad">{t('Loading files…')}</li>}
                  {detailsMatch &&
                    details!.groups.map((g, i) => {
                      const key = `${selected.hash}:${i}`;
                      const open = openGroups.has(key);
                      return [
                        g.title || details!.groups.length > 1 ? (
                          <li key={`g:${key}`} className="row file-row ft-group" onClick={() => toggleGroup(key)} title={g.title}>
                            <span className="twisty">{open ? '▾' : '▸'}</span>
                            <span className="file-name">{g.title}</span>
                            <span className="muted small">{t('{0} file(s)', g.files.length)}</span>
                          </li>
                        ) : (
                          <li key={`g:${key}`} className="row file-row ft-group muted small">
                            {t('{0} file(s) — double-click to see the diff', g.files.length)}
                          </li>
                        ),
                        open || !g.title ? (
                          <FileTree
                            key={`t:${key}`}
                            files={g.files}
                            depth={g.title ? 1 : 0}
                            collapsed={!!g.title}
                            onOpen={(f) => post({ type: 'log/openDiff', payload: { repoId: selected.repoId, hash: selected.hash, file: f, base: g.base } })}
                            onContextMenu={(f, x, y) => {
                              setMenu(null);
                              setBranchMenu(null);
                              // En un commit normal el diff es contra su padre (sin base explícita).
                              setFileMenu({ file: f, base: details!.groups.length > 1 ? g.base : undefined, x, y });
                            }}
                          />
                        ) : null,
                      ];
                    })}
                </ul>
                <div className="detail-info">
                  <MessageBody text={detailsMatch ? details!.body : selected.subject} />
                  <div className="detail-meta small">
                    <div>
                      <span className="dot" style={{ background: `var(--vscode-multigit-repo${repoMap.get(selected.repoId)?.colorIndex ?? 0})` }} /> {selected.shortHash}{' '}
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
                    {detailsMatch && (details!.inHead || details!.branches.length > 0) && (
                      <div className="muted">
                        {(() => {
                          const names = [...(details!.inHead ? ['HEAD'] : []), ...details!.branches];
                          const shown = names.slice(0, 6).join(', ');
                          return t('In {0} branch(es): {1}', names.length, names.length > 6 ? `${shown}, …` : shown);
                        })()}
                      </div>
                    )}
                  </div>
                </div>
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
          <div className="menu-title muted small">
            {branchMenu.target.head
              ? branchMenu.target.branch === 'HEAD'
                ? t('HEAD (current branch)')
                : `HEAD → ${branchMenu.target.branch}`
              : branchMenu.target.branch.replace(/^refs\/tags\//, '')}
          </div>
          {branchMenuFor(branchMenu.target).map((item, i) =>
            item === 'sep' ? (
              <div key={`sep${i}`} className="menu-sep" />
            ) : (
              <button
                key={`${item.action}:${item.label}`}
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

      {/* ---------------------------------------------------- menú contextual de varios commits */}
      {menu && chosen.length > 1 && selection.has(key(menu.row)) && (() => {
        const info = { repos: new Set(chosen.map((r) => r.repoId)).size, count: chosen.length };
        return (
          <div className="menu context" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.max(4, Math.min(menu.y, window.innerHeight - 260)) }} role="menu">
            <div className="menu-title muted small">
              {info.repos === 1 ? t('{0} commits in {1}', info.count, repoMap.get(chosen[0]!.repoId)?.name ?? '') : t('{0} commits in {1} repositories', info.count, info.repos)}
            </div>
            {tidy(MULTI_MENU.filter((i) => i === 'sep' || !i.when || i.when(info))).map((item, i) =>
              item === 'sep' ? (
                <div key={`sep${i}`} className="menu-sep" />
              ) : (
                <button
                  key={item.action}
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    post({ type: 'log/multiAction', payload: { action: item.action, commits: chosen.map((r) => ({ repoId: r.repoId, hash: r.hash })) } });
                  }}
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
        );
      })()}

      {/* ---------------------------------------------------- menú contextual de un commit */}
      {menu && !(chosen.length > 1 && selection.has(key(menu.row))) && (() => {
        const web = repoMap.get(menu.row.repoId)?.web ?? null;
        const items = tidy(MENU.filter((i) => i === 'sep' || i.action !== 'openOnRemote' || web));
        return (
          <div className="menu context" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.max(4, Math.min(menu.y, window.innerHeight - 580)) }} role="menu">
            <div className="menu-title muted small">
              {repoMap.get(menu.row.repoId)?.name} · {menu.row.shortHash}
            </div>
            {items.map((item, i) =>
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
                  {item.label.replace('{web}', web ?? '')}
                </button>
              ),
            )}
          </div>
        );
      })()}

      {/* ---------------------------------------------------- menú contextual de un archivo del commit */}
      {fileMenu && selected && (() => {
        const web = repoMap.get(selected.repoId)?.web ?? null;
        const items = tidy(FILE_MENU.filter((i) => i === 'sep' || !i.when || i.when(fileMenu.file, web)));
        return (
          <div className="menu context" style={{ left: Math.min(fileMenu.x, window.innerWidth - 240), top: Math.max(4, Math.min(fileMenu.y, window.innerHeight - 240)) }} role="menu">
            <div className="menu-title muted small">{fileMenu.file.path.split('/').pop()}</div>
            {items.map((item, i) =>
              item === 'sep' ? (
                <div key={`sep${i}`} className="menu-sep" />
              ) : (
                <button
                  key={item.action}
                  role="menuitem"
                  onClick={() => {
                    setFileMenu(null);
                    post({
                      type: 'log/fileAction',
                      payload: { action: item.action, repoId: selected.repoId, hash: selected.hash, file: fileMenu.file, ...(fileMenu.base !== undefined ? { base: fileMenu.base } : {}) },
                    });
                  }}
                >
                  {item.label.replace('{web}', web ?? '')}
                </button>
              ),
            )}
          </div>
        );
      })()}
    </div>
  );
}

function splitPaths(text: string): string[] {
  return text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}
