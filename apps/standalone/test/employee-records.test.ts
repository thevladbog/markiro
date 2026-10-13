import { describe, expect, it } from "vitest";

import type { EmployeeRecord, OfficeOperator } from "../src/host/protocol.js";
import {
  employeesByOperator,
  findEmployees,
  freeEmployees,
  freeOperators,
  operatorLabel,
} from "../src/office/employees/employee-records.js";

const operator = (id: string, login: string, active = true): OfficeOperator => ({
  id,
  login,
  name: `Оператор ${login}`,
  role: null,
  active,
  hasPin: true,
  badges: [],
  rev: 1,
});
const employee = (
  id: string,
  name: string,
  operatorId: string | null,
  archived = false,
  role: string | null = null,
): EmployeeRecord => ({ id, name, role, operatorId, archived, rev: 1 });

const OPS = [operator("o3", "99"), operator("o1", "0042"), operator("o2", "100", false)];
const PEOPLE = [
  employee("e1", "Яна", "o1"),
  employee("e2", "Борис", null, false, "Наладчик"),
  employee("e3", "Алла", null, true),
];

describe("employee records", () => {
  it("names an operator by number and name", () => {
    expect(operatorLabel(OPS[1]!)).toBe("0042 · Оператор 0042");
  });

  it("offers the operators nobody holds, turned-off ones included, by number as text", () => {
    expect(freeOperators(OPS, PEOPLE).map((each) => each.login)).toEqual(["100", "99"]);
  });

  it("offers the employees in use and linked to nobody, by name", () => {
    expect(freeEmployees(PEOPLE).map((each) => each.id)).toEqual(["e2"]);
    expect(employeesByOperator(PEOPLE).get("o1")?.id).toBe("e1");
  });

  it("finds by name, role or the operator's number, without case, active first", () => {
    expect(findEmployees(PEOPLE, OPS, "", "all").map((each) => each.id)).toEqual([
      "e2",
      "e1",
      "e3",
    ]);
    expect(findEmployees(PEOPLE, OPS, "наладЧИК", "all").map((each) => each.id)).toEqual(["e2"]);
    expect(findEmployees(PEOPLE, OPS, "004", "all").map((each) => each.id)).toEqual(["e1"]);
    expect(findEmployees(PEOPLE, OPS, "", "linked").map((each) => each.id)).toEqual(["e1"]);
    expect(findEmployees(PEOPLE, OPS, "", "unlinked").map((each) => each.id)).toEqual(["e2"]);
    expect(findEmployees(PEOPLE, OPS, "", "archived").map((each) => each.id)).toEqual(["e3"]);
  });
});
