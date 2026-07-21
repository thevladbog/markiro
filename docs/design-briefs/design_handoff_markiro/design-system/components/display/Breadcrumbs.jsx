import React from "react";

export function Breadcrumbs({ items = [], style }) {
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body-sm)", ...style }}>
      {items.map((it, i) => {
        const last = i === items.length - 1;
        const label = typeof it === "string" ? it : it.label;
        const onClick = typeof it === "string" ? undefined : it.onClick;
        return (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: "var(--fg-disabled)" }}>/</span>}
            {last ? (
              <span style={{ color: "var(--fg-1)", fontWeight: 600 }}>{label}</span>
            ) : (
              <a onClick={onClick} style={{ color: "var(--fg-3)", cursor: "pointer", textDecoration: "none" }}>{label}</a>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
