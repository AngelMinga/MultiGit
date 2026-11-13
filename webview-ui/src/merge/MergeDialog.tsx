// Ventana de merge propia, como "Merge Revisions" de IntelliJ: Tuyos | Resultado | Otros. Cada bloque de
// cambios se pasa al resultado con » / « o se descarta con ✕; el resultado se puede editar. Las tres
// columnas van por filas (una por bloque), así siempre quedan alineadas; los tramos largos sin cambios
// se pliegan.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { highlight, languageOf } from './highlight';
import type { MergeBlockView, MergeState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

type SideState = 'applied' | 'ignored' | null;
interface Resolution {
  text: string;
  ours: SideState;
  theirs: SideState;
  /** Editado a mano en el resultado: cuenta como resuelto. */
  edited: boolean;
}

type Change = Extract<MergeBlockView, { type: 'change' }>;

/** Lenguaje para los colores de sintaxis (undefined = texto plano). */
const Lang = createContext<string | undefined>(undefined);
/** Por encima de este tamaño no se colorea (archivos enormes como un package-lock). */
const HIGHLIGHT_LIMIT = 400_000;

const COLLAPSE_OVER = 16;
const CONTEXT = 3;

function isResolved(b: Change, r: Resolution): boolean {
  if (r.edited) return true;
  if (b.kind === 'ours') return r.ours !== null;
  if (b.kind === 'theirs') return r.theirs !== null;
  if (b.kind === 'same') return r.ours !== null || r.theirs !== null;
  return r.ours !== null && r.theirs !== null;
}

const countLines = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

export function MergeDialog() {
  const [state, setState] = useState<MergeState | null>(null);
  const [res, setRes] = useState<Record<number, Resolution>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'merge/state') return;
        setState(m.payload);
        // Como IntelliJ: el resultado empieza con la base en cada bloque y nada aplicado.
        const initial: Record<number, Resolution> = {};
        m.payload.blocks.forEach((b, i) => {
          if (b.type === 'change') initial[i] = { text: b.base.join(''), ours: null, theirs: null, edited: false };
        });
        setRes(initial);
        setConfirm(false);
      }),
    [],
  );

  const changes = useMemo(() => (state?.blocks ?? []).map((b, i) => [b, i] as const).filter((x): x is [Change, number] => x[0].type === 'change'), [state]);
  const pendingChanges = changes.filter(([b, i]) => b.kind !== 'conflict' && res[i] && !isResolved(b, res[i]!)).length;
  const pendingConflicts = changes.filter(([b, i]) => b.kind === 'conflict' && res[i] && !isResolved(b, res[i]!)).length;
  const unresolved = changes.filter(([b, i]) => res[i] && !isResolved(b, res[i]!)).map(([, i]) => i);

 const language = useMemo(() => {
    if (!state) return undefined;
    const size = state.blocks.reduce((n, b) => n + (b.type === 'stable' ? b.lines.join('').length : b.ours.join('').length + b.theirs.join('').length), 0);
    return size > HIGHLIGHT_LIMIT ? undefined : languageOf(state.path);
  }, [state]);

  if (!state) return <p className="muted pad">{t('Loading…')}</p>;

  const update = (i: number, change: (r: Resolution, b: Change) => Resolution) =>
    setRes((prev) => {
      const b = state.blocks[i] as Change;
      return { ...prev, [i]: change(prev[i]!, b) };
    });
  const apply = (i: number, side: 'ours' | 'theirs') =>
    update(i, (r, b) => {
      const lines = (side === 'ours' ? b.ours : b.theirs).join('');
      const other = side === 'ours' ? r.theirs : r.ours;
      // Si el otro lado ya se aplicó, se añade detrás (como IntelliJ); si no, reemplaza a la base.
      const text = other === 'applied' && b.kind === 'conflict' ? r.text + lines : lines;
      const both = b.kind === 'same';
      return { ...r, text, [side]: 'applied', ...(both ? { ours: 'applied', theirs: 'applied' } : {}) };
    });
  const ignore = (i: number, side: 'ours' | 'theirs') =>
    update(i, (r, b) => ({ ...r, [side]: 'ignored', ...(b.kind === 'same' ? { ours: 'ignored', theirs: 'ignored' } : {}) }));
  /** Aplicar los cambios sin conflicto de un lado (o de los dos). */
  const applyNonConflicting = (which: 'ours' | 'theirs' | 'all') =>
    setRes((prev) => {
      const next = { ...prev };
      changes.forEach(([b, i]) => {
        const r = next[i]!;
        if (b.kind === 'conflict' || isResolved(b, r)) return;
        const take = b.kind === 'same' ? (which !== 'theirs' ? 'ours' : 'theirs') : b.kind;
        if (which !== 'all' && take !== which && b.kind !== 'same') return;
        next[i] = { ...r, text: (take === 'ours' ? b.ours : b.theirs).join(''), ours: 'applied', theirs: 'applied' };
      });
      return next;
    });

  const result = () => state.blocks.map((b, i) => (b.type === 'stable' ? b.lines.join('') : res[i]?.text ?? '')).join('');
  const save = (resolve: boolean) => post({ type: 'merge/save', payload: { content: result(), resolve } });
  const go = (dir: 1 | -1) => {
    if (!unresolved.length) return;
    const pos = current === null ? -1 : unresolved.indexOf(current);
    const next = unresolved[(pos + dir + unresolved.length) % unresolved.length]!;
    setCurrent(next);
    body.current?.querySelector(`#blk-${next}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  // Números de línea de cada columna, acumulados bloque a bloque.
  let nL = 1;
  let nC = 1;
  let nR = 1;

  return (
    <Lang.Provider value={language}>
    <div
      className="merge"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'F7') {
          e.preventDefault();
          go(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="pane-toolbar mg-toolbar">
        <button className="icon-btn" title={t('Previous conflict (Shift+F7)')} onClick={() => go(-1)} disabled={!unresolved.length}>
          ↑
        </button>
        <button className="icon-btn" title={t('Next conflict (F7)')} onClick={() => go(1)} disabled={!unresolved.length}>
          ↓
        </button>
        <span className="mg-sep" />
        <span className="small muted">{t('Apply non-conflicting changes:')}</span>
        <button className="link" disabled={!pendingChanges} onClick={() => applyNonConflicting('ours')}>
          » {t('Left')}
        </button>
        <button className="link" disabled={!pendingChanges} onClick={() => applyNonConflicting('all')}>
          ⇉ {t('All')}
        </button>
        <button className="link" disabled={!pendingChanges} onClick={() => applyNonConflicting('theirs')}>
          « {t('Right')}
        </button>
        <span className="spacer" />
        <span className={`small ${pendingConflicts ? 'mg-bad' : 'mg-good'}`}>
          {pendingChanges || pendingConflicts ? t('{0} change(s), {1} conflict(s)', pendingChanges, pendingConflicts) : `✓ ${t('All changes have been processed')}`}
        </span>
      </div>

      <div className="mg-head">
        <div title={state.yours}>
          🔒 {t('Changes from')} <strong>{state.yours}</strong>
        </div>
        <div>
          {t('Result')} <span className="muted small">{state.path}</span>
        </div>
        <div title={state.theirs}>
          🔒 {t('Changes from')} <strong>{state.theirs}</strong>
        </div>
      </div>

      <div className="mg-body" ref={body}>
        {state.blocks.map((b, i) => {
          if (b.type === 'stable') {
            const collapse = b.lines.length > COLLAPSE_OVER && !expanded.has(i) && i !== 0 && i !== state.blocks.length - 1;
            const startL = nL;
            const startC = nC;
            const startR = nR;
            nL += b.lines.length;
            nC += b.lines.length;
            nR += b.lines.length;
            if (!collapse) {
              return <Row key={i} cls="mg-stable" left={b.lines} center={b.lines} right={b.lines} nums={[startL, startC, startR]} />;
            }
            const head = b.lines.slice(0, CONTEXT);
            const tail = b.lines.slice(-CONTEXT);
            const hidden = b.lines.length - 2 * CONTEXT;
            return (
              <div key={i}>
                <Row cls="mg-stable" left={head} center={head} right={head} nums={[startL, startC, startR]} />
                <div className="mg-fold" onClick={() => setExpanded((prev) => new Set(prev).add(i))}>
                  ⋯ {t('{0} unchanged line(s) — click to show', hidden)}
                </div>
                <Row cls="mg-stable" left={tail} center={tail} right={tail} nums={[startL + b.lines.length - CONTEXT, startC + b.lines.length - CONTEXT, startR + b.lines.length - CONTEXT]} />
              </div>
            );
          }
          const r = res[i];
          if (!r) return null;
          const done = isResolved(b, r);
          const nums: [number, number, number] = [nL, nC, nR];
          nL += b.ours.length;
          nC += countLines(r.text);
          nR += b.theirs.length;
          const oursHas = b.kind !== 'theirs';
          const theirsHas = b.kind !== 'ours';
          return (
            <div key={i} id={`blk-${i}`} className={`mg-row mg-${b.kind}${done ? ' mg-done' : ''}${current === i ? ' mg-current' : ''}`}>
              <div className={`mg-cell mg-side${r.ours ? ' mg-handled' : ''}`}>
                <Nums from={nums[0]} count={b.ours.length} />
                <Code text={b.ours.join('')} />
                {oursHas && !r.ours && (
                  <span className="mg-arrows">
                    <button title={t('Accept this change')} onClick={() => apply(i, 'ours')}>
                      »
                    </button>
                    <button title={t('Ignore this change')} onClick={() => ignore(i, 'ours')}>
                      ✕
                    </button>
                  </span>
                )}
              </div>
              <div className="mg-cell mg-center">
                <Nums from={nums[1]} count={countLines(r.text)} />
                {/* Código coloreado debajo y el textarea transparente encima: se edita con colores. */}
                <div className="mg-editwrap">
                  <Code text={r.text} />
                  <textarea
                    className="mg-text mg-edit"
                    value={r.text}
                    wrap="off"
                    spellCheck={false}
                    rows={Math.max(1, countLines(r.text))}
                    onChange={(e) => update(i, (prev) => ({ ...prev, text: e.target.value, edited: true }))}
                    aria-label={t('Result')}
                  />
                </div>
              </div>
              <div className={`mg-cell mg-side mg-right${r.theirs ? ' mg-handled' : ''}`}>
                {theirsHas && !r.theirs && (
                  <span className="mg-arrows">
                    <button title={t('Accept this change')} onClick={() => apply(i, 'theirs')}>
                      «
                    </button>
                    <button title={t('Ignore this change')} onClick={() => ignore(i, 'theirs')}>
                      ✕
                    </button>
                  </span>
                )}
                <Nums from={nums[2]} count={b.theirs.length} />
                <Code text={b.theirs.join('')} />
              </div>
            </div>
          );
        })}
      </div>

      <footer className="push-footer">
        <button className="secondary" onClick={() => post({ type: 'merge/acceptSide', payload: { side: 'ours' } })} title={state.yours}>
          {t('Accept Left')}
        </button>
        <button className="secondary" onClick={() => post({ type: 'merge/acceptSide', payload: { side: 'theirs' } })} title={state.theirs}>
          {t('Accept Right')}
        </button>
        <span className="spacer" />
        <button className="secondary" onClick={() => save(false)} title={t('Save the result without marking the file as resolved')}>
          {t('Save and Close')}
        </button>
        <button className="primary" onClick={() => (pendingConflicts || pendingChanges ? setConfirm(true) : save(true))}>
          {t('Apply Changes')}
        </button>
      </footer>

      {confirm && (
        <div className="overlay" onClick={() => setConfirm(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>⚠ {t('Unprocessed Changes')}</h2>
            <p>{t('{0} change(s) and {1} conflict(s) are not processed. The file will be saved exactly as shown in the Result pane.', pendingChanges, pendingConflicts)}</p>
            <div className="dialog-buttons">
              <button className="secondary" autoFocus onClick={() => setConfirm(false)}>
                {t('Back to Resolving')}
              </button>
              <button className="primary" onClick={() => save(true)}>
                {t('Save Current Result')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </Lang.Provider>
  );
}

/** Código coloreado (memorizado: no se vuelve a colorear si no cambia el texto). */
const Code = memo(function Code(props: { text: string }) {
  const language = useContext(Lang);
  // Un espacio si está vacío, para que la fila conserve su alto.
  return <pre className="mg-text" dangerouslySetInnerHTML={{ __html: props.text ? highlight(props.text, language) : ' ' }} />;
});

function Row(props: { cls: string; left: string[]; center: string[]; right: string[]; nums: [number, number, number] }) {
  return (
    <div className={`mg-row ${props.cls}`}>
      <div className="mg-cell mg-side">
        <Nums from={props.nums[0]} count={props.left.length} />
        <Code text={props.left.join('')} />
      </div>
      <div className="mg-cell mg-center">
        <Nums from={props.nums[1]} count={props.center.length} />
        <Code text={props.center.join('')} />
      </div>
      <div className="mg-cell mg-side mg-right">
        <Nums from={props.nums[2]} count={props.right.length} />
        <Code text={props.right.join('')} />
      </div>
    </div>
  );
}

function Nums(props: { from: number; count: number }) {
  return <pre className="mg-nums">{Array.from({ length: Math.max(props.count, 0) }, (_, k) => props.from + k).join('\n') || ' '}</pre>;
}
