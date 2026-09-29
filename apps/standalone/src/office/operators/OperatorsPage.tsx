import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeOperator } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { CreateOperatorDialog } from "./CreateOperatorDialog.js";
import { EditOperatorDialog } from "./EditOperatorDialog.js";
import { OperatorAccessDialog } from "./OperatorAccessDialog.js";
import { OperatorPinDialog } from "./OperatorPinDialog.js";
import { activeFirstByLogin } from "./operator-records.js";

type OperatorsDialog =
  | { kind: "create" }
  | { kind: "edit"; operator: OfficeOperator }
  | { kind: "pin"; operator: OfficeOperator }
  | { kind: "access"; operator: OfficeOperator };

/**
 * Operators (spec §4.3, §5.5, administrators only; the route is wrapped in
 * `RequireRole`): who signs in on the stations with a personnel number and a
 * PIN, or with a badge. The office sends only hashes. There is no delete:
 * an operator is turned off instead, and the host keeps the record.
 */
export function OperatorsPage() {
  const { t } = useTranslation();
  const operators = useOfficeQuery(officeKeys.operators, (api, token) => api.listOperators(token));
  const store = useStoreRecord<OfficeOperator>(officeKeys.operators);
  const [dialog, setDialog] = useState<OperatorsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: OperatorsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (operator: OfficeOperator, message: string) => {
    store(operator);
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void operators.refetch();
  };
  const badgeSummary = (operator: OfficeOperator) => {
    const active = operator.badges.filter((badge) => badge.revokedAt === null);
    if (active.length === 0) return t("office.operators.noBadges");
    const labels = active.map((badge) => badge.label ?? t("office.operators.badges.unnamed"));
    return t("office.operators.badgeSummary", { n: active.length, labels: labels.join(", ") });
  };

  const columns: TableColumn<OfficeOperator>[] = [
    {
      key: "login",
      title: t("office.operators.table.login"),
      mono: true,
      render: (operator) => operator.login,
    },
    { key: "name", title: t("office.operators.table.name"), render: (operator) => operator.name },
    {
      key: "role",
      title: t("office.operators.table.role"),
      render: (operator) => operator.role ?? t("office.common.none"),
    },
    {
      key: "pin",
      title: t("office.operators.table.pin"),
      render: (operator) =>
        t(operator.hasPin ? "office.operators.pinSet" : "office.operators.pinUnset"),
    },
    {
      key: "badges",
      title: t("office.operators.table.badges"),
      wrap: true,
      render: badgeSummary,
    },
    {
      key: "status",
      title: t("office.operators.table.status"),
      render: (operator) => (
        <StatusChip
          phase={operator.active ? "active" : "retired"}
          label={t(
            operator.active ? "office.operators.status.active" : "office.operators.status.inactive",
          )}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.operators.table.actions"),
      render: (operator) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.editNamed", { name: operator.name })}
            onClick={() => open({ kind: "edit", operator })}
          >
            {t("office.operators.edit")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.pinNamed", { name: operator.name })}
            onClick={() => open({ kind: "pin", operator })}
          >
            {t("office.operators.pin")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t(
              operator.active
                ? "office.operators.deactivateNamed"
                : "office.operators.activateNamed",
              { name: operator.name },
            )}
            onClick={() => open({ kind: "access", operator })}
          >
            {t(operator.active ? "office.operators.deactivate" : "office.operators.activate")}
          </Button>
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (operators.isPending) return <PageLoading />;
    if (operators.isError)
      return <LoadError error={operators.error} onRetry={() => void operators.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByLogin(operators.data)}
          getRowKey={(operator) => operator.id}
          empty={t("office.operators.empty")}
          scrollLabel={t("office.operators.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.operators.title")}
        actions={
          <Button onClick={() => open({ kind: "create" })}>{t("office.operators.add")}</Button>
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {dialog?.kind === "create" && (
        <CreateOperatorDialog
          onClose={() => setDialog(null)}
          onCreated={(operator) =>
            saved(operator, t("office.operators.created", { name: operator.name }))
          }
        />
      )}
      {dialog?.kind === "edit" && (
        <EditOperatorDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) => saved(operator, t("office.common.saved"))}
          onReload={reload}
        />
      )}
      {dialog?.kind === "pin" && (
        <OperatorPinDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(operator, t("office.operators.pinChanged", { name: operator.name }))
          }
          onReload={reload}
        />
      )}
      {dialog?.kind === "access" && (
        <OperatorAccessDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(
              operator,
              t(operator.active ? "office.operators.activated" : "office.operators.deactivated", {
                name: operator.name,
              }),
            )
          }
          onReload={reload}
        />
      )}
    </>
  );
}
