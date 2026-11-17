// Diff de un archivo como el de IntelliJ: HEAD a la izquierda, la versión actual a la derecha, una
// casilla por bloque para el commit parcial, "N differences, M included", ↑ ↓ (F7 / Shift+F7) entre
// bloques, ← → entre los archivos de Changes, » para revertir un bloque y doble clic para ir a la
// línea. Los tramos largos sin cambios se pliegan.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffBlockView, DiffState } from '../../../src/webview/protocol';
import { Code, Lang, MarkedCode } from '../merge/MergeDialog';
import { languageOf } from '../merge/highlight';
import { TriCheckbox } from '../rollback/RollbackDialog';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

type Change = Extract<DiffBlockView, { type: 'change' }>;

const CONTEXT = 4;
const HIGHLIGHT_LIMIT = 400_000;

export function DiffViewer() {
  const [state, setState] = useState<DiffState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapse, setCollapse] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const lastFile = useRef('');

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'diff/state') return;
        setState(m.payload);
        setSelected(new Set(m.payload.selected));
      }),
    [],
  );

  const changes = useMemo(() => (state?.blocks ?? []).flatMap((b, i) => (b.type === 'change' ? [i] : [])), [state]);

  // Otro archivo: sin pliegues abiertos y al primer cambio (como IntelliJ).
  useEffect(() => {
    if (!state) return;
    const id = `${state.repo}/${state.path}`;
    if (id === lastFile.current) return;
    lastFile.current = id;
    setExpanded(new Set());
    const first = changes[0] ?? null;
    setCurrent(first);
    requestAnimationFrame(() => {
      if (first === null) body.current?.scrollTo({ top: 0 });
      else body.current?.querySelector(`#dv-${first}`)?.scrollIntoView({ block: 'center' });
    });
  }, [state, changes]);

  const language = useMemo(() => {
    if (!state) return undefined;
    const size = state.blocks.reduce((n, b) => n + (b.type === 'stable' ? b.lines.join('').length : b.old.join('').length + b.new.join('').length), 0);
    return size > HIGHLIGHT_LIMIT ? undefined : languageOf(state.path);
  }, [state]);

  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const byLines = state.select === 'lines';
  const allIds = byLines ? state.blocks.flatMap((b) => (b.type === 'change' ? b.ids : [])) : [];
  /** Estado de la casilla de un bloque (o de todo el archivo con `ids` = todos). */
  const checkOf = (ids: string[]) => {
    if (!byLines) return { checked: state.checked, indeterminate: false };
    const on = ids.filter((id) => selected.has(id)).length;
    return { checked: ids.length > 0 && on === ids.length, indeterminate: on > 0 && on < ids.length };
  };
  const toggle = (ids: string[], on: boolean) => {
    if (!byLines) {
      post({ type: 'diff/check', payload: { checked: on } });
      return;
    }
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setSelected(next);
    post({ type: 'diff/select', payload: { selected: allIds.filter((id) => next.has(id)) } });
  };
  const included = byLines ? changes.filter((i) => (state.blocks[i] as Change).ids.some((id) => selected.has(id))).length : state.checked ? changes.length : 0;
  const all = checkOf(allIds);

  const go = (dir: 1 | -1) => {
    const pos = current === null ? -1 : changes.indexOf(current);
    const nextPos = pos + dir;
    // Pasado el último (o antes del primero) se va al archivo siguiente, como IntelliJ.
    if (nextPos < 0 || nextPos >= changes.length) {
      const target = state.index + dir;
      if (target >= 0 && target < state.count) post({ type: 'diff/file', payload: { delta: dir } });
      return;
    }
    const next = changes[nextPos]!;
    setCurrent(next);
    body.current?.querySelector(`#dv-${next}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  /** Doble clic en una línea: abre el archivo en esa línea. */
  const gotoLine = (side: 'old' | 'new', start: number) => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const k = Math.floor((e.clientY - el.getBoundingClientRect().top) / lh);
    post({ type: 'diff/goto', payload: { side, line: start + Math.max(0, k) } });
  };

  const rows: React.ReactElement[] = [];
  state.blocks.forEach((b, i) => {
    if (b.type === 'stable') {
      const first = i === 0;
      const last = i === state.blocks.length - 1;
      const keep = (first ? 0 : CONTEXT) + (last ? 0 : CONTEXT);
      if (!collapse || expanded.has(i) || b.lines.length <= keep + 2) {
        rows.push(<Stable key={i} lines={b.lines} oldIndex={b.oldIndex} newIndex={b.newIndex} gotoLine={gotoLine} />);
        return;
      }
      const head = first ? 0 : CONTEXT;
      const tail = last ? 0 : CONTEXT;
      if (head) rows.push(<Stable key={`${i}h`} lines={b.lines.slice(0, head)} oldIndex={b.oldIndex} newIndex={b.newIndex} gotoLine={gotoLine} />);
      rows.push(
        <div key={`${i}f`} className="mg-fold dv-fold" onClick={() => setExpanded((prev) => new Set(prev).add(i))}>
          ⋯ {t('{0} unchanged line(s) — click to show', b.lines.length - head - tail)}
        </div>,
      );
      if (tail) {
        const skip = b.lines.length - tail;
        rows.push(<Stable key={`${i}t`} lines={b.lines.slice(skip)} oldIndex={b.oldIndex + skip} newIndex={b.newIndex + skip} gotoLine={gotoLine} />);
      }
      return;
    }
    const kind = b.old.length && b.new.length ? 'mod' : b.new.length ? 'add' : 'del';
    const check = checkOf(b.ids);
    const oldText = b.old.join('');
    const newText = b.new.join('');
    rows.push(
      <div key={i} id={`dv-${i}`} className={`dv-row dv-${kind}${current === i ? ' dv-current' : ''}`} onClick={() => setCurrent(i)}>
        <div className="dv-cell dv-left">
          {b.old.length ? (
            <div className="dv-text" onDoubleClick={gotoLine('old', b.oldIndex)}>
              <MarkedCode text={oldText} against={newText} />
            </div>
          ) : (
            <div className="dv-gap" />
          )}
          <Nums from={b.oldIndex + 1} count={b.old.length} />
        </div>
        <div className="dv-mid">
          {state.local && (
            <button className="dv-revert" title={t('Revert')} onClick={(e) => (e.stopPropagation(), post({ type: 'diff/revert', payload: { block: i } }))}>
              »
            </button>
          )}
        </div>
        <div className="dv-cell dv-right">
          <Nums from={b.newIndex + 1} count={b.new.length} />
          <span className="dv-check">
            <TriCheckbox checked={check.checked} indeterminate={check.indeterminate} label={t('change {0}', changes.indexOf(i) + 1)} onChange={(v) => toggle(b.ids, v)} />
          </span>
          {b.new.length ? (
            <div className="dv-text" onDoubleClick={gotoLine('new', b.newIndex)}>
              <MarkedCode text={newText} against={oldText} />
            </div>
          ) : (
            <div className="dv-gap" />
          )}
        </div>
      </div>,
    );
  });

  const pos = current === null ? -1 : changes.indexOf(current);

  return (
    <Lang.Provider value={language}>
      <div
        className="merge dv"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'F7') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            const delta = e.key === 'ArrowLeft' ? -1 : 1;
            if (state.index + delta >= 0 && state.index + delta < state.count) post({ type: 'diff/file', payload: { delta } });
          }
        }}
      >
        <div className="pane-toolbar mg-toolbar">
          <button className="icon-btn codicon codicon-arrow-up" title={t('Previous Difference (Shift+F7)')} onClick={() => go(-1)} disabled={pos <= 0 && state.index <= 0} />
          <button className="icon-btn codicon codicon-arrow-down" title={t('Next Difference (F7)')} onClick={() => go(1)} disabled={pos >= changes.length - 1 && state.index >= state.count - 1} />
          <span className="mg-sep" />
          <button className="icon-btn codicon codicon-arrow-left" title={t('Previous File (Alt+Left)')} disabled={state.index <= 0} onClick={() => post({ type: 'diff/file', payload: { delta: -1 } })} />
          <span className="small dv-files">{state.index >= 0 ? t('{0}/{1} files', state.index + 1, state.count) : t('{0} files', state.count)}</span>
          <button className="icon-btn codicon codicon-arrow-right" title={t('Next File (Alt+Right)')} disabled={state.index < 0 || state.index >= state.count - 1} onClick={() => post({ type: 'diff/file', payload: { delta: 1 } })} />
          <span className="mg-sep" />
          <button className="icon-btn codicon codicon-go-to-file" title={t('Open in Editor (VS Code diff, editable)')} onClick={() => post({ type: 'diff/openEditor', payload: {} })} />
          <button
            className={`icon-btn codicon codicon-${collapse ? 'unfold' : 'fold'}`}
            title={collapse ? t('Show All Lines') : t('Collapse Unchanged Fragments')}
            onClick={() => (setCollapse(!collapse), setExpanded(new Set()))}
          />
          <span className="spacer" />
          <span className="small muted">{t('{0} differences, {1} included', changes.length, included)}</span>
        </div>

        <div className="dv-head">
          <div title={state.origPath ?? state.path}>
            <span className="codicon codicon-lock mg-lock" /> {state.base ? <strong>{state.base}</strong> : null} <span className="muted">{state.origPath ?? state.path}</span>
          </div>
          <div />
          <div title={`${state.repo}/${state.path}`}>
            {changes.length > 0 && <TriCheckbox checked={all.checked} indeterminate={all.indeterminate} label={t('all changes')} onChange={(v) => toggle(allIds, v)} />}
            <span className="dot" style={{ background: `var(--vscode-multigit-repo${state.colorIndex})` }} />
            {state.local ? t('Current version') : t('Deleted')} <span className="muted small">· {state.status}</span>
          </div>
        </div>

        {state.notice && <div className="banner warning">{state.notice}</div>}

        <div className="dv-body" ref={body}>
          {rows}
        </div>
      </div>
    </Lang.Provider>
  );
}

function Stable(props: { lines: string[]; oldIndex: number; newIndex: number; gotoLine: (side: 'old' | 'new', start: number) => (e: React.MouseEvent<HTMLElement>) => void }) {
  const text = props.lines.join('');
  return (
    <div className="dv-row dv-stable">
      <div className="dv-cell dv-left">
        <div className="dv-text" onDoubleClick={props.gotoLine('old', props.oldIndex)}>
          <Code text={text} />
        </div>
        <Nums from={props.oldIndex + 1} count={props.lines.length} />
      </div>
      <div className="dv-mid" />
      <div className="dv-cell dv-right">
        <Nums from={props.newIndex + 1} count={props.lines.length} />
        <span className="dv-check" />
        <div className="dv-text" onDoubleClick={props.gotoLine('new', props.newIndex)}>
          <Code text={text} />
        </div>
      </div>
    </div>
  );
}

function Nums(props: { from: number; count: number }) {
  return <pre className="mg-nums dv-nums">{Array.from({ length: props.count }, (_, k) => props.from + k).join('\n')}</pre>;
}
