import type {
  ChzStatusKey,
  ImportItem,
  ImportItemsQuery,
  ImportItemsResponse,
  ImportSession,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select, Spinner, Table } from "@markiro/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatCreatedAt } from "../../../lib/datetime.js";
import { selectionWithPage } from "./reviewState.js";
export const initialItemsQuery: ImportItemsQuery = {
  cursor: null,
  search: "",
  statuses: [],
  includeArchived: false,
  limit: 25,
};
export function ImportSelection({
  session,
  data,
  query,
  onQuery,
  onSelection,
  onPrepare,
  canWrite,
  busy,
}: {
  session: ImportSession;
  data: ImportItemsResponse;
  query: ImportItemsQuery;
  onQuery: (q: ImportItemsQuery) => void;
  onSelection: (ids: string[]) => void;
  onPrepare: () => void;
  canWrite: boolean;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.import.${key}`);
  const loading = session.automaticWorkPending || ["queued", "loading"].includes(session.state);
  const emptyKey = !session.complete
    ? "listUnavailable"
    : query.search || query.statuses.length
      ? "emptyFilteredList"
      : "emptyList";
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [limitError, setLimitError] = useState(false);
  const selectable = data.items
    .filter((item) => item.selectable && !item.statusKeys.includes("archived"))
    .map((item) => item.id);
  function select(ids: string[], checked: boolean) {
    const next = selectionWithPage(session.selectedItemIds, ids, checked);
    setLimitError(next === null);
    if (next) onSelection(next);
  }
  function filter(q: ImportItemsQuery) {
    setPrevious([]);
    onQuery({ ...q, cursor: null });
  }
  return (
    <section aria-label={tr("selection")} className="mk-nc-selection">
      <header className="mk-nc-section-heading">
        <h2>{tr("selection")}</h2>
        <div className="mk-nc-meta">
          <span>{t("pages.catalog.import.loadedCount", { count: session.loaded })}</span>
          <span>
            {tr("loadStarted")}:{" "}
            <time dateTime={session.startedAt}>
              {formatCreatedAt(session.startedAt, i18n.language)}
            </time>
          </span>
        </div>
      </header>
      {loading ? (
        <div className="mk-nc-progress" role="status" aria-label={tr("loadingList")}>
          <Spinner aria-hidden="true" />
          <div>
            <p>{tr("loadingList")}</p>
            <p className="mk-nc-hint">{tr("loadingListHint")}</p>
          </div>
        </div>
      ) : !session.complete ? (
        <Alert tone="warn">{tr(session.loaded ? "partialList" : "listUnavailable")}</Alert>
      ) : null}
      {session.reason === "session_row_limit" && <Alert tone="warn">{tr("sessionRowLimit")}</Alert>}
      {limitError && <Alert tone="error">{tr("limit")}</Alert>}
      <div className="mk-nc-filters">
        <Input
          label={tr("searchLoaded")}
          maxLength={500}
          value={query.search}
          onChange={(e) => filter({ ...query, search: e.target.value })}
        />
        <Select
          native
          label={tr("status")}
          value={query.statuses[0] ?? ""}
          options={[
            { value: "", label: tr("allStatuses") },
            ...(
              [
                "draft",
                "moderation",
                "errors",
                "unsigned",
                "published",
                "archived",
                "unknown",
              ] as ChzStatusKey[]
            ).map((value) => ({ value, label: tr(`statuses.${value}`) })),
          ]}
          onValueChange={(value) =>
            filter({
              ...query,
              statuses: value ? [value] : [],
              includeArchived: value === "archived",
            })
          }
        />
      </div>
      <div className="mk-nc-selection-toolbar">
        <p aria-live="polite">
          {t("pages.catalog.import.selectionCount", { count: session.selectedItemIds.length })}
        </p>
        {canWrite && (
          <Checkbox
            label={t("pages.catalog.import.selectPage", { count: selectable.length })}
            disabled={busy || !selectable.length}
            checked={
              selectable.length > 0 &&
              selectable.every((id) => session.selectedItemIds.includes(id))
            }
            onCheckedChange={(checked) => select(selectable, checked)}
          />
        )}
      </div>
      <Table<ImportItem>
        className="mk-nc-selection-table"
        empty={
          loading
            ? tr("waitingForProducts")
            : session.complete
              ? tr(emptyKey)
              : tr("noLoadedProducts")
        }
        columns={[
          {
            key: "name",
            title: tr("product"),
            wrap: true,
            render: (item) => (
              <div className="mk-nc-product-cell">
                <Checkbox
                  label={`${item.gtin14 ?? item.input ?? "—"} · ${item.name ?? tr("unnamed")}`}
                  checked={session.selectedItemIds.includes(item.id)}
                  disabled={
                    !canWrite || busy || !item.selectable || item.statusKeys.includes("archived")
                  }
                  onCheckedChange={(checked) => select([item.id], checked)}
                />
                <div className="mk-nc-product-details">
                  {item.brand && <p>{item.brand}</p>}
                  <p>{item.statusKeys.map((status) => tr(`statuses.${status}`)).join(" · ")}</p>
                  {item.productId && (
                    <Link to={`/catalog/${item.productId}/edit`}>{tr("openProduct")}</Link>
                  )}
                </div>
              </div>
            ),
          },
          {
            key: "match",
            title: tr("match"),
            wrap: true,
            render: (item) => (
              <div className="mk-nc-match-cell">
                {tr(`matches.${item.match}`)}
                {item.reason && (
                  <p>
                    {t(`pages.catalog.import.reasons.${item.reason}`, {
                      defaultValue: tr("itemUnavailable"),
                    })}
                  </p>
                )}
                {item.statusKeys.includes("archived") && <p>{tr("archivedReadOnly")}</p>}
              </div>
            ),
          },
        ]}
        rows={data.items}
      />
      <div className="mk-nc-selection-footer">
        <div className="mk-nc-actions">
          <Button
            variant="secondary"
            disabled={busy || !previous.length}
            onClick={() => {
              onQuery({ ...query, cursor: previous.at(-1) ?? null });
              setPrevious(previous.slice(0, -1));
            }}
          >
            {tr("previousPage")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !data.nextCursor}
            onClick={() => {
              setPrevious([...previous, query.cursor]);
              onQuery({ ...query, cursor: data.nextCursor });
            }}
          >
            {tr("nextPage")}
          </Button>
        </div>
        {canWrite && (
          <Button
            variant="primary"
            disabled={busy || !session.selectedItemIds.length}
            onClick={onPrepare}
          >
            {tr("compare")}
          </Button>
        )}
      </div>
    </section>
  );
}
