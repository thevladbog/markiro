import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Card, Checkbox, type TableColumn } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { PalletAssemblyCloseIssue } from "../../host/pallet-assembly.js";
import { FormDialog } from "../FormDialog.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, WriteFailureAlert } from "../page-state.js";
import { PagedTable } from "../paging/PagedTable.js";
import "./warehouse-pallet-issues.css";

type Decision = { issue: PalletAssemblyCloseIssue; action: "approve_reclose" | "cancel" };

function PalletIssueDialog({ decision, onClose }: { decision: Decision; onClose: () => void }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const { issue, action } = decision;
  const cancel = action === "cancel";
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const resolve = useOfficeMutation((api, token, _variables: void) =>
    api.resolvePalletCloseIssue(
      token,
      issue.id,
      cancel
        ? { action: "cancel", labelRemoved: true }
        : { action: "approve_reclose", expectedBoxSsccs: issue.currentBoxSsccs },
    ),
  );

  async function submit() {
    if (!checked) return;
    setFailure(null);
    try {
      await resolve.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    await Promise.all([
      cache.invalidateQueries({ queryKey: officeKeys.warehousePalletIssues }),
      cache.invalidateQueries({ queryKey: officeKeys.warehousePallets }),
      cache.invalidateQueries({ queryKey: officeKeys.warehousePallet(issue.palletId) }),
    ]);
    onClose();
  }

  return (
    <FormDialog
      title={t(
        cancel
          ? "office.warehousePalletIssues.cancelTitle"
          : "office.warehousePalletIssues.reviewTitle",
      )}
      submitLabel={t(
        cancel ? "office.warehousePalletIssues.cancel" : "office.warehousePalletIssues.approve",
      )}
      submitVariant={cancel ? "destructive" : "primary"}
      submitDisabled={!checked}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.warehousePalletIssues.label", { sscc: issue.sscc })}</p>
      <p>
        {t(
          cancel
            ? "office.warehousePalletIssues.cancelHint"
            : "office.warehousePalletIssues.reviewHint",
        )}
      </p>
      {!cancel && (
        <ul
          className="warehouse-pallet-issue__boxes"
          aria-label={t("office.warehousePalletIssues.boxes")}
        >
          {issue.currentBoxSsccs.map((sscc) => (
            <li key={sscc}>
              <code>{sscc}</code>
            </li>
          ))}
        </ul>
      )}
      <Checkbox
        checked={checked}
        onCheckedChange={setChecked}
        label={t(
          cancel
            ? "office.warehousePalletIssues.labelRemoved"
            : "office.warehousePalletIssues.reviewed",
        )}
      />
    </FormDialog>
  );
}

export function WarehousePalletIssues() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const [decision, setDecision] = useState<Decision | null>(null);
  const list = useOfficeQuery(officeKeys.warehousePalletIssues, (api, token) =>
    api.listPalletCloseIssues(token),
  );
  if (list.isError) {
    if (list.error instanceof HostError && list.error.status === 404) return null;
    return <LoadError error={list.error} onRetry={() => void list.refetch()} />;
  }
  if (list.data === undefined || list.data.length === 0) return null;

  const columns: TableColumn<PalletAssemblyCloseIssue>[] = [
    { key: "sscc", title: "SSCC", mono: true },
    { key: "deviceName", title: t("office.warehousePallets.table.device"), wrap: true },
    {
      key: "boxes",
      title: t("office.warehousePalletIssues.boxes"),
      render: (issue) =>
        t("office.warehousePalletIssues.count", {
          reported: issue.reportedBoxes,
          current: issue.currentBoxes,
        }),
    },
    {
      key: "status",
      title: t("office.warehousePalletIssues.status"),
      render: (issue) => t(`office.warehousePalletIssues.statuses.${issue.status}`),
    },
    {
      key: "actions",
      title: t("office.warehousePalletIssues.actions"),
      render: (issue) =>
        issue.status !== "pending" && issue.status !== "approved" ? null : (
          <div className="warehouse-pallet-issue__actions">
            {issue.status === "pending" &&
              issue.code === "pallet_count_mismatch" &&
              issue.currentBoxes > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => setDecision({ issue, action: "approve_reclose" })}
                >
                  {t("office.warehousePalletIssues.review")}
                </Button>
              )}
            {user.role === "admin" && (
              <Button variant="secondary" onClick={() => setDecision({ issue, action: "cancel" })}>
                {t("office.warehousePalletIssues.cancel")}
              </Button>
            )}
          </div>
        ),
    },
  ];
  return (
    <Card className="office-stack">
      <h3>{t("office.warehousePalletIssues.title")}</h3>
      <PagedTable
        tableId="warehouse-pallet-close-issues"
        columns={columns}
        rows={list.data}
        getRowKey={(issue) => issue.id}
        scrollLabel={t("office.warehousePalletIssues.title")}
      />
      {decision !== null && (
        <PalletIssueDialog decision={decision} onClose={() => setDecision(null)} />
      )}
    </Card>
  );
}
