// Dibujo del grafo para UNA fila (SVG). Cada fila se dibuja sola, así que funciona con la
// lista virtualizada: solo existen los SVG de las filas visibles.
import { memo } from 'react';
import type { GraphLine, GraphRow } from '../../../src/git/graph';

/** Ancho de un carril en px. */
export const LANE_WIDTH = 12;
/** Máximo de carriles dibujados (los demás se recortan). */
export const MAX_LANES = 16;

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
        <g key={i}>
          <path d={pathOf(line, y)} stroke={color(line.color)} className={line.stub === 'missing' ? 'stub' : undefined} />
          {(line.stub === 'down' || line.stub === 'up') && (
            <path d={arrowOf(line, y)} stroke={color(line.color)} className="arrow" />
          )}
        </g>
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
  // Tramos cortos: hacia un padre no cargado / arista larga cortada (↓), o llegada de una (↑).
  const y1 = line.stub === 'up' ? y.mid * 0.35 : y[line.from];
  const y2 = line.stub === 'missing' || line.stub === 'down' ? y.mid + (y.bottom - y.mid) * 0.75 : y[line.to];
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

/** Punta de flecha: hacia abajo al final del tramo ↓, hacia arriba al inicio del tramo ↑. */
function arrowOf(line: GraphLine, y: { top: number; mid: number; bottom: number }): string {
  const cx = x(line.x1);
  const a = 3;
  if (line.stub === 'down') {
    const tip = y.mid + (y.bottom - y.mid) * 0.75;
    return `M${cx - a} ${tip - a}L${cx} ${tip}L${cx + a} ${tip - a}`;
  }
  const tip = y.mid * 0.35;
  return `M${cx - a} ${tip + a}L${cx} ${tip}L${cx + a} ${tip + a}`;
}

function color(index: number): string {
  return `var(--graph-${index})`;
}
