import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DrizzleOrm from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ __op: "eq" as const, column, value }),
    and: (...conditions: unknown[]) => ({ __op: "and" as const, conditions }),
  };
});

import { AuthorizationService } from "../src/authorization/authorization.service";

interface MembershipRow {
  userId: string;
  organizationId: string;
  role: string;
}

type FakeCondition =
  { __op: "eq"; column: unknown; value: unknown } | { __op: "and"; conditions: FakeCondition[] };

const COLUMN_FIELD = new Map<unknown, keyof MembershipRow>([
  [schema.member.userId, "userId"],
  [schema.member.organizationId, "organizationId"],
]);

function matches(condition: FakeCondition, row: MembershipRow): boolean {
  if (condition.__op === "and") {
    return condition.conditions.every((child) => matches(child, row));
  }
  const field = COLUMN_FIELD.get(condition.column);
  if (!field) throw new Error("fakeDb: unexpected membership column");
  return row[field] === condition.value;
}

function fakeDb(rows: MembershipRow[]): Db {
  const queriedLimits: number[] = [];
  return {
    select: () => ({
      from: () => ({
        where: (condition: FakeCondition) => {
          const matched = rows
            .filter((row) => matches(condition, row))
            .map((row) => ({ role: row.role }));
          return Object.assign(Promise.resolve(matched), {
            limit: (count: number) => {
              queriedLimits.push(count);
              return Promise.resolve(matched.slice(0, count));
            },
          });
        },
      }),
    }),
    queriedLimits,
  } as unknown as Db;
}

describe("AuthorizationService", () => {
  let membershipRows: MembershipRow[];
  let service: AuthorizationService;

  beforeEach(() => {
    membershipRows = [
      { userId: "user_1", organizationId: "org_1", role: "manager" },
      { userId: "user_1", organizationId: "org_other", role: "admin" },
      { userId: "user_other", organizationId: "org_1", role: "owner" },
    ];
    service = new AuthorizationService(fakeDb(membershipRows));
  });

  it("resolves only the membership matching both user and active tenant", async () => {
    const principal = await service.resolvePrincipal("user_1", "org_1");
    expect(principal).toEqual({
      userId: "user_1",
      tenantId: "org_1",
      roles: ["manager"],
      capabilities: ["operations.read", "operations.write"],
    });
  });

  it("returns null when only a cross-tenant membership exists", async () => {
    await expect(service.resolvePrincipal("user_1", "org_missing")).resolves.toBeNull();
  });

  it("fails closed when the active tenant has duplicate memberships", async () => {
    membershipRows.push({ userId: "user_1", organizationId: "org_1", role: "owner" });

    await expect(service.resolvePrincipal("user_1", "org_1")).resolves.toBeNull();
  });

  it("reads at most two matching memberships to detect duplicates", async () => {
    const db = fakeDb(membershipRows) as unknown as { queriedLimits: number[] };
    service = new AuthorizationService(db as unknown as Db);

    await service.resolvePrincipal("user_1", "org_1");

    expect(db.queriedLimits).toEqual([2]);
  });

  it("reloads the role on every call", async () => {
    expect((await service.resolvePrincipal("user_1", "org_1"))?.roles).toEqual(["manager"]);
    membershipRows[0]!.role = "admin";
    expect((await service.resolvePrincipal("user_1", "org_1"))?.roles).toEqual(["admin"]);
  });
});
