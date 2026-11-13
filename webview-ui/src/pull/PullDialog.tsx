// Pull, como el diálogo de IntelliJ: [repositorio ▾] git pull [remote ▾] [rama ▾] y el modo.
// La rama se elige en una lista con búsqueda; con "Todos" se puede usar el upstream de cada repo.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PullModeName, PullState } from '../../../src/webview/protocol';
import { getState, onHostMessage, post, setState } from '../vscode';
import { t } from '../i18n';

/** Valor especial de la rama: el upstream de cada repo. */
const UPSTREAM = '\0upstream';

export function PullDialog() {
  const [state, setPullState] = useState<PullState | null>(null);
  const [scopeId, setScopeId] = useState('*');
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<PullModeName>(() => getState<PullModeName>('pullMode', 'merge'));
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setState('pullMode', mode), [mode]);
  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'pull/state') return;
        setPullState(m.payload);
        setScopeId(m.payload.initialScope);
      }),
    [],
  );

  const scope = state?.scopes.find((s) => s.id === scopeId) ?? state?.scopes[0];
  const remoteView = scope?.remotes.find((r) => r.name === remote) ?? scope?.remotes[0];

  // Al cambiar de repositorio o remote: remote por defecto y su upstream (o el de cada repo).
  useEffect(() => {
    if (!scope) return;
    const r = scope.remotes.find((x) => x.name === remote) ?? scope.remotes[0];
    if (r && r.name !== remote) setRemote(r.name);
    const next = r?.common ?? (scope.total > 1 && r?.branches.some((b) => b.upstream > 0) ? UPSTREAM : '');
    setBranch(next);
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, remote, state]);

  const options = useMemo(() => {
    if (!remoteView || !scope) return [];
    const list: Array<{ value: string; label: string; note: string }> = [];
    if (scope.total > 1 && !remoteView.common) list.push({ value: UPSTREAM, label: t('Upstream of each repository'), note: t('each repository pulls the branch it tracks') });
    for (const b of remoteView.branches) {
      const notes = [
        b.upstream === scope.total ? 'upstream' : b.upstream ? t('upstream of {0}', b.upstream) : '',
        b.exists < scope.total ? t('exists in {0}/{1}', b.exists, scope.total) : '',
      ].filter(Boolean);
      list.push({ value: b.name, label: b.name, note: notes.join(' · ') });
    }
    const q = query.trim().toLowerCase();
    return q ? list.filter((o) => o.label.toLowerCase().includes(q)) : list;
  }, [remoteView, scope, query]);

  if (!state || !scope) return <p className="muted pad">{t('Loading…')}</p>;

  const label = (value: string) => (value === UPSTREAM ? t('Upstream of each repository') : value);
  const choose = (value: string) => {
    setBranch(value);
    setQuery('');
    setOpen(false);
  };
  const canPull = !!remoteView && branch !== '' && !state.busy;
  const run = () => {
    if (!canPull || !remoteView) return;
    post({ type: 'pull/run', payload: { scopeId: scope.id, remote: remoteView.name, branch: branch === UPSTREAM ? null : branch, mode } });
  };

  return (
    <div
      className="pull"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !open) post({ type: 'pull/close', payload: {} });
      }}
    >
      <h2 className="pull-title">{scope.branch ? t('Pull to {0}', scope.branch) : 'Pull'}</h2>
      <div className="pull-row">
        <select value={scope.id} onChange={(e) => setScopeId(e.target.value)} aria-label={t('Repository')}>
          {state.scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="muted pull-cmd">git pull</span>
        <select value={remoteView?.name ?? ''} disabled={!scope.remotes.length} onChange={(e) => setRemote(e.target.value)} aria-label="Remote">
          {scope.remotes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <div className={`combo${branch === '' ? ' invalid' : ''}`}>
          <input
            ref={input}
            value={open ? query : label(branch)}
            placeholder={t('Specify branch')}
            onFocus={() => {
              setOpen(true);
              setActive(0);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (open && options[active]) choose(options[active]!.value);
                else run();
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            aria-label={t('Branch')}
          />
          <button className="combo-caret" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => (open ? setOpen(false) : input.current?.focus())}>
            ▾
          </button>
          {open && (
            <ul className="combo-list" role="listbox">
              {options.map((o, i) => (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={o.value === branch}
                  className={`${i === active ? 'active' : ''}${o.value === branch ? ' current' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                >
                  <span>{o.label}</span>
                  {o.note && <span className="muted small">{o.note}</span>}
                </li>
              ))}
              {options.length === 0 && <li className="muted small">{t('No branches match')}</li>}
            </ul>
          )}
        </div>
      </div>
      <div className="pull-options">
        {(
          [
            ['merge', 'Merge', t('creates a merge commit if needed')],
            ['rebase', 'Rebase', t('replays your commits on top (requires a clean repository)')],
            ['ff-only', '--ff-only', t('only moves forward if there are no diverging local commits')],
          ] as const
        ).map(([value, name, hint]) => (
          <label key={value} className="check" title={hint}>
            <input type="radio" name="mode" checked={mode === value} onChange={() => setMode(value)} />
            <span>{name}</span>
          </label>
        ))}
      </div>
      <footer className="pull-footer">
        <span className="muted small">
          {scope.total > 1 ? t('{0} repositories; the ones without that branch are skipped.', scope.total) : ''}
        </span>
        <span className="spacer" />
        <button className="secondary" onClick={() => post({ type: 'pull/close', payload: {} })}>
          {t('Cancel')}
        </button>
        <button className="primary" disabled={!canPull} onClick={run}>
          Pull
        </button>
      </footer>
    </div>
  );
}
