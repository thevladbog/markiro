import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertUsHostedAdminDatabase,
  closeUsHostedAdminDatabase,
  createUsHostedAdminDatabase,
  usHostedAdminDatabaseIdentity,
} from "../src/deployment/us-hosted-admin-database";

// Unit-only imported protocols; real native TLS/authority evidence is mandatory separately.
const unit = vi.hoisted(() => ({
  release: Object.freeze({ unitReleaseOnly: true }),
  material: Object.freeze({ unitMaterialOnly: true }),
  releaseLive: true,
  materialLive: true,
  operation: "migrate" as "migrate" | "seed" | "provision",
  creates: 0,
  barrelLoads: 0,
  requireEntries: [] as string[],
  resolved: [] as string[],
  loaded: [] as string[],
  dbEntry: "/unit-owned-db/dist/index.js",
  driver: "normal",
  connects: 0,
  queries: 0,
  releases: 0,
  ends: 0,
  url: "",
  options: undefined as unknown,
  rows: [{ name: "markiro_us_synthetic", owner: "markiro_us" }],
  fail: "",
  disposeDuring: "",
  connectGate: undefined as Promise<void> | undefined,
  queryGate: undefined as Promise<void> | undefined,
  endGate: undefined as Promise<void> | undefined,
}));
vi.mock("../src/deployment/us-hosted-admin-release", () => ({
  assertUsHostedAdminRelease(value: unknown) {
    if (value !== unit.release || !unit.releaseLive) throw Error("private-unit-release-marker");
  },
  usHostedAdminReleaseIdentity(value: unknown) {
    if (value !== unit.release || !unit.releaseLive) throw Error("private-unit-release-marker");
    return { operation: unit.operation };
  },
}));
vi.mock("../src/deployment/us-hosted-admin-material-owner", () => ({
  assertUsHostedAdminMaterial(value: unknown, release: unknown) {
    if (
      value !== unit.material ||
      release !== unit.release ||
      !unit.materialLive ||
      !unit.releaseLive
    )
      throw Error("private-unit-material-marker");
  },
  usHostedAdminDatabaseMaterial() {
    return { password: "synthetic-unit-password", ca: "unit-public-ca" };
  },
}));
class UnitPool {
  constructor(values: Readonly<Record<string, unknown>>) {
    const { connectionString, ...options } = values;
    if (typeof connectionString !== "string") throw Error("private-unit-url-marker");
    unit.creates++;
    unit.url = connectionString;
    unit.options = options;
  }
  on() {
    return this;
  }
  async connect() {
    unit.connects++;
    await unit.connectGate;
    if (unit.fail === "connect") throw Error("private-unit-connect-marker");
    if (unit.disposeDuring === "connect") unit.materialLive = false;
    return {
      async query() {
        unit.queries++;
        await unit.queryGate;
        if (unit.fail === "query") throw Error("private-unit-query-marker");
        if (unit.disposeDuring === "query") unit.releaseLive = false;
        return { rows: unit.rows };
      },
      release() {
        unit.releases++;
        if (unit.fail === "release") throw Error("private-unit-release-marker");
      },
    };
  }
  async end() {
    unit.ends++;
    await unit.endGate;
    if (unit.fail === "end") throw Error("private-unit-end-marker");
  }
}
vi.mock("@markiro/db", () => {
  unit.barrelLoads++;
  return {
    createDb(url: string, options: Readonly<Record<string, unknown>>) {
      return { pool: new UnitPool({ connectionString: url, ...options }) };
    },
  };
});
vi.mock("node:module", () => ({
  createRequire(entry: string) {
    unit.requireEntries.push(entry);
    if (entry === unit.dbEntry)
      return (name: string) => {
        unit.loaded.push(name);
        if (name !== "pg" || unit.fail === "load") throw Error("private-unit-load-marker");
        if (unit.disposeDuring === "load") unit.materialLive = false;
        if (unit.driver === "missing") return {};
        if (unit.driver === "arrow") return { Pool: () => ({}) };
        if (unit.driver === "prototype") return { Pool: class {} };
        return { Pool: UnitPool };
      };
    return {
      resolve(name: string) {
        unit.resolved.push(name);
        if (name !== "@markiro/db" || unit.fail === "resolve")
          throw Error("private-unit-resolve-marker");
        return unit.dbEntry;
      },
    };
  },
}));

