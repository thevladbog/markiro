import { Table, type TableColumn } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import {
  nodeDisplay,
  traceCivilDate,
  traceRows,
  type TraceEdge,
  type TracePresentationProps,
} from "./projection.js";
import { TraceEventAction, TraceLotActions } from "./actions.js";
import { presentationCopy } from "./presentation-copy.js";
import "./trace.css";

export function TraceTable({ result, onOpenLot, onOpenEvent }: TracePresentationProps) {
  const { i18n } = useTranslation();
  const copy = presentationCopy(i18n.language);
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  function endpoint(id: string) {
    const node = nodes.get(id);
    return (
      <>
        <span>{node ? `${copy[node.kind]} · ${nodeDisplay(node)}` : id}</span>
        <code className="us-trace-id">{id}</code>
      </>
    );
  }
  const columns: TableColumn<TraceEdge>[] = [
    {
      key: "id",
      title: copy.edge,
      wrap: true,
      render: (edge) => <code data-edge-id={edge.id}>{edge.id}</code>,
    },
    { key: "from", title: copy.from, wrap: true, render: (edge) => endpoint(edge.from) },
    { key: "to", title: copy.to, wrap: true, render: (edge) => endpoint(edge.to) },
    { key: "kind", title: copy.kind, wrap: true, render: (edge) => copy[edge.kind] },
    {
      key: "quantity",
      title: copy.quantity,
      render: (edge) =>
        edge.quantity === undefined ? "—" : `${edge.quantity} ${edge.unitOfMeasure}`,
    },
    {
      key: "event",
      title: copy.event,
      wrap: true,
      render: (edge) => <TraceEventAction edge={edge} onOpenEvent={onOpenEvent} />,
    },
    {
      key: "eventDate",
      title: copy.date,
      render: (edge) => (
        <time dateTime={edge.eventDate}>{traceCivilDate(edge.eventDate, i18n.language)}</time>
      ),
    },
  ];
  return (
    <div className="us-trace-presentation">
      <TraceLotActions result={result} onOpenLot={onOpenLot} />
      <Table
        className="us-trace-table"
        rows={traceRows(result)}
        columns={columns}
        scrollLabel={copy.table}
        empty={copy.empty}
      />
    </div>
  );
}
