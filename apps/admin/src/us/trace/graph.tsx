import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  nodeDisplay,
  traceCivilDate,
  traceRows,
  type TracePresentationProps,
} from "./projection.js";
import { TraceEventAction, TraceLotActions } from "./actions.js";
import { presentationCopy } from "./presentation-copy.js";
import "./trace.css";

export function TraceGraph({ result, onOpenLot, onOpenEvent }: TracePresentationProps) {
  const { i18n } = useTranslation();
  const copy = presentationCopy(i18n.language);
  const arrowId = useId();
  // Fixed semantic columns and server order are stable even for cyclic or partial traces.
  const rows = [0, 0, 0];
  const placed = result.nodes.map((node) => {
    const column = node.kind === "lot" ? 1 : node.kind === "transformation" ? 2 : 0;
    const row = rows[column] ?? 0;
    rows[column] = row + 1;
    return { node, x: 160 + column * 360, y: 60 + row * 140 };
  });
  const positions = new Map(placed.map((item) => [item.node.id, item]));
  const nodeHeight = Math.max(180, Math.max(...rows) * 140);
  // Allocate globally: different endpoint pairs can have the same midpoint too.
  // Every exact edge keeps its own path/quantity row below all node shapes, in server
  // order. This also accommodates long quantities without estimating font metrics.
  const edges = traceRows(result);
  const height = nodeHeight + (edges.length > 0 ? (edges.length + 1) * 28 : 0);
  const geometry = edges.map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) throw new Error("Validated trace edge has no endpoint");
    const direction = from.x < to.x ? 1 : -1;
    const x1 = from.x + 136 * direction;
    const x2 = to.x - 136 * direction;
    const lane = nodeHeight + 28 + index * 28;
    // Distinct trunks retain a visible association from each branch to its quantity.
    // Keep them within the column gaps without widening the page for dense traces.
    const trunkInset = 10 + ((index + 1) / (edges.length + 1)) * 24;
    // Vertical trunks stay in column gaps; even material→event edges cross below lots.
    const path = `M${x1},${from.y} H${x1 + direction * trunkInset} V${lane} H${x2 - direction * trunkInset} V${to.y} H${x2}`;
    return {
      edge,
      path,
      labelX: (x1 + x2) / 2,
      labelY: lane - 8,
    };
  });
  return (
    <div className="us-trace-presentation">
      <TraceLotActions result={result} onOpenLot={onOpenLot} />
      <div className="us-trace-graph-scroll" tabIndex={0} role="region" aria-label={copy.current}>
        <svg
          width="1040"
          height={height}
          role="img"
          aria-label={`${copy.current}: ${result.nodes.length} ${copy.nodes}, ${result.edges.length} ${copy.edges}`}
        >
          <defs>
            <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className="us-trace-arrow" />
            </marker>
          </defs>
          {geometry.map(({ edge, path }) => (
            <g
              key={edge.id}
              data-edge-id={edge.id}
              data-edge-kind={edge.kind}
              data-from={edge.from}
              data-to={edge.to}
              className="us-trace-edge"
            >
              <title>
                {edge.id} · {copy[edge.kind]} · {edge.eventNumber} · {copy.revision} {edge.revision}{" "}
                · {copy.line} {edge.lineNo}
              </title>
              <path d={path} markerEnd={`url(#${arrowId})`} />
            </g>
          ))}
          {/* Paint every label after every path, so longer routing trunks cannot strike it. */}
          <g className="us-trace-edge">
            {geometry.map(({ edge, labelX, labelY }) =>
              edge.quantity !== undefined ? (
                <text
                  key={edge.id}
                  data-label-edge-id={edge.id}
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                >
                  {edge.quantity} {edge.unitOfMeasure}
                </text>
              ) : null,
            )}
          </g>
          {placed.map(({ node, x, y }) => (
            <g
              key={node.id}
              className={`us-trace-node us-trace-node-${node.kind}`}
              data-node-id={node.id}
            >
              <title>
                {copy[node.kind]} · {nodeDisplay(node)} · {node.id}
              </title>
              {node.kind === "transformation" ? (
                <polygon
                  points={`${x - 136},${y} ${x - 108},${y - 46} ${x + 108},${y - 46} ${x + 136},${y} ${x + 108},${y + 46} ${x - 108},${y + 46}`}
                />
              ) : node.kind === "location" ? (
                <ellipse cx={x} cy={y} rx="136" ry="46" />
              ) : (
                <rect
                  x={x - 136}
                  y={y - 46}
                  width="272"
                  height="92"
                  rx={node.kind === "lot" ? 8 : 0}
                />
              )}
              <text x={x} y={y - 20} textAnchor="middle">
                {copy[node.kind]}
              </text>
              <text x={x} y={y + 3} textAnchor="middle">
                {nodeDisplay(node).slice(0, 30)}
                {nodeDisplay(node).length > 30 ? "…" : ""}
              </text>
              <text x={x} y={y + 25} textAnchor="middle" className="us-trace-node-reference">
                {node.kind === "lot"
                  ? node.lotId.slice(-12)
                  : node.kind === "material"
                    ? `${copy.line} ${node.lineNo}`
                    : node.id.slice(-12)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {result.edges.length === 0 ? (
        <p>{copy.empty}</p>
      ) : (
        <div role="group" aria-label={copy.eventActions} className="us-trace-event-actions">
          {traceRows(result).map((edge) => (
            <div key={edge.id}>
              <TraceEventAction edge={edge} onOpenEvent={onOpenEvent} />
              <time dateTime={edge.eventDate}>{traceCivilDate(edge.eventDate, i18n.language)}</time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