beforeEach(() => {
  unit.requireEntries = [];
  unit.resolved = [];
  unit.loaded = [];
  unit.driver = "normal";
  unit.releaseLive = true;
  unit.materialLive = true;
  unit.operation = "migrate";
  unit.creates = 0;
  unit.connects = 0;
  unit.queries = 0;
  unit.releases = 0;
  unit.ends = 0;
  unit.url = "";
  unit.options = undefined;
  unit.rows = [{ name: "markiro_us_synthetic", owner: "markiro_us" }];
  unit.fail = "";
  unit.disposeDuring = "";
  unit.connectGate = undefined;
  unit.queryGate = undefined;
  unit.endGate = undefined;
});

it.each(["migrate", "seed", "provision"] as const)(
  "retains one checked %s client with fixed TLS options",
  async (operation) => {
    unit.operation = operation;
    const owner = await createUsHostedAdminDatabase(unit.release, unit.material);
    expect(unit.resolved).toEqual(["@markiro/db"]);
    expect(unit.loaded).toEqual(["pg"]);
    expect(unit.requireEntries).toHaveLength(2);
    expect(unit.requireEntries[1]).toBe(unit.dbEntry);
    expect(new URL(unit.url).hostname).toBe("postgres.us-demo.internal");
    expect(new URL(unit.url).pathname).toBe("/markiro_us_synthetic");
    expect(new URL(unit.url).username).toBe("markiro_us");
    expect(unit.options).toEqual({
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 15000,
      ssl: {
        ca: "unit-public-ca",
        rejectUnauthorized: true,
        servername: "postgres.us-demo.internal",
      },
    });
    expect(usHostedAdminDatabaseIdentity(owner, unit.release, unit.material)).toEqual({
      operation,
      database: "markiro_us_synthetic",
      user: "markiro_us",
    });
    expect(Object.isFrozen(usHostedAdminDatabaseIdentity(owner, unit.release, unit.material))).toBe(
      true,
    );
    expect(unit.releases).toBe(0);
    expect(unit.ends).toBe(0);
    expect(Object.keys(owner)).toHaveLength(0);
    expect(inspect(owner)).not.toContain("synthetic-unit-password");
    expect(() => assertUsHostedAdminDatabase({ ...owner }, unit.release, unit.material)).toThrow(
      "us_hosted_admin_database_invalid",
    );
    await closeUsHostedAdminDatabase(owner);
    expect(unit.releases).toBe(1);
    expect(unit.ends).toBe(1);
    expect(() => assertUsHostedAdminDatabase(owner, unit.release, unit.material)).toThrow(
      "us_hosted_admin_database_invalid",
    );
  },
);

it("rejects structural/foreign/disposed dependencies before native acquisition", async () => {
  for (const [release, material] of [
    [{}, unit.material],
    [unit.release, {}],
    [null, null],
  ])
    await expect(createUsHostedAdminDatabase(release, material)).rejects.toThrow(
      "us_hosted_admin_database_invalid",
    );
  unit.materialLive = false;
  await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
    "us_hosted_admin_database_invalid",
  );
  expect(unit.creates).toBe(0);
  await expect(closeUsHostedAdminDatabase({})).rejects.toThrow("us_hosted_admin_database_invalid");
});

it.each(["connect", "query"])(
  "refuses disposal during awaited %s and settles native ownership",
  async (phase) => {
    unit.disposeDuring = phase;
    await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
      "us_hosted_admin_database_invalid",
    );
    expect(unit.releases).toBe(1);
    expect(unit.ends).toBe(1);
    if (phase === "connect") expect(unit.queries).toBe(0);
  },
);

it.each(["connect", "query"])("redacts %s failure and ends its own pool", async (phase) => {
  unit.fail = phase;
  try {
    await createUsHostedAdminDatabase(unit.release, unit.material);
    throw Error("unexpected_success");
  } catch (error) {
    expect(error).toHaveProperty("message", "us_hosted_admin_database_invalid");
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toContain("private-unit");
  }
  expect(unit.ends).toBe(1);
  expect(unit.releases).toBe(Number(phase === "query"));
});

