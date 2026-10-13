import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  FilterBar,
  Input,
  PageHeader,
  RowActions,
  Select,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { employeeUpdate } from "../../host/requests.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { CreateOperatorDialog } from "../operators/CreateOperatorDialog.js";
import { LoadError, PageLoading } from "../page-state.js";
import { ArchiveStatus, useStoreRecord } from "../records.js";
import { EmployeeDialog } from "./EmployeeDialog.js";
import { EmployeeOperatorDialog } from "./EmployeeOperatorDialog.js";
import {
  EMPLOYEE_FILTERS,
  findEmployees,
  freeOperators,
  operatorLabel,
  operatorStateLabel,
  type EmployeeFilter,
} from "./employee-records.js";

type EmployeesDialog =
  | { kind: "create" }
  | { kind: "edit"; employee: EmployeeRecord }
  | { kind: "link"; employee: EmployeeRecord }
  | { kind: "newOperator"; employee: EmployeeRecord };

interface Notice {
  tone: "ok" | "error";
  text: string;
}

/**
 * Employees (owner feedback on the first beta, «как в вебе»; administrators
 * only, the route is wrapped in `RequireRole`): the site's register of
 * people and the operator each one is. The link grants nothing: an operator
 * signs in with its own personnel number, PIN and badges, and the stations'
 * copies do not change. There is no delete: an employee is archived, which
 * also unlinks it.
 */
export function EmployeesPage() {
  const { t } = useTranslation();
  const employees = useOfficeQuery(officeKeys.employees, (api, token) => api.listEmployees(token));
  const operators = useOfficeQuery(officeKeys.operators, (api, token) => api.listOperators(token));
  const store = useStoreRecord<EmployeeRecord>(officeKeys.employees);
  const storeOperator = useStoreRecord<OfficeOperator>(officeKeys.operators);
  const link = useOfficeMutation(
    (api, token, variables: { employee: EmployeeRecord; operatorId: string }) =>
      api.updateEmployee(
        token,
        variables.employee.id,
        employeeUpdate(variables.employee, {
          name: variables.employee.name,
          role: variables.employee.role,
          operatorId: variables.operatorId,
          archived: false,
        }),
      ),
  );
  const [dialog, setDialog] = useState<EmployeesDialog | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EmployeeFilter>("all");

  const open = (next: EmployeesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (employee: EmployeeRecord, text: string) => {
    store(employee);
    setDialog(null);
    setNotice({ tone: "ok", text });
  };
  const reload = () => {
    setDialog(null);
    void employees.refetch();
    void operators.refetch();
  };
  const operatorOf = (employee: EmployeeRecord) =>
    employee.operatorId === null
      ? null
      : (operators.data?.find((operator) => operator.id === employee.operatorId) ?? null);

  // The operator form closed with a new operator: link it to its employee.
  const operatorCreated = async (employee: EmployeeRecord, operator: OfficeOperator) => {
    storeOperator(operator);
    setDialog(null);
    const values = { operator: operatorLabel(operator), name: employee.name };
    try {
      store(await link.mutateAsync({ employee, operatorId: operator.id }));
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("office.employees.link.createdNotLinked", {
          ...values,
          reason: t(errorMessageKey(error)),
        }),
      });
      void employees.refetch();
      return;
    }
    setNotice({ tone: "ok", text: t("office.employees.link.createdLinked", values) });
  };

  const columns: TableColumn<EmployeeRecord>[] = [
    { key: "name", title: t("office.employees.table.name"), render: (employee) => employee.name },
    {
      key: "role",
      title: t("office.employees.table.role"),
      render: (employee) => employee.role ?? t("office.common.none"),
    },
    {
      key: "operator",
      title: t("office.employees.table.operator"),
      render: (employee) => {
        if (employee.operatorId === null) return t("office.employees.noOperator");
        const operator = operatorOf(employee);
        return operator === null ? t("office.common.none") : operatorStateLabel(operator, t);
      },
    },
    {
      key: "status",
      title: t("office.employees.table.status"),
      render: (employee) => <ArchiveStatus archived={employee.archived} />,
    },
    {
      key: "actions",
      title: t("office.employees.table.actions"),
      render: (employee) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.employees.editNamed", { name: employee.name })}
            onClick={() => open({ kind: "edit", employee })}
          >
            {t("office.employees.edit")}
          </Button>
          {!employee.archived && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.employees.operatorNamed", { name: employee.name })}
              onClick={() => open({ kind: "link", employee })}
            >
              {t("office.employees.operator")}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (employees.isPending || operators.isPending) return <PageLoading />;
    if (employees.isError || operators.isError) {
      return (
        <LoadError
          error={employees.error ?? operators.error}
          onRetry={() => {
            if (employees.isError) void employees.refetch();
            if (operators.isError) void operators.refetch();
          }}
        />
      );
    }
    const found = findEmployees(employees.data, operators.data, search, filter);
    return (
      <>
        <FilterBar
          label={t("office.employees.filters")}
          resultSummary={t("office.employees.found", {
            shown: found.length,
            total: employees.data.length,
          })}
        >
          <Input
            label={t("office.employees.search")}
            hint={t("office.employees.searchHint")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            native
            label={t("office.employees.linkFilter")}
            options={EMPLOYEE_FILTERS.map((value) => ({
              value,
              label: t(`office.employees.linkFilters.${value}`),
            }))}
            value={filter}
            onValueChange={setFilter}
          />
        </FilterBar>
        <Card>
          <Table
            columns={columns}
            rows={found}
            getRowKey={(employee) => employee.id}
            empty={t(
              employees.data.length === 0
                ? "office.employees.empty"
                : "office.employees.nothingFound",
            )}
            scrollLabel={t("office.employees.title")}
          />
          <p className="office-note">{t("office.employees.note")}</p>
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.employees.title")}
        actions={
          <Button onClick={() => open({ kind: "create" })}>{t("office.employees.add")}</Button>
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {content()}
      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <EmployeeDialog
          employee={dialog.kind === "edit" ? dialog.employee : null}
          operator={dialog.kind === "edit" ? operatorOf(dialog.employee) : null}
          onClose={() => setDialog(null)}
          onSaved={(employee) =>
            saved(
              employee,
              dialog.kind === "create"
                ? t("office.employees.created", { name: employee.name })
                : t("office.common.saved"),
            )
          }
          onReload={reload}
        />
      )}
      {dialog?.kind === "link" && (
        <EmployeeOperatorDialog
          employee={dialog.employee}
          linked={operatorOf(dialog.employee)}
          free={freeOperators(operators.data ?? [], employees.data ?? [])}
          onClose={() => setDialog(null)}
          onSaved={(employee) => {
            const operator = operatorOf(employee);
            saved(
              employee,
              operator === null
                ? t("office.employees.unlink.done", { name: employee.name })
                : t("office.employees.link.linked", {
                    name: employee.name,
                    operator: operatorLabel(operator),
                  }),
            );
          }}
          onNewOperator={() => setDialog({ kind: "newOperator", employee: dialog.employee })}
          onReload={reload}
        />
      )}
      {dialog?.kind === "newOperator" && (
        <CreateOperatorDialog
          initial={{ name: dialog.employee.name, role: dialog.employee.role }}
          onClose={() => setDialog(null)}
          onCreated={(operator) => void operatorCreated(dialog.employee, operator)}
        />
      )}
    </>
  );
}
