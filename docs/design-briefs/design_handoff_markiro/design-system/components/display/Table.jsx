import React from "react";
import { Icon } from "../icons/Icon.jsx";

/* columns: [{key, title, width, align, mono, render}] */
export function Table({ columns = [], rows = [], sortKey, sortDir, onSort, page, pageCount, onPage, empty, style }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-3)", background: "var(--surface-card)", overflow: "hidden", ...style }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "var(--surface-panel)" }}>
            {columns.map((c) => (
              <th key={c.key} onClick={c.sortable && onSort ? () => onSort(c.key) : undefined}
                style={{
                  textAlign: c.align || "left", padding: "10px 16px", font: "var(--text-caption)",
                  color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.05em",
                  cursor: c.sortable ? "pointer" : "default", whiteSpace: "nowrap", width: c.width,
                  userSelect: "none",
                }}>
                {c.title}
                {sortKey === c.key && <span style={{ marginLeft: 4 }}>{sortDir === "desc" ? "↓" : "↑"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} style={{ padding: "48px 16px", textAlign: "center", color: "var(--fg-3)", font: "var(--text-body)" }}>
              {empty || "Пока пусто"}
            </td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={r.id ?? i} style={{ borderTop: "1px solid var(--line)" }}>
              {columns.map((c) => (
                <td key={c.key} style={{
                  padding: "11px 16px", textAlign: c.align || "left",
                  font: c.mono ? "var(--text-code)" : "var(--text-body)",
                  fontVariantNumeric: "tabular-nums", color: "var(--fg-1)", whiteSpace: "nowrap",
                }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--line)" }}>
          <button disabled={page <= 1} onClick={() => onPage && onPage(page - 1)}
            style={{ border: "1px solid var(--line-strong)", background: "var(--surface-card)", borderRadius: "var(--r-1)", width: 28, height: 28, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: page <= 1 ? 0.4 : 1, color: "var(--fg-2)" }}>
            <Icon name="chevron-left" size={14} />
          </button>
          <span style={{ font: "var(--text-meta)", color: "var(--fg-3)", fontVariantNumeric: "tabular-nums" }}>{page} / {pageCount}</span>
          <button disabled={page >= pageCount} onClick={() => onPage && onPage(page + 1)}
            style={{ border: "1px solid var(--line-strong)", background: "var(--surface-card)", borderRadius: "var(--r-1)", width: 28, height: 28, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: page >= pageCount ? 0.4 : 1, color: "var(--fg-2)" }}>
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
