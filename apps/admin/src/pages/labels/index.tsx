import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Badge, Button, EmptyState, PageHeader, Spinner } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useChzProductGroups, type ChzProductGroupDto } from "../catalog/api.js";
import { useLabelTemplates, useUpdateLabelTemplate, type LabelTemplateSummaryDto } from "./api.js";
import { describeDefaultConflict, describeTemplateScope } from "./scope.js";
import { TemplateThumb } from "./TemplateThumb.js";

/**
 * Primary-CTA styling shared by the page-header "add" action, the
 * EmptyState's action, and (implicitly, via its own dashed-border style
 * below) the "+ Новый шаблон" grid tile. All three are plain `<Link>`s
 * rather than nesting one interactive control inside another: nesting
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

type LibraryFilter = "all" | "enabled" | "disabled";

const FILTERS: LibraryFilter[] = ["all", "enabled", "disabled"];

const FILTER_LABEL_KEY: Record<LibraryFilter, string> = {
  all: "pages.labels.filterAll",
  enabled: "pages.labels.filterEnabled",
  disabled: "pages.labels.filterDisabled",
};

function TemplateCard({
  item,
  groups,
  canWrite,
}: {
  item: LabelTemplateSummaryDto;
  groups: ChzProductGroupDto[];
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateLabelTemplate();
  const scope = describeTemplateScope(item.chzProductGroupCodes, groups, t);

  async function toggle(): Promise<void> {
    const enabled = !item.enabled;
    try {
      await update.mutateAsync({ id: item.id, input: { enabled } });
      toast(
        "ok",
        t(enabled ? "pages.labels.toasts.enableSuccess" : "pages.labels.toasts.disableSuccess"),
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "LABEL_TEMPLATE_IS_DEFAULT") {
        toast("error", describeDefaultConflict(error.details, groups, t), 8000);
        return;
      }
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.labels.toasts.toggleError"),
      );
    }
  }

  // The card is a <div>; only the thumbnail + name are the link, so the
  // toggle <button> never nests inside an <a>.
  const body = (
    <>
      <TemplateThumb id={item.id} widthMm={item.widthMm} heightMm={item.heightMm} />
      <span style={{ font: "600 14px/20px var(--font-ui)", color: "var(--fg-1)" }}>
        {item.name}
      </span>
    </>
  );

  return (
    <div style={CARD_STYLE}>
      {canWrite ? (
        <Link
          to={`/labels/${item.id}`}
          style={{ ...CARD_LINK_STYLE, display: "flex", flexDirection: "column", gap: 12 }}
        >
          {body}
        </Link>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{body}</div>
      )}
      {/* Size and DPI only: a template has no language of its own -- it
          prints on Zebra and TSC alike and the station picks the language
          from its own printer (spec 2026-08-20), so no card badges one. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Badge>
          {t("pages.labels.sizeBadge", {
            width: item.widthMm.toFixed(1),
            height: item.heightMm.toFixed(1),
          })}
        </Badge>
        <Badge>{t("pages.labels.dpiBadge", { dpi: item.dpi })}</Badge>
        <Badge
          {...(scope.title ? { title: scope.title } : {})}
          style={{
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {scope.label}
        </Badge>
        {item.enabled ? null : <Badge tone="neutral">{t("pages.labels.disabledBadge")}</Badge>}
      </div>
      {canWrite ? (
        <Button
          type="button"
          variant="secondary"
          loading={update.isPending}
          onClick={() => void toggle()}
        >
          {t(item.enabled ? "pages.labels.disableAction" : "pages.labels.enableAction")}
        </Button>
      ) : null}
    </div>
  );
}

export function LabelTemplatesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError } = useLabelTemplates({ enabled: "all" });
  const groupsQuery = useChzProductGroups();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const items = data ?? [];
  const groups = groupsQuery.data ?? [];
  const visible = items.filter((item) =>
    filter === "all" ? true : filter === "enabled" ? item.enabled : !item.enabled,
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.labels.title")}
        actions={
          canWrite ? (
            <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
              {t("pages.labels.addAction")}
            </Link>
          ) : null
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
            canWrite ? (
              <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
                {t("pages.labels.addAction")}
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <div
            role="group"
            aria-label={t("pages.labels.filterLabel")}
            style={{ display: "flex", gap: 8 }}
          >
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                variant={filter === value ? "primary" : "secondary"}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(FILTER_LABEL_KEY[value])}
              </Button>
            ))}
          </div>
          {visible.length === 0 ? (
            <Alert tone="info">{t("pages.labels.filterEmpty")}</Alert>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {visible.map((item) => (
                <TemplateCard key={item.id} item={item} groups={groups} canWrite={canWrite} />
              ))}
              {canWrite ? (
                <Link to="/labels/new" style={NEW_TEMPLATE_CARD_STYLE}>
                  {t("pages.labels.newTemplateCard")}
                </Link>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
