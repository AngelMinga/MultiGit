// Vista Changes como la ventana Commit de IntelliJ: árbol con casillas gris (sin marcar), azul (marcada) y
// azul con "−" (parcial), iconos por tipo de archivo y el color de cada repo. El menú contextual es el
// nativo de VS Code (data-vscode-context → menús `webview/context` de package.json).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { ChangesIcon, ChangesRow } from '../../../src/webview/protocol';
import { getState, onHostMessage, post, setState } from '../vscode';
import { t } from '../i18n';

const DRAG_TYPE = 'application/x-multigit-changes';

interface Visible {
  row: ChangesRow;
  depth: number;
  parent: string | null;
}

export function ChangesApp() {
  const [rows, setRows] = useState<ChangesRow[] | null>(null);
  const [empty, setEmpty] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Plegado/desplegado elegido por el usuario (sin entrada = lo que diga la fila). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => getState('changesExpanded', {}));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'changes/state') {
          setRows(m.payload.rows);
          setEmpty(m.payload.empty);
        }
        if (m.type === 'changes/focus') list.current?.focus();
      }),
    [],
  );
  useEffect(() => setState('changesExpanded', expanded), [expanded]);

  const isOpen = (row: ChangesRow) => row.children.length > 0 && (expanded[row.id] ?? !row.collapsed);

  /** Filas visibles en orden (las de carpetas plegadas no). */
  const visible = useMemo(() => {
    const out: Visible[] = [];
    const walk = (items: ChangesRow[], depth: number, parent: string | null) => {
      for (const row of items) {
        out.push({ row, depth, parent });
        if (isOpen(row)) walk(row.children, depth + 1, row.id);
      }
    };
    walk(rows ?? [], 0, null);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, expanded]);

  // Las filas que ya no existen salen de la selección.
  useEffect(() => {
    const ids = new Set(visible.map((v) => v.row.id));
    if (selection.some((id) => !ids.has(id))) choose(selection.filter((id) => ids.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const choose = (ids: string[]) => {
    setSelection(ids);
    post({ type: 'changes/select', payload: { ids } });
  };

  const toggleOpen = (row: ChangesRow) => setExpanded((e) => ({ ...e, [row.id]: !isOpen(row) }));

  const check = (ids: string[], checked: boolean) => post({ type: 'changes/check', payload: { ids, checked } });

  const onRowClick = (e: MouseEvent, item: Visible) => {
    const { row } = item;
    setFocusId(row.id);
    if (e.metaKey || e.ctrlKey) {
      anchor.current = row.id;
      choose(selection.includes(row.id) ? selection.filter((id) => id !== row.id) : [...selection, row.id]);
      return;
    }
    if (e.shiftKey && anchor.current) {
      const a = visible.findIndex((v) => v.row.id === anchor.current);
      const b = visible.findIndex((v) => v.row.id === row.id);
      if (a >= 0 && b >= 0) {
        choose(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((v) => v.row.id));
        return;
      }
    }
    anchor.current = row.id;
    choose([row.id]);
    if (row.children.length) toggleOpen(row);
    else if (row.clickable) post({ type: 'changes/click', payload: { id: row.id } });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const index = visible.findIndex((v) => v.row.id === (focusId ?? selection[0]));
    const go = (i: number) => {
      const target = visible[Math.max(0, Math.min(visible.length - 1, i))];
      if (!target) return;
      setFocusId(target.row.id);
      anchor.current = target.row.id;
      choose([target.row.id]);
      document.getElementById(rowDomId(target.row.id))?.scrollIntoView({ block: 'nearest' });
    };
    const current = visible[index];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(index - 1);
        break;
      case 'ArrowRight':
        if (current && current.row.children.length && !isOpen(current.row)) toggleOpen(current.row);
        else go(index + 1);
        break;
      case 'ArrowLeft':
        if (current && isOpen(current.row)) toggleOpen(current.row);
        else if (current?.parent) go(visible.findIndex((v) => v.row.id === current.parent));
        break;
      case ' ': {
        // Espacio: marca o desmarca los elegidos (como IntelliJ).
        e.preventDefault();
        const chosen = visible.filter((v) => selection.includes(v.row.id) && v.row.check);
        if (chosen.length) check(chosen.map((v) => v.row.id), chosen.some((v) => v.row.check !== 'checked'));
        break;
      }
      case 'Enter':
        if (current?.row.clickable) post({ type: 'changes/click', payload: { id: current.row.id } });
        else if (current) toggleOpen(current.row);
        break;
    }
  };

  // ------------------------------------------------------------------ arrastrar a otra changelist

  const onDragStart = (e: DragEvent, row: ChangesRow) => {
    const ids = selection.includes(row.id) ? selection : [row.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: DragEvent, row: ChangesRow) => {
    if (!row.droppable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(row.id);
  };
  const onDrop = (e: DragEvent, row: ChangesRow) => {
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw || !row.droppable) return;
    e.preventDefault();
    post({ type: 'changes/drop', payload: { target: row.id, ids: JSON.parse(raw) as string[] } });
  };

  if (rows === null) return <div className="muted pad">{t('Loading…')}</div>;
  if (!rows.length) {
    return (
      <div className="changes-empty muted">
        <p>{empty}</p>
        <button className="link" onClick={() => post({ type: 'changes/runCommand', payload: { command: 'multigit.changes.refresh' } })}>
          {t('Refresh')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="changes"
      ref={list}
      tabIndex={0}
      role="tree"
      aria-multiselectable
      onKeyDown={onKeyDown}
      data-vscode-context={JSON.stringify({ preventDefaultContextMenuItems: true })}
    >
      {visible.map((item) => {
        const { row, depth } = item;
        const selected = selection.includes(row.id);
        return (
          <div
            key={row.id}
            id={rowDomId(row.id)}
            role="treeitem"
            aria-selected={selected}
            aria-expanded={row.children.length ? isOpen(row) : undefined}
            className={`changes-row${selected ? ' selected' : ''}${focusId === row.id ? ' focused' : ''}${dropTarget === row.id ? ' drop' : ''}`}
            style={{ paddingLeft: 4 + depth * 16 } as CSSProperties}
            title={row.tooltip}
            data-vscode-context={JSON.stringify({ viewItem: row.contextValue, nodeId: row.id, preventDefaultContextMenuItems: true })}
            onClick={(e) => onRowClick(e, item)}
            onContextMenu={() => {
              setFocusId(row.id);
              if (!selected) choose([row.id]);
            }}
            draggable={row.draggable}
            onDragStart={(e) => onDragStart(e, row)}
            onDragOver={(e) => onDragOver(e, row)}
            onDragLeave={() => setDropTarget((d) => (d === row.id ? null : d))}
            onDrop={(e) => onDrop(e, row)}
          >
            <span
              className={`twisty codicon ${row.children.length ? (isOpen(row) ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''}`}
              onClick={(e) => {
                if (!row.children.length) return;
                e.stopPropagation();
                toggleOpen(row);
              }}
            />
            {row.check ? (
              <span
                role="checkbox"
                aria-checked={row.check === 'mixed' ? 'mixed' : row.check === 'checked'}
                className={`mg-check ${row.check}`}
                onClick={(e) => {
                  e.stopPropagation();
                  check([row.id], row.check !== 'checked');
                }}
              >
                {row.check === 'checked' && <span className="codicon codicon-check" />}
                {row.check === 'mixed' && <span className="mg-dash" />}
              </span>
            ) : (
              <span className="mg-check-space" />
            )}
            <RowIcon icon={row.icon} />
            <span className={`changes-label${row.bold ? ' bold' : ''}`} style={row.color ? { color: `var(${row.color})` } : undefined}>
              {row.label}
            </span>
            {row.description && <span className="changes-desc">{row.description}</span>}
            <span className="changes-spacer" />
            {row.actions.length > 0 && (
              <span className="changes-actions">
                {row.actions.map((a) => (
                  <button
                    key={a.command}
                    className={`icon-btn codicon codicon-${a.icon}`}
                    title={a.title}
                    aria-label={a.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      post({ type: 'changes/action', payload: { id: row.id, command: a.command } });
                    }}
                  />
                ))}
              </span>
            )}
            {row.status && (
              <span className="changes-status" style={row.color ? { color: `var(${row.color})` } : undefined}>
                {row.status}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function rowDomId(id: string): string {
  return `row-${id.replace(/[^\w-]/g, '_')}`;
}

/** Iconos de archivo por extensión, parecidos a los de IntelliJ. */
const FILE_ICONS: Record<string, { text?: string; codicon?: string; color: string; react?: boolean }> = {
  js: { text: 'JS', color: '#d6b52d' },
  mjs: { text: 'JS', color: '#d6b52d' },
  cjs: { text: 'JS', color: '#d6b52d' },
  ts: { text: 'TS', color: '#3d82d6' },
  mts: { text: 'TS', color: '#3d82d6' },
  jsx: { react: true, color: '#3fb6d6' },
  tsx: { react: true, color: '#3fb6d6' },
  json: { codicon: 'json', color: '#d6b52d' },
  css: { codicon: 'symbol-color', color: '#4b8ee6' },
  scss: { codicon: 'symbol-color', color: '#d6649f' },
  less: { codicon: 'symbol-color', color: '#4b8ee6' },
  html: { codicon: 'code', color: '#e3703a' },
  md: { codicon: 'markdown', color: '#5c9bd1' },
  yml: { codicon: 'settings', color: '#cb5a5a' },
  yaml: { codicon: 'settings', color: '#cb5a5a' },
  png: { codicon: 'file-media', color: '#a074c4' },
  jpg: { codicon: 'file-media', color: '#a074c4' },
  jpeg: { codicon: 'file-media', color: '#a074c4' },
  gif: { codicon: 'file-media', color: '#a074c4' },
  svg: { codicon: 'file-media', color: '#e3a33a' },
  webp: { codicon: 'file-media', color: '#a074c4' },
  sh: { codicon: 'terminal', color: '#7f9c5a' },
  lock: { codicon: 'lock', color: '#8c8c8c' },
};

function RowIcon({ icon }: { icon?: ChangesIcon }) {
  if (!icon) return null;
  if (icon.kind === 'repo') return <span className="repo-square" style={{ background: `var(${icon.color})` }} />;
  if (icon.kind === 'codicon') return <span className={`row-icon codicon codicon-${icon.name}`} />;
  const spec = FILE_ICONS[icon.ext];
  if (!spec) return <span className="row-icon codicon codicon-file" />;
  if (spec.react) {
    return (
      <svg className="row-icon" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke={spec.color} strokeWidth="1">
          <ellipse cx="8" cy="8" rx="7" ry="2.7" />
          <ellipse cx="8" cy="8" rx="7" ry="2.7" transform="rotate(60 8 8)" />
          <ellipse cx="8" cy="8" rx="7" ry="2.7" transform="rotate(120 8 8)" />
        </g>
        <circle cx="8" cy="8" r="1.4" fill={spec.color} />
      </svg>
    );
  }
  if (spec.text) {
    return (
      <span className="row-icon file-badge" style={{ color: spec.color, borderColor: spec.color }}>
        {spec.text}
      </span>
    );
  }
  return <span className={`row-icon codicon codicon-${spec.codicon}`} style={{ color: spec.color }} />;
}
