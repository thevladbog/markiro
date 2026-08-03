import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type * as DrizzleOrm from "drizzle-orm";
import { schema } from "@markiro/db";
import type { Auth, Db } from "@markiro/db";

// Real `eq`/`and` build opaque drizzle SQL objects that a plain fake can't
// see inside, which is exactly why the pre-existing fakeDb below used to
// return its canned result no matter what condition it was called with --
// deleting the guard's `eq(stationDevices.tenantId, ...)` clause passed
// every test in this file. Replacing them with tiny tagged descriptors lets
// `fakeDb`'s `where()` actually evaluate the guard's real condition tree
// against candidate rows, so the tenant predicate has to be there for the
// "wrong tenant" test below to pass.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ __op: "eq" as const, column, value }),
    and: (...conditions: unknown[]) => ({ __op: "and" as const, conditions }),
  };
});

// `vi.mock` above is hoisted above every import in this file (including this
// one), so `tenant.guard.ts`'s own `import { and, eq } from "drizzle-orm"`
// resolves to the tagged-descriptor mock, not the real thing.
import { TenantGuard } from "../src/tenancy/tenant.guard";

interface FakeRequest {
  headers: Record<string, string>;
  tenantId?: string;
  userId?: string;
  deviceId?: string;
  authKind?: "session" | "station";
}

interface FakeDeviceRow {
  id: string;
  tenantId: string;
  apiKeyId: string;
}

/** Maps the real drizzle column objects the guard filters on to a row field. */
const COLUMN_FIELD = new Map<unknown, keyof FakeDeviceRow>([
  [schema.stationDevices.tenantId, "tenantId"],
  [schema.stationDevices.apiKeyId, "apiKeyId"],
]);

type FakeCondition =
  { __op: "eq"; column: unknown; value: unknown } | { __op: "and"; conditions: FakeCondition[] };

function matches(condition: FakeCondition, row: FakeDeviceRow): boolean {
  if (condition.__op === "and") {
    return condition.conditions.every((c) => matches(c, row));
  }
  const field = COLUMN_FIELD.get(condition.column);
  if (!field) throw new Error("fakeDb: unexpected column in test condition");
  return row[field] === condition.value;
}

function fakeAuth(getSession: Auth["api"]["getSession"]): Auth {
  return { api: { getSession } } as unknown as Auth;
}

/**
 * Fakes only the one drizzle chain the guard's api-key path calls:
 * `db.select({id}).from(stationDevices).where(...)`. Unlike a canned
 * `selectResult`, `where()` here actually evaluates the guard's real
 * condition tree (via the `eq`/`and` mock above) against `deviceRows`, so a
 * row only comes back when BOTH the tenantId and apiKeyId clauses match --
 * exactly what lets the "device tagged with another tenant" test below tell
 * a scoped query apart from an unscoped one.
 */
function fakeDb(deviceRows: FakeDeviceRow[] = []): Db {
  return {
    select: () => ({
      from: () => ({
        where: async (condition: FakeCondition) =>
          deviceRows.filter((row) => matches(condition, row)).map((row) => ({ id: row.id })),
      }),
    }),
  } as unknown as Db;
}

function contextFor(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("TenantGuard", () => {
  it("throws UnauthorizedException when there is no session", async () => {
    const guard = new TenantGuard(
      fakeAuth(async () => null),
      fakeDb(),
    );
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.userId).toBeUndefined();
  });

  it("throws ForbiddenException when the session has no active organization", async () => {
    const guard = new TenantGuard(
      fakeAuth(async () => ({
        session: { activeOrganizationId: null },
        user: { id: "user_1" },
      })),
      fakeDb(),
    );
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("sets req.tenantId and returns true when an active organization exists", async () => {
    const guard = new TenantGuard(
      fakeAuth(async () => ({
        session: { activeOrganizationId: "org_1" },
        user: { id: "user_1" },
      })),
      fakeDb(),
    );
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_1");
    expect(req.userId).toBe("user_1");
    expect(req.deviceId).toBeUndefined();
    expect(req.authKind).toBe("session");
  });
});

function fakeAuthWithApiKey(
  getSession: Auth["api"]["getSession"],
  verifyApiKey: Auth["api"]["verifyApiKey"],
): Auth {
  return { api: { getSession, verifyApiKey } } as unknown as Auth;
}

describe("TenantGuard api-key path", () => {
  it("resolves tenantId from a valid x-api-key when there is no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
      fakeDb(),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_9");
    expect(req.authKind).toBe("station");
  });

  it("throws Unauthorized for an invalid x-api-key and no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({ valid: false, error: { message: "bad", code: "INVALID" }, key: null }),
      ),
      fakeDb(),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_bad" } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("sets req.deviceId from the matching station_devices row (Task 7)", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
      fakeDb([{ id: "device_1", tenantId: "org_9", apiKeyId: "key_1" }]),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.deviceId).toBe("device_1");
  });

  it("leaves req.deviceId undefined when no station_devices row matches the key", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
      fakeDb([]),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.deviceId).toBeUndefined();
  });

  it("leaves req.deviceId undefined when the only row with that api-key id belongs to a different tenant", async () => {
    // The row's apiKeyId matches the verified key, but its tenantId does
    // not match the key's own referenceId (org_9) -- e.g. a device row
    // mistakenly tagged with another tenant. Nothing in the schema stops
    // two station_devices rows from sharing one apiKeyId (see
    // sscc_blocks_tenant_device_fk's comment in platform.ts), so the
    // tenantId clause is the ONLY thing standing between this row and a
    // cross-tenant device resolving from someone else's key. Without
    // `eq(schema.stationDevices.tenantId, req.tenantId)` in the guard's
    // where(), this row would match on apiKeyId alone and req.deviceId
    // would wrongly become "device_evil".
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
      fakeDb([{ id: "device_evil", tenantId: "org_other", apiKeyId: "key_1" }]),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_9");
    expect(req.deviceId).toBeUndefined();
  });
});
