import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import {
  Alert,
  Button,
  DatePicker,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { useCreateDocument, useDisaggregationReasons, useDocuments, type DocumentDto } from "./api.js";

type StatusFilter = "all" | "draft" | "applied" | "cancelled";

// StatusChip only defines ok/error/warn/info/neutral tones (see
// packages/ui/src/components/StatusChip.tsx) -- "applied" maps to the
// positive "ok" tone and "cancelled" to "warn" (cancellation is a normal
// user-initiated terminal state, not a failure, so "error" would be
// misleading -- "warn" is the closest analog to a "muted/undone" tone the
// component actually exposes) so the three document states stay visually
// distinct rather than collapsing draft and cancelled onto the same neutral
// chip.
const STATUS_TO_CHIP: Record<Exclude<StatusFilter, "all">, StatusChipStatus> = {
  draft: "neutral",
  applied: "ok",
  cancelled: "warn",
};

/** Debounce delay (ms) between the last keystroke in the docNo search box and the refetch -- mirrors `pages/catalog/index.tsx`'s pattern. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Admin disaggregation document list (Task 9). Filterable summary table of
 * every disaggregation document (status/reason), mirroring
 * `pages/pickup/index.tsx`'s list pattern. Row click navigates to
 * `/disaggregation/:id` (Task 10's detail/editor page). The header's
 * "create" action posts an empty draft (`POST /disaggregation`) and
 * navigates straight to it, same shape as a kiosk's create-then-configure
 * flow.
 */
export function DisaggregationPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [docNoInput, setDocNoInput] = useState("");
  const [debouncedDocNo, setDebouncedDocNo] = useState("");
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  // Debounce the free-text docNo search so typing doesn't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedDocNo(docNoInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [docNoInput]);

  const { data, isPending, isError } = useDocuments({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(reasonFilter !== "all" ? { reasonId: reasonFilter } : {}),
    ...(debouncedDocNo ? { docNo: debouncedDocNo } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page,
  });
  const { data: reasonsData } = useDisaggregationReasons();
  const reasons = reasonsData ?? [];
  const createMutation = useCreateDocument();

  const items = data?.items ?? [];

  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.disaggregation.filters.status.all") },
    { value: "draft", label: t("pages.disaggregation.status.draft") },
    { value: "applied", label: t("pages.disaggregation.status.applied") },
    { value: "cancelled", label: t("pages.disaggregation.status.cancelled") },
  ];

  const reasonOptions: SelectOption<string>[] = [
    { value: "all", label: t("pages.disaggregation.filters.reason.all") },
    ...reasons.map((reason) => ({ value: reason.id, label: reason.name })),
  ];

  const columns: TableColumn<DocumentDto>[] = [
    { key: "docNo", title: t("pages.disaggregation.table.docNo"), mono: true },
    {
      key: "createdAt",
      title: t("pages.disaggregation.table.createdAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.createdAt, i18n.language),
    },
    {
      key: "status",
      title: t("pages.disaggregation.table.status"),
      render: (row) => (
        <StatusChip
          status={STATUS_TO_CHIP[row.status]}
          label={t(`pages.disaggregation.status.${row.status}`)}
        />
      ),
    },
    {
      key: "reasonName",
      title: t("pages.disaggregation.table.reason"),
      render: (row) => row.reasonName ?? "—",
    },
    { key: "lineCount", title: t("pages.disaggregation.table.lineCount"), align: "right" },
    { key: "codeCount", title: t("pages.disaggregation.table.codeCount"), align: "right" },
    {
      key: "createdByName",
      title: t("pages.disaggregation.table.author"),
      render: (row) => row.createdByName ?? "—",
    },
  ];

  const handleCreate = () => {
    createMutation.mutate(undefined, {
      onSuccess: (doc) => void navigate(`/disaggregation/${doc.id}`),
    });
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.disaggregation.title")}
        actions={
          <>
            <Link to="/disaggregation/reasons" style={{ color: "var(--link)" }}>
              {t("pages.disaggregation.reasonsLink")}
            </Link>
            {canWrite ? (
              <Button type="button" loading={createMutation.isPending} onClick={handleCreate}>
                {t("pages.disaggregation.create")}
              </Button>
            ) : null}
          </>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.disaggregation.filters.statusLabel")}
            options={statusOptions}
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.disaggregation.filters.reasonLabel")}
            options={reasonOptions}
            value={reasonFilter}
            onValueChange={(value) => {
              setReasonFilter(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 220 }}>
          <Input
            label={t("pages.disaggregation.filters.docNoLabel")}
            placeholder={t("pages.disaggregation.filters.docNoPlaceholder")}
            value={docNoInput}
            onChange={(event) => {
              setDocNoInput(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.disaggregation.filters.fromLabel")}
            {...(from !== undefined ? { value: from } : {})}
            onValueChange={(value) => {
              setFrom(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.disaggregation.filters.toLabel")}
            {...(to !== undefined ? { value: to } : {})}
            onValueChange={(value) => {
              setTo(value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("pages.disaggregation.empty")} />
      ) : (
        <Table
          columns={columns}
          rows={items}
          page={data?.page}
          pageCount={data?.pageCount}
          onPage={setPage}
          onRowClick={(row) => void navigate(`/disaggregation/${row.id}`)}
        />
      )}
    </div>
  );
}
