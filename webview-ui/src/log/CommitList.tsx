// Lista virtualizada de commits (react-window). Carga más al acercarse al final.
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import type { LogRepoInfo, LogRow } from '../../../src/webview/protocol';
import { computeGraph, type GraphRow } from '../../../src/git/graph';
import { relativeDate } from '../format';
import { GraphCell, graphWidth } from './GraphCell';

export const ROW_HEIGHT = 24;

interface RowData {
  rows: LogRow[];
  /** Commits alcanzables desde el HEAD de su repo (los demás se atenúan). */
  onHead: Set<string>;
  graph: GraphRow[];
  graphWidth: number;
  repos: Map<string, LogRepoInfo>;
  selected: string | null;
  onSelect: (row: LogRow) => void;
  onContextMenu: (row: LogRow, x: number, y: number) => void;
}

export function CommitList(props: {
  rows: LogRow[];
  repos: Map<string, LogRepoInfo>;
  hasMore: boolean;
  loading: boolean;
  selected: string | null;
  onSelect: (row: LogRow) => void;
  onLoadMore: () => void;
  onContextMenu: (row: LogRow, x: number, y: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<FixedSizeList>(null);
  const size = useSize(container);

  // Flechas ↑/↓ para moverse entre commits.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const index = props.rows.findIndex((r) => key(r) === props.selected);
    const next = Math.max(0, Math.min(props.rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = props.rows[next];
    if (row) {
      props.onSelect(row);
      list.current?.scrollToItem(next);
    }
  };

  const onHead = useMemo(() => reachableFromHead(props.rows, props.repos), [props.rows, props.repos]);
  // El grafo se recalcula entero al cambiar las filas (5 000 commits ≈ pocos ms) y se dibuja por fila.
  const graph = useMemo(
    () =>
      computeGraph(
        props.rows.map((r) => ({ id: key(r), parents: r.parents.map((p) => `${r.repoId}@${p}`), group: r.repoId })),
      ),
    [props.rows],
  );
  const data: RowData = {
    rows: props.rows,
    onHead,
    graph: graph.rows,
    graphWidth: graphWidth(graph.maxLanes),
    repos: props.repos,
    selected: props.selected,
    onSelect: props.onSelect,
    onContextMenu: props.onContextMenu,
  };

  return (
    <div className="commit-list" ref={container} tabIndex={0} onKeyDown={onKeyDown}>
      {props.rows.length === 0 && !props.loading && <div className="muted pad">No hay commits con estos filtros.</div>}
      {size.height > 0 && (
        <FixedSizeList
          ref={list}
          height={size.height}
          width={size.width}
          itemCount={props.rows.length}
          itemSize={ROW_HEIGHT}
          itemData={data}
          itemKey={(index, d: RowData) => key(d.rows[index]!)}
          overscanCount={20}
          onItemsRendered={({ visibleStopIndex }) => {
            if (props.hasMore && !props.loading && visibleStopIndex >= props.rows.length - 40) props.onLoadMore();
          }}
        >
          {Row}
        </FixedSizeList>
      )}
    </div>
  );
}

export function key(row: LogRow): string {
  return `${row.repoId}@${row.hash}`;
}

const Row = memo(function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const row = data.rows[index]!;
  const repo = data.repos.get(row.repoId);
  const selected = data.selected === key(row);
  const dim = !data.onHead.has(key(row));
  return (
    <div
      className={`log-row${selected ? ' selected' : ''}${dim ? ' dim' : ''}`}
      style={style as CSSProperties}
      onClick={() => data.onSelect(row)}
      onContextMenu={(e) => {
        e.preventDefault();
        data.onSelect(row);
        data.onContextMenu(row, e.clientX, e.clientY);
      }}
      title={`${repo?.name ?? ''} · ${row.shortHash}`}
    >
      <span className="stripe" style={{ background: `var(--vscode-multigit-repo${repo?.colorIndex ?? 0})` }} />
      {data.graph[index] && <GraphCell row={data.graph[index]} width={data.graphWidth} height={ROW_HEIGHT} />}
      <span className="log-subject">{row.subject}</span>
      {row.refs.length > 0 && (
        <span className="log-refs">
          {row.refs.map((ref) => (
            <span key={`${ref.kind}:${ref.name}`} className={`ref ref-${ref.kind}`} title={ref.name}>
              {ref.kind === 'tag' ? '🏷 ' : '⑂ '}
              {ref.name}
            </span>
          ))}
        </span>
      )}
      <span className="log-author">{row.author}</span>
      <span className="log-date">{relativeDate(row.date)}</span>
    </div>
  );
});

/** Tamaño del contenedor (para la lista virtualizada). */
function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Commits alcanzables desde el HEAD de cada repo dentro de lo cargado. Con `--date-order` un
 * commit nunca aparece antes que sus hijos, así que basta una pasada en orden.
 */
function reachableFromHead(rows: readonly LogRow[], repos: Map<string, LogRepoInfo>): Set<string> {
  const pending = new Map<string, Set<string>>();
  for (const [id, repo] of repos) if (repo.head) pending.set(id, new Set([repo.head]));
  const result = new Set<string>();
  for (const row of rows) {
    const set = pending.get(row.repoId);
    if (!set?.has(row.hash)) continue;
    result.add(key(row));
    for (const p of row.parents) set.add(p);
  }
  return result;
}
