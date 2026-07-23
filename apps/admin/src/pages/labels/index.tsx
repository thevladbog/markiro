import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Badge, EmptyState, PageHeader, Spinner } from "@markiro/ui";

import { useLabelTemplates, type LabelTemplateSummaryDto } from "./api.js";
import { TemplateThumb } from "./TemplateThumb.js";

const LANGUAGE_LABEL: Record<LabelTemplateSummaryDto["language"], string> = {
  zpl: "ZPL",
  tspl: "TSPL",
};

/**
 * Primary-CTA styling shared by the page-header "add" action, the
 * EmptyState's action, and (implicitly, via its own dashed-border style
 * below) the "+ Новый шаблон" grid tile. All three are plain `<Link>`s
 * rather than a `<button>` nested inside an `<a>`: nesting interactive
 * content is invalid HTML (and would give this page two overlapping click
 * targets), so a single real `<a href="/labels/new">` is used everywhere,
 * matching `@markiro/ui`'s `Button` (`variant="primary"`) visually via its
 * own design tokens. The editor route (`/labels/new`, `/labels/:id`) is
 * wired in a later task (Task 10) per the plan brief -- these links may
 * 404 in dev until then; this screen's own tests only assert their `href`.
 */
const PRIMARY_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: "var(--control-md)",
  padding: "0 16px",
  borderRadius: "var(--r-2)",
  background: "var(--surface-inverse)",
  color: "var(--fg-on-inverse)",
  border: "1px solid var(--surface-inverse)",
  font: "600 14px/1 var(--font-ui)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const CARD_LINK_STYLE: CSSProperties = { textDecoration: "none", color: "inherit" };

const CARD_STYLE: CSSProperties = {
  background: "var(--surface-card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-3)",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  height: "100%",
  boxSizing: "border-box",
};

const NEW_TEMPLATE_CARD_STYLE: CSSProperties = {
  border: "1px dashed var(--line-strong)",
  borderRadius: "var(--r-3)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 200,
  color: "var(--fg-3)",
  font: "600 14px/20px var(--font-ui)",
  textDecoration: "none",
  textAlign: "center",
};

/**
 * Admin label template library -- Plan 04 Task 8. Card grid: thumbnail
 * (Task 9's real renderer, via `TemplateThumb`), name, size/DPI/language
 * badges, and a trailing "+ Новый шаблон" tile, per the handoff admin
 * prototype's "Этикетки" screen. List/loading/error/empty states follow
 * the same pattern as `pages/counterparties/index.tsx` (Plan 03).
 */
export function LabelTemplatesPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useLabelTemplates();
  const items = data ?? [];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.labels.title")}
        actions={
          <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
            {t("pages.labels.addAction")}
          </Link>
        }
      />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.labels.emptyTitle")}
          hint={t("pages.labels.emptyHint")}
          action={
            <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
              {t("pages.labels.addAction")}
            </Link>
          }
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {items.map((item) => (
            <Link key={item.id} to={`/labels/${item.id}`} style={CARD_LINK_STYLE}>
              <div style={CARD_STYLE}>
                <TemplateThumb id={item.id} widthMm={item.widthMm} heightMm={item.heightMm} />
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ font: "600 14px/20px var(--font-ui)", color: "var(--fg-1)" }}>
                    {item.name}
                  </span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Badge>
                      {t("pages.labels.sizeBadge", { width: item.widthMm, height: item.heightMm })}
                    </Badge>
                    <Badge>{t("pages.labels.dpiBadge", { dpi: item.dpi })}</Badge>
                    <Badge>{LANGUAGE_LABEL[item.language]}</Badge>
                  </div>
                </div>
              </div>
            </Link>
          ))}
          <Link to="/labels/new" style={NEW_TEMPLATE_CARD_STYLE}>
            {t("pages.labels.newTemplateCard")}
          </Link>
        </div>
      )}
    </div>
  );
}
