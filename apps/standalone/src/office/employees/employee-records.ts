import type { TFunction } from "i18next";

import type { EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { activeFirstByName, byNameThenId } from "../records.js";

/** How the office names an operator next to a person: «0042 · Анна Кузнецова». */
export function operatorLabel(operator: Pick<OfficeOperator, "login" | "name">): string {
  return `${operator.login} · ${operator.name}`;
}

/** `operatorLabel`, and «(выключен)» after an operator turned off: not by colour alone. */
export function operatorStateLabel(
  operator: Pick<OfficeOperator, "login" | "name" | "active">,
  t: TFunction,
): string {
  const label = operatorLabel(operator);
  return operator.active ? label : t("office.employees.operatorOff", { operator: label });
}

/** The employee linked to each operator, by operator id. */
export function employeesByOperator(
  employees: readonly EmployeeRecord[],
): Map<string, EmployeeRecord> {
  const linked = new Map<string, EmployeeRecord>();
  for (const employee of employees) {
    if (employee.operatorId !== null) linked.set(employee.operatorId, employee);
  }
  return linked;
}

/**
 * The operators an employee may be linked to: those no employee holds, the
 * ones turned off included (a link grants nothing), by personnel number as
 * text, as «Операторы» lists them.
 */
export function freeOperators(
  operators: readonly OfficeOperator[],
  employees: readonly EmployeeRecord[],
): OfficeOperator[] {
  const linked = employeesByOperator(employees);
  return operators
    .filter((operator) => !linked.has(operator.id))
    .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}

/** The employees an operator may be linked to: not archived and linked to none, by name. */
export function freeEmployees(employees: readonly EmployeeRecord[]): EmployeeRecord[] {
  return employees
    .filter((employee) => !employee.archived && employee.operatorId === null)
    .sort(byNameThenId);
}

export const EMPLOYEE_FILTERS = ["all", "linked", "unlinked", "archived"] as const;
export type EmployeeFilter = (typeof EMPLOYEE_FILTERS)[number];

/**
 * The employees a search and a filter leave, active ones first, each group
 * by name. The search matches the name, the role and the linked operator's
 * personnel number, without case; «Есть оператор» and «Нет оператора» show
 * employees in use only.
 */
export function findEmployees(
  employees: readonly EmployeeRecord[],
  operators: readonly OfficeOperator[],
  search: string,
  filter: EmployeeFilter,
): EmployeeRecord[] {
  const query = search.trim().toLocaleLowerCase("ru");
  const byId = new Map(operators.map((operator) => [operator.id, operator]));
  return activeFirstByName(employees).filter((employee) => {
    switch (filter) {
      case "linked":
        if (employee.archived || employee.operatorId === null) return false;
        break;
      case "unlinked":
        if (employee.archived || employee.operatorId !== null) return false;
        break;
      case "archived":
        if (!employee.archived) return false;
        break;
      case "all":
        break;
    }
    if (query === "") return true;
    const operator = employee.operatorId === null ? undefined : byId.get(employee.operatorId);
    return [employee.name, employee.role ?? "", operator?.login ?? ""].some((text) =>
      text.toLocaleLowerCase("ru").includes(query),
    );
  });
}
