import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, Table } from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { useConflicts, useReviewConflict, type ConflictDto } from "./api.js";

/**
 * Cabinet-only backstop for the conflict class a station never learns it
 * lost: the losing terminal's batch was already acknowledged, so the server
 * deliberately never tells that device -- `code_conflicts` (and this view)
 * is the only record a human ever sees of it. See 06b Task 7's brief and
 * `apps/api/src/modules/conflicts/conflicts.controller.ts`.
 */
export function ConflictsPage() {
  const { t, i18n } = useTranslation();

  const { data, isPending, isError } = useConflicts();
  const reviewMutation = useReviewConflict();

  const items = data ?? [];

  const handleReview = async (id: string) => {
    try {
      await reviewMutation.mutateAsync(id);
      toast("ok", t("pages.conflicts.toasts.reviewSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.conflicts.toasts.reviewError"),
      );
    }
  };

  const columns: TableColumn<ConflictDto>[] = useMemo(
    () => [
      {
        key: "codeHash",
        title: t("pages.conflicts.table.code"),
        mono: true,
        render: (row) => row.codeHash,
      },
      {
        key: "losing",
        title: t("pages.conflicts.table.losing"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.losingTerminalId ?? "—"}</span>
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatCreatedAt(row.losingScannedAt, i18n.language)}
            </span>
          </div>
        ),
      },
      {
        key: "winning",
        title: t("pages.conflicts.table.winning"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.winningTerminalId ?? "—"}</span>
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatCreatedAt(row.winningScannedAt, i18n.language)}
            </span>
          </div>
        ),
      },
      {
        key: "detectedAt",
        title: t("pages.conflicts.table.detected"),
        render: (row) => formatCreatedAt(row.detectedAt, i18n.language),
      },
      {
        key: "actions",
        title: t("pages.conflicts.table.actions"),
        align: "right",
        render: (row) =>
          row.reviewedAt ? (
            <Badge tone="neutral">{t("pages.conflicts.reviewed")}</Badge>
          ) : (
            <Button
              type="button"
              size="compact"
              variant="secondary"
              loading={reviewMutation.isPending && reviewMutation.variables === row.id}
              onClick={() => void handleReview(row.id)}
            >
              {t("pages.conflicts.review")}
            </Button>
          ),
      },
    ],
    [t, i18n.language, reviewMutation.isPending, reviewMutation.variables],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.conflicts.title")} />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("pages.conflicts.empty")} />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}