it.each(
  [
    [],
    [{ name: "other", owner: "markiro_us" }],
    [{ name: "markiro_us_synthetic", owner: "other" }],
    [
      { name: "markiro_us_synthetic", owner: "markiro_us" },
      { name: "markiro_us_synthetic", owner: "markiro_us" },
    ],
  ].map((rows) => ({ rows })),
)("refuses wrong or ambiguous actual target %#", async ({ rows }) => {
  unit.rows = rows;
  await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
    "us_hosted_admin_database_invalid",
  );
  expect(unit.releases).toBe(1);
  expect(unit.ends).toBe(1);
});

it("close survives prematurely disposed dependencies and concurrent calls share the exact promise", async () => {
  const owner = await createUsHostedAdminDatabase(unit.release, unit.material);
  let finish: (() => void) | undefined;
  unit.endGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  unit.releaseLive = false;
  unit.materialLive = false;
  const first = closeUsHostedAdminDatabase(owner),
    second = closeUsHostedAdminDatabase(owner);
  expect(first).toBe(second);
  expect(() => usHostedAdminDatabaseIdentity(owner, unit.release, unit.material)).toThrow(
    "us_hosted_admin_database_invalid",
  );
  await Promise.resolve();
  expect(unit.releases).toBe(1);
  expect(unit.ends).toBe(1);
  if (!finish) throw Error();
  finish();
  await first;
  expect(closeUsHostedAdminDatabase(owner)).toBe(first);
});

it.each(["release", "end"])("does not claim successful closure after %s failure", async (phase) => {
  const owner = await createUsHostedAdminDatabase(unit.release, unit.material);
  unit.fail = phase;
  const closing = closeUsHostedAdminDatabase(owner);
  await expect(closing).rejects.toThrow("us_hosted_admin_database_close_failed");
  expect(closeUsHostedAdminDatabase(owner)).toBe(closing);
  expect(unit.releases).toBe(1);
  expect(unit.ends).toBe(1);
});

it.each(["connect", "query"] as const)(
  "settles the externally pending %s before refusing disposed material",
  async (phase) => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (phase === "connect") unit.connectGate = gate;
    else unit.queryGate = gate;
    const acquisition = createUsHostedAdminDatabase(unit.release, unit.material);
    await vi.waitFor(() => expect(phase === "connect" ? unit.connects : unit.queries).toBe(1));
    expect(unit.releases).toBe(0);
    expect(unit.ends).toBe(0);
    unit.materialLive = false;
    if (!finish) throw Error();
    finish();
    await expect(acquisition).rejects.toThrow("us_hosted_admin_database_invalid");
    expect(unit.releases).toBe(1);
    expect(unit.ends).toBe(1);
  },
);

afterEach(() => vi.unstubAllEnvs());
it.each(["PGOPTIONS", "PGSSLMODE", "PGHOST", "NODE_TLS_REJECT_UNAUTHORIZED"])(
  "refuses ambient %s before native acquisition",
  async (name) => {
    vi.stubEnv(name, "synthetic-unit-ambient-option");
    await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
      "us_hosted_admin_database_invalid",
    );
    expect(unit.creates).toBe(0);
  },
);

it("does not evaluate the unrelated database barrel during administrative module import", () => {
  expect(unit.barrelLoads).toBe(0);
});

it.each(["missing", "arrow", "prototype"])(
  "refuses invalid native driver %s before constructing a pool",
  async (driver) => {
    unit.driver = driver;
    await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
      "us_hosted_admin_database_invalid",
    );
    expect(unit.creates).toBe(0);
  },
);
it.each(["resolve", "load"])(
  "redacts native dependency %s failure without constructing a pool",
  async (phase) => {
    unit.fail = phase;
    await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
      "us_hosted_admin_database_invalid",
    );
    expect(unit.creates).toBe(0);
  },
);
it("rechecks authority after native module loading immediately before pool construction", async () => {
  unit.disposeDuring = "load";
  await expect(createUsHostedAdminDatabase(unit.release, unit.material)).rejects.toThrow(
    "us_hosted_admin_database_invalid",
  );
  expect(unit.loaded).toEqual(["pg"]);
  expect(unit.creates).toBe(0);
});
