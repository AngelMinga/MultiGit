// Dibujo del grafo para UNA fila (SVG). Cada fila se dibuja sola, así que funciona con la
// lista virtualizada: solo existen los SVG de las filas visibles.
import { memo } from 'react';
import type { GraphLine, GraphRow } from '../../../src/git/graph';

/** Ancho de un carril en px. */
export const LANE_WIDTH = 12;
/** Máximo de carriles dibujados (los demás se recortan). */
export const MAX_LANES = 30;

export function graphWidth(maxLanes: number): number {
  return Math.min(Math.max(maxLanes, 1), MAX_LANES) * LANE_WIDTH + 4;
}

const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2 + 2;

export const GraphCell = memo(function GraphCell(props: { row: GraphRow; width: number; height: number }) {
  const { row, width, height } = props;
  const y = { top: 0, mid: height / 2, bottom: height };
  return (
    <svg className="graph" width={width} height={height} aria-hidden="true">
      {row.lines.map((line, i) => (
        <path key={i} d={pathOf(line, y)} stroke={color(line.color)} className={line.stub ? 'stub' : undefined} />
      ))}
      <circle
        cx={x(row.node)}
        cy={y.mid}
        r={row.merge ? 3.2 : 3.6}
        fill={row.merge ? 'var(--graph-bg)' : color(row.color)}
        stroke={color(row.color)}
        strokeWidth={row.merge ? 2 : 1}
      />
    </svg>
  );
});

function pathOf(line: GraphLine, y: { top: number; mid: number; bottom: number }): string {
  const x1 = x(line.x1);
  const x2 = x(line.x2);
  const y1 = y[line.from];
  // Los tramos hacia un padre no cargado se quedan cortos.
  const y2 = line.stub ? y.mid + (y.bottom - y.mid) * 0.7 : y[line.to];
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

function color(index: number): string {
  return `var(--graph-${index})`;
}
