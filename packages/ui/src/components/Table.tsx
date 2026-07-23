import type { CSSProperties, Key, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Port of `design-system/components/display/Table.jsx` (+ `.d.ts`) — office
 * only ("Только офис" per `Table.prompt.md`). Wrapped in a semantic
 * `<table>` with an `overflow-x:auto` scroll container, and numeric/mono
 * columns get the `font-mono nowrap` class hook (backed by the two small
 * utility classes in `components.css`) in addition to the equivalent inline
 * styles used by the handoff.
 */
export interface TableColumn<Row> {
  key: string;
  title: ReactNode;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Plex Mono + tabular-nums — числа и коды */
  mono?: boolean;
  sortable?: boolean;
  render?: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  /** Defaults to the row's `id` field (if present), falling back to index */
  getRowKey?: (row: Row, index: number) => Key;
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSort?: (key: string) => void;
  page?: number;
  pageCount?: number;
  onPage?: (page: number) => void;
  /** Empty-state content */
  empty?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

function defaultRowKey(row: unknown, index: number): Key {
  const maybeId = (row as { id?: Key } | null)?.id;
  return maybeId ?? index;
}

function cellValue<Row>(row: Row, key: string): ReactNode {
  return (row as Record<string, unknown>)[key] as ReactNode;
}

export function Table<Row>({
  columns,
  rows,
  getRowKey = defaultRowKey,
  sortKey,
  sortDir,
  onSort,
  page,
  pageCount,
  onPage,
  empty = "No data",
  className,
  style,
}: TableProps<Row>) {
  return (
    <div
      className={cn("mk-table", className)}
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        background: "var(--surface-card)",
        overflow: "hidden",
        ...style,
      }}
    >
      <div className="mk-table__scroll" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--surface-panel)" }}>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  onClick={column.sortable && onSort ? () => onSort(column.key) : undefined}
                  style={{
                    textAlign: column.align ?? "left",
                    padding: "10px 16px",
                    font: "var(--text-caption)",
                    color: "var(--fg-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    cursor: column.sortable ? "pointer" : "default",
                    whiteSpace: "nowrap",
                    width: column.width,
                    userSelect: "none",
                  }}
                >
                  {column.title}
                  {sortKey === column.key && (
                    <span aria-hidden="true" style={{ marginLeft: 4 }}>
                      {sortDir === "desc" ? "↓" : "↑"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--fg-3)",
                    font: "var(--text-body)",
                  }}
                >
                  {empty}
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <tr key={getRowKey(row, index)} style={{ borderTop: "1px solid var(--line)" }}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(column.mono && "font-mono nowrap")}
                    style={{
                      padding: "11px 16px",
                      textAlign: column.align ?? "left",
                      font: column.mono ? "var(--text-code)" : "var(--text-body)",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--fg-1)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {column.render ? column.render(row) : cellValue(row, column.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page !== undefined && pageCount !== undefined && pageCount > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "8px 12px",
            borderTop: "1px solid var(--line)",
          }}
        >
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPage?.(page - 1)}
            style={{
              border: "1px solid var(--line-strong)",
              background: "var(--surface-card)",
              borderRadius: "var(--r-1)",
              width: 28,
              height: 28,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: page <= 1 ? 0.4 : 1,
              color: "var(--fg-2)",
            }}
          >
            ‹
          </button>
          <span
            style={{
              font: "var(--text-meta)",
              color: "var(--fg-3)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {page} / {pageCount}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPage?.(page + 1)}
            style={{
              border: "1px solid var(--line-strong)",
              background: "var(--surface-card)",
              borderRadius: "var(--r-1)",
              width: 28,
              height: 28,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: page >= pageCount ? 0.4 : 1,
              color: "var(--fg-2)",
            }}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
