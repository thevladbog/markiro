import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bulkEmployeePickupLimitsSchema,
  bulkEmployeePickupWriteoffSchema,
} from "../src/modules/employees/dto";

describe("employee pickup policy bulk DTOs", () => {
  it.each([
    ["limits", bulkEmployeePickupLimitsSchema, { limitMode: "limited" as const, dayLimit: 5 }],
    ["writeoff", bulkEmployeePickupWriteoffSchema, { canWriteoff: true }],
  ])("canonicalizes %s employee UUIDs before preserving request order", (_name, schema, policy) => {
    const first = randomUUID();
    const second = randomUUID();

    const parsed = schema.parse({
      employeeIds: [second.toUpperCase(), first.toUpperCase()],
      ...policy,
    });

    expect(parsed.employeeIds).toEqual([second, first]);
  });

  it.each([
    ["limits", bulkEmployeePickupLimitsSchema, { limitMode: "limited" as const, dayLimit: 5 }],
    ["writeoff", bulkEmployeePickupWriteoffSchema, { canWriteoff: true }],
  ])("rejects %s mixed-case aliases of the same employee UUID", (_name, schema, policy) => {
    const employeeId = randomUUID();

    const parsed = schema.safeParse({
      employeeIds: [employeeId, employeeId.toUpperCase()],
      ...policy,
    });

    expect(parsed.success).toBe(false);
  });
});
