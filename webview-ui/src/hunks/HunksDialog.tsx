// Select Changes to Commit: el diff de un archivo con una casilla por hunk y otra por línea cambiada
// (como el diff del commit de IntelliJ). Clic en una línea la marca o desmarca.
import { useEffect, useMemo, useState } from 'react';
import type { HunkRowView, HunksState } from '../../../src/webview/protocol';
import { TriCheckbox } from '../rollback/RollbackDialog';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

export function HunksDialog() {
  const [state, setState] = useState<HunksState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'hunks/state') return;
        setState(m.payload);
        setSelected(new Set(m.payload.selected));
      }),
    [],
  );

  const allIds = useMemo(() => (state?.hunks ?? []).flatMap((h) => idsOf(h)), [state]);
  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const count = allIds.filter((id) => selected.has(id)).length;
  const save = () => post({ type: 'hunks/save', payload: { selected: allIds.filter((id) => selected.has(id)) } });

  return (
    <div className="hunks">
      <div className="pane-toolbar hk-toolbar">
        <span className="dot" style={{ background: `var(--vscode-multigit-repo${state.colorIndex})` }} />
        <span className="hk-file" title={`${state.repo}/${state.path}`}>
          {state.repo} <span className="muted">/</span> {state.path}
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => toggle(allIds, true)}>
          {t('Select all')}
        </button>
        <button className="link" onClick={() => toggle(allIds, false)}>
          {t('Select none')}
        </button>
        <button className="icon-btn" title={t('Show Diff')} onClick={() => post({ type: 'hunks/openDiff', payload: {} })}>
          ⇄
        </button>
      </div>
      {state.notice && <div className="banner warning">{state.notice}</div>}
      <div className="hk-body">
        {state.hunks.map((rows, h) => {
          const ids = idsOf(rows);
          const on = ids.filter((id) => selected.has(id)).length;
          const first = rows.find((r) => r.id);
          const lineNo = first?.newNo ?? first?.oldNo ?? 0;
          return (
            <section key={h} className="hk-hunk">
              <label className="hk-head">
                <TriCheckbox checked={on === ids.length} indeterminate={on > 0 && on < ids.length} label={t('change {0}', h + 1)} onChange={(v) => toggle(ids, v)} />
                <span>{t('Change {0} of {1}', h + 1, state.hunks.length)}</span>
                <span className="muted small">{t('line {0}', lineNo)}</span>
                <span className="muted small">{t('{0}/{1} lines', on, ids.length)}</span>
              </label>
              <table className="hk-lines">
                <tbody>
                  {rows.map((r, i) => (
                    <Row key={i} row={r} on={!!r.id && selected.has(r.id)} onToggle={(v) => r.id && toggle([r.id], v)} />
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
      <footer className="push-footer">
        <span className="small">{t('{0} of {1} changed lines will be committed', count, allIds.length)}</span>
        <span className="spacer" />
        <button className="secondary" onClick={() => post({ type: 'hunks/close', payload: {} })}>
          {t('Cancel')}
        </button>
        <button className="primary" onClick={save}>
          {t('Save Selection')}
        </button>
      </footer>
    </div>
  );
}

function Row(props: { row: HunkRowView; on: boolean; onToggle: (on: boolean) => void }) {
  const { row, on } = props;
  const selectable = row.kind !== 'ctx';
  return (
    <tr
      className={`hk-row hk-${row.kind}${selectable && !on ? ' hk-off' : ''}`}
      onClick={selectable ? () => props.onToggle(!on) : undefined}
    >
      <td className="hk-check">{selectable && <input type="checkbox" checked={on} onChange={() => props.onToggle(!on)} onClick={(e) => e.stopPropagation()} aria-label={t('Include line')} />}</td>
      <td className="hk-no">{row.oldNo ?? ''}</td>
      <td className="hk-no">{row.newNo ?? ''}</td>
      <td className="hk-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</td>
      <td className="hk-text">{row.text.replace(/\r?\n$/, '') || ' '}</td>
    </tr>
  );
}

function idsOf(rows: readonly HunkRowView[]): string[] {
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}
