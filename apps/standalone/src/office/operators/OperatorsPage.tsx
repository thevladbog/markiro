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

import type { BadgeInfo, EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { employeesByOperator, freeEmployees } from "../employees/employee-records.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useChangeList, useStoreRecord } from "../records.js";
import { AddBadgeDialog } from "./AddBadgeDialog.js";
import { BadgesDialog } from "./BadgesDialog.js";
import { CreateOperatorDialog } from "./CreateOperatorDialog.js";
import { EditOperatorDialog } from "./EditOperatorDialog.js";
import { OperatorAccessDialog } from "./OperatorAccessDialog.js";
import { OperatorEmployeeDialog } from "./OperatorEmployeeDialog.js";
import { OperatorPinDialog } from "./OperatorPinDialog.js";
import { activeFirstByLogin, badgeLabel, withBadge, withBadgeRevoked } from "./operator-records.js";
import { RevokeBadgeDialog } from "./RevokeBadgeDialog.js";

// The badge dialogs name their operator by id and read it from the cached
// list, so the badges they show follow every change stored there.
type OperatorsDialog =
  | { kind: "create" }
  | { kind: "edit"; operator: OfficeOperator }
  | { kind: "pin"; operator: OfficeOperator }
  | { kind: "access"; operator: OfficeOperator }
  | { kind: "employee"; operator: OfficeOperator }
  | { kind: "badges"; operatorId: string; notice: string | null }
  | { kind: "addBadge"; operatorId: string }
  | { kind: "revokeBadge"; operatorId: string; badge: BadgeInfo };

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
  // Who each operator is: the employee linked to it (the link is the employee's record).
  const employees = useOfficeQuery(officeKeys.employees, (api, token) => api.listEmployees(token));
  const storeEmployee = useStoreRecord<EmployeeRecord>(officeKeys.employees);
  const linked = employeesByOperator(employees.data ?? []);
  // A badge write answers with the badge, or nothing: the change goes into the
  // cached list at once, and with no list loaded the list is read again.
  const changeList = useChangeList<OfficeOperator>(officeKeys.operators);
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
  const operatorOf = (id: string) => operators.data?.find((operator) => operator.id === id);
  const badgesOf = (operatorId: string, notice: string | null) =>
    setDialog({ kind: "badges", operatorId, notice });
  const badgeSummary = (operator: OfficeOperator) => {
    const active = operator.badges.filter((badge) => badge.revokedAt === null);
    if (active.length === 0) return t("office.operators.noBadges");
    const labels = active.map((badge) => badgeLabel(badge, t));
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
      key: "employee",
      title: t("office.operators.table.employee"),
      render: (operator) => linked.get(operator.id)?.name ?? t("office.operators.noEmployee"),
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
            aria-label={t("office.operators.badgesNamed", { name: operator.name })}
            onClick={() => open({ kind: "badges", operatorId: operator.id, notice: null })}
          >
            {t("office.operators.badgesOpen")}
          </Button>
          {employees.isSuccess && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.operators.employeeNamed", { name: operator.name })}
              onClick={() => open({ kind: "employee", operator })}
            >
              {t("office.operators.employee")}
            </Button>
          )}
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

  const badgeDialog = () => {
    if (dialog === null) return null;
    if (dialog.kind !== "badges" && dialog.kind !== "addBadge" && dialog.kind !== "revokeBadge") {
      return null;
    }
    const operator = operatorOf(dialog.operatorId);
    if (operator === undefined) return null;
    switch (dialog.kind) {
      case "badges":
        return (
          <BadgesDialog
            operator={operator}
            notice={dialog.notice}
            onAdd={() => setDialog({ kind: "addBadge", operatorId: operator.id })}
            onRevoke={(badge) => setDialog({ kind: "revokeBadge", operatorId: operator.id, badge })}
            onClose={() => setDialog(null)}
          />
        );
      case "addBadge":
        return (
          <AddBadgeDialog
            operator={operator}
            operators={operators.data ?? []}
            onClose={() => badgesOf(operator.id, null)}
            onAdded={(badge) => {
              changeList((list) => withBadge(list, operator.id, badge));
              badgesOf(
                operator.id,
                t("office.operators.badges.added", { label: badgeLabel(badge, t) }),
              );
            }}
          />
        );
      case "revokeBadge":
        return (
          <RevokeBadgeDialog
            operator={operator}
            badge={dialog.badge}
            onClose={() => badgesOf(operator.id, null)}
            onRevoked={() => {
              // Revoked now, not when the list has been read again; the host's
              // own time replaces this PC's when it has.
              changeList((list) =>
                withBadgeRevoked(list, operator.id, dialog.badge.id, new Date().toISOString()),
              );
              badgesOf(
                operator.id,
                t("office.operators.badges.revoked", { label: badgeLabel(dialog.badge, t) }),
              );
              void operators.refetch();
            }}
          />
        );
    }
  };

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
      {dialog?.kind === "employee" && (
        <OperatorEmployeeDialog
          operator={dialog.operator}
          linked={linked.get(dialog.operator.id) ?? null}
          free={freeEmployees(employees.data ?? [])}
          onClose={() => setDialog(null)}
          onSaved={(employee, outcome) => {
            storeEmployee(employee);
            setDialog(null);
            const values = { name: dialog.operator.name, employee: employee.name };
            setNotice(
              t(
                outcome === "create"
                  ? "office.operators.link.createdLinked"
                  : outcome === "link"
                    ? "office.operators.link.linked"
                    : "office.operators.link.unlinked",
                values,
              ),
            );
          }}
          onReload={() => {
            setDialog(null);
            void employees.refetch();
          }}
        />
      )}
      {badgeDialog()}
    </>
  );
}
