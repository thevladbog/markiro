import type {
  ChzStatusKey,
  ImportItem,
  ImportItemsQuery,
  ImportItemsResponse,
  ImportSession,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select, Table } from "@markiro/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
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
  const { t } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.import.${key}`);
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
    <section aria-label={tr("selection")}>
      <h2>{tr("selection")}</h2>
      {!session.complete && <Alert>{tr("partialList")}</Alert>}
      <p aria-live="polite">
        {t("pages.catalog.import.selectionCount", { count: session.selectedItemIds.length })}
      </p>
      {limitError && <Alert tone="error">{tr("limit")}</Alert>}
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
      {canWrite && (
        <Checkbox
          label={t("pages.catalog.import.selectPage", { count: selectable.length })}
          disabled={busy || !selectable.length}
          checked={
            selectable.length > 0 && selectable.every((id) => session.selectedItemIds.includes(id))
          }
          onCheckedChange={(checked) => select(selectable, checked)}
        />
      )}
      <Table<ImportItem>
        columns={[
          {
            key: "name",
            title: tr("product"),
            wrap: true,
            render: (item) => (
              <>
                <Checkbox
                  label={`${item.gtin14 ?? item.input ?? "—"} · ${item.name ?? tr("unnamed")}`}
                  checked={session.selectedItemIds.includes(item.id)}
                  disabled={
                    !canWrite || busy || !item.selectable || item.statusKeys.includes("archived")
                  }
                  onCheckedChange={(checked) => select([item.id], checked)}
                />
                {item.productId && (
                  <Link to={`/catalog/${item.productId}/edit`}>{tr("openProduct")}</Link>
                )}
              </>
            ),
          },
          {
            key: "match",
            title: tr("match"),
            wrap: true,
            render: (item) => (
              <>
                {tr(`matches.${item.match}`)}
                {item.reason && (
                  <p>
                    {t(`pages.catalog.import.reasons.${item.reason}`, {
                      defaultValue: tr("itemUnavailable"),
                    })}
                  </p>
                )}
                {item.statusKeys.includes("archived") && <p>{tr("archivedReadOnly")}</p>}
              </>
            ),
          },
        ]}
        rows={data.items}
      />
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
    </section>
  );
}
