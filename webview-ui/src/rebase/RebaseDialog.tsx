// Interactively Rebase from Here: commits del más viejo al más nuevo, cada uno con su acción
// (Pick, Reword, Squash, Fixup, Drop), y botones para moverlos. Teclas en la fila elegida:
// P/R/S/F/D cambian la acción y Alt+↑/↓ la mueven (como el diálogo de IntelliJ).
import { useEffect, useState } from 'react';
import type { RebaseActionName, RebaseState } from '../../../src/webview/protocol';
import { relativeDate } from '../format';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

interface Row {
  hash: string;
  short: string;
  subject: string;
  original: string;
  author: string;
  time: number;
  action: RebaseActionName;
  message: string;
}

const ACTIONS: Array<{ id: RebaseActionName; key: string }> = [
  { id: 'pick', key: 'p' },
  { id: 'reword', key: 'r' },
  { id: 'squash', key: 's' },
  { id: 'fixup', key: 'f' },
  { id: 'drop', key: 'd' },
];

/** Nombres de las acciones de git (en inglés, como en IntelliJ). */
const actionLabel = (a: RebaseActionName) => ({ pick: 'Pick', reword: 'Reword', squash: 'Squash', fixup: 'Fixup', drop: 'Drop' })[a];

export function RebaseDialog() {
  const [state, setState] = useState<RebaseState | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [focused, setFocused] = useState(0);

  const reset = (s: RebaseState) =>
    setRows(s.commits.map((c) => ({ hash: c.hash, short: c.short, subject: c.subject, original: c.message, author: c.author, time: c.time, action: 'pick', message: c.message })));

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'rebase/state') return;
        setState((prev) => {
          // Una nueva apertura (otros commits) reinicia el plan; un cambio de "busy" no.
          if (!prev || prev.commits.map((c) => c.hash).join() !== m.payload.commits.map((c) => c.hash).join()) {
            reset(m.payload);
            setFocused(0);
          }
          return m.payload;
        });
      }),
    [],
  );

  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const update = (i: number, change: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    setRows((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    setFocused(j);
  };

  const kept = rows.filter((r) => r.action !== 'drop');
  const problem =
    kept.length === 0
      ? t('All commits are dropped; use Reset to move the branch instead.')
      : kept[0]!.action === 'squash' || kept[0]!.action === 'fixup'
        ? t('The first commit cannot be squash or fixup: there is no previous commit to join it to.')
        : rows.some((r) => r.action === 'reword' && !r.message.trim())
          ? t('The new message of a reworded commit is empty.')
          : undefined;
  const changed = rows.some((r, i) => r.action !== 'pick' || r.hash !== state.commits[i]?.hash);

  const start = () =>
    post({
      type: 'rebase/start',
      payload: { entries: rows.map((r) => ({ hash: r.hash, action: r.action, ...(r.action === 'reword' ? { message: r.message } : {}) })) },
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(focused, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFocused((f) => Math.max(0, Math.min(rows.length - 1, f + (e.key === 'ArrowUp' ? -1 : 1))));
    } else {
      const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
      if (a && !e.metaKey && !e.ctrlKey) update(focused, { action: a.id });
    }
  };

  return (
    <div className="rebase" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="pane-toolbar rbz-toolbar">
        <span className="dot" style={{ background: `var(--vscode-multigit-repo${state.colorIndex})` }} />
        <strong>{state.repo}</strong>
        <span className="muted">⎇ {state.branch}</span>
        <span className="spacer" />
        <span className="muted small">{t('Oldest first. Keys: P R S F D, Alt+↑/↓ to move.')}</span>
      </div>
      <ol className="rbz-list">
        {rows.map((r, i) => (
          <li
            key={r.hash}
            className={`rbz-row rbz-${r.action}${focused === i ? ' selected' : ''}`}
            onClick={() => setFocused(i)}
          >
            <div className="rbz-main">
              <select value={r.action} disabled={state.busy} onChange={(e) => update(i, { action: e.target.value as RebaseActionName })} aria-label={t('Action for {0}', r.short)}>
                {ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {actionLabel(a.id)}
                  </option>
                ))}
              </select>
              <code className="rbz-hash">{r.short}</code>
              <span className="rbz-subject" title={r.original}>
                {r.action === 'reword' ? r.message.split('\n')[0] : r.subject}
              </span>
              <span className="muted small rbz-meta">
                {r.author} · {relativeDate(r.time)}
              </span>
              <button className="icon-btn" title={t('Move up')} disabled={i === 0 || state.busy} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" title={t('Move down')} disabled={i === rows.length - 1 || state.busy} onClick={() => move(i, 1)}>
                ↓
              </button>
            </div>
            {r.action === 'reword' && (
              <textarea
                className="rbz-message"
                value={r.message}
                rows={Math.min(8, Math.max(2, r.message.split('\n').length))}
                disabled={state.busy}
                onChange={(e) => update(i, { message: e.target.value })}
                aria-label={t('New message for {0}', r.short)}
              />
            )}
          </li>
        ))}
      </ol>
      <footer className="push-footer">
        {problem ? <span className="rbz-problem small">{problem}</span> : <span className="muted small">{t('{0} commit(s)', rows.length)}</span>}
        <span className="spacer" />
        {state.busy && <span className="muted">{t('Working…')}</span>}
        <button className="secondary" disabled={state.busy || !changed} onClick={() => reset(state)}>
          {t('Reset')}
        </button>
        <button className="secondary" disabled={state.busy} onClick={() => post({ type: 'rebase/close', payload: {} })}>
          {t('Cancel')}
        </button>
        <button className="primary" disabled={state.busy || !!problem || !changed} onClick={start}>
          {t('Start Rebasing')}
        </button>
      </footer>
    </div>
  );
}
