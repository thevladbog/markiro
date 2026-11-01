import type { createDb } from "@markiro/db";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import type { UsHostedAdminOperation } from "./us-hosted-admin-config";
import {
  assertUsHostedAdminRelease,
  usHostedAdminReleaseIdentity,
  type VerifiedUsHostedAdminRelease,
} from "./us-hosted-admin-release";
import {
  assertUsHostedAdminMaterial,
  usHostedAdminDatabaseMaterial,
  type UsHostedAdminMaterialOwner,
} from "./us-hosted-admin-material-owner";

const invalid = () => new Error("us_hosted_admin_database_invalid");
const closingFailed = () => new Error("us_hosted_admin_database_close_failed");
const brand: unique symbol = Symbol("us_hosted_admin_database");
export type UsHostedAdminDatabaseOwner = Readonly<{ [brand]: true }>;
export type UsHostedAdminDatabaseIdentity = Readonly<{
  operation: UsHostedAdminOperation;
  database: "markiro_us_synthetic";
  user: "markiro_us";
}>;
type Connection = Pick<ReturnType<typeof createDb>, "pool">;
type NativePoolOptions = Readonly<
  NonNullable<Parameters<typeof createDb>[1]> & { connectionString: string }
>;
type NativeDriver = { Pool: new (options: NativePoolOptions) => Connection["pool"] };
function isNativeDriver(value: unknown): value is NativeDriver {
  if (!value || typeof value !== "object" || !("Pool" in value) || typeof value.Pool !== "function")
    return false;
  const prototype: unknown = Reflect.get(value.Pool, "prototype");
  return Boolean(
    prototype &&
    typeof prototype === "object" &&
    "connect" in prototype &&
    typeof prototype.connect === "function" &&
    "end" in prototype &&
    typeof prototype.end === "function" &&
    "on" in prototype &&
    typeof prototype.on === "function",
  );
}
function nativeDriver(): NativeDriver {
  const apiRequire = createRequire(__filename);
  const fromDatabase = createRequire(apiRequire.resolve("@markiro/db"));
  const value: unknown = fromDatabase("pg");
  if (!isNativeDriver(value)) throw invalid();
  return value;
}
const connect = (connection: Connection) => connection.pool.connect();
type NativeClient = Awaited<ReturnType<typeof connect>>;
type DatabaseRecord = {
  release: VerifiedUsHostedAdminRelease;
  material: UsHostedAdminMaterialOwner;
  connection: Connection;
  client: NativeClient;
  identity: UsHostedAdminDatabaseIdentity;
  closing: Promise<void> | undefined;
};
const owners = new WeakMap<object, DatabaseRecord>();
function assertNoAmbientDatabaseOptions(): void {
  if (
    Object.keys(process.env).some(
      (name) => name.startsWith("PG") || name === "NODE_TLS_REJECT_UNAUTHORIZED",
    )
  )
    throw invalid();
}
function record(owner: unknown, release: unknown, material: unknown): DatabaseRecord {
  assertUsHostedAdminRelease(release);
  assertUsHostedAdminMaterial(material, release);
  if (!owner || typeof owner !== "object") throw invalid();
  const result = owners.get(owner);
  if (
    !result ||
    result.closing ||
    result.release !== release ||
    result.material !== material ||
    result.identity.operation !== usHostedAdminReleaseIdentity(release).operation
  )
    throw invalid();
  return result;
}
async function closeNative(
  connection: Connection,
  client: NativeClient | undefined,
): Promise<void> {
  let failed = false;
  try {
    client?.release();
  } catch {
    failed = true;
  }
  try {
    await connection.pool.end();
  } catch {
    failed = true;
  }
  if (failed) throw closingFailed();
}
export function assertUsHostedAdminDatabase(
  owner: unknown,
  release: unknown,
  material: unknown,
): asserts owner is UsHostedAdminDatabaseOwner {
  try {
    record(owner, release, material);
  } catch {
    throw invalid();
  }
}
export function usHostedAdminDatabaseIdentity(
  owner: unknown,
  release: unknown,
  material: unknown,
): UsHostedAdminDatabaseIdentity {
  try {
    return record(owner, release, material).identity;
  } catch {
    throw invalid();
  }
}
/** Cleanup uses its own private record even after premature dependency disposal. */
export function closeUsHostedAdminDatabase(owner: unknown): Promise<void> {
  if (!owner || typeof owner !== "object") return Promise.reject(invalid());
  const result = owners.get(owner);
  if (!result) return Promise.reject(invalid());
  result.closing ??= Promise.resolve().then(() => closeNative(result.connection, result.client));
  return result.closing;
}
/** Owns exactly one checked client. No raw pool, client, query or mutation projection exists. */
export async function createUsHostedAdminDatabase(
  release: unknown,
  material: unknown,
): Promise<UsHostedAdminDatabaseOwner> {
  let connection: Connection | undefined;
  let client: NativeClient | undefined;
  try {
    assertNoAmbientDatabaseOptions();
    assertUsHostedAdminRelease(release);
    assertUsHostedAdminMaterial(material, release);
    const { operation } = usHostedAdminReleaseIdentity(release);
    const alive = () => {
      assertNoAmbientDatabaseOptions();
      assertUsHostedAdminRelease(release);
      assertUsHostedAdminMaterial(material, release);
      if (usHostedAdminReleaseIdentity(release).operation !== operation) throw invalid();
    };
    const values = usHostedAdminDatabaseMaterial(material, release);
    const url = new URL("postgresql://postgres.us-demo.internal:5432/markiro_us_synthetic");
    url.username = "markiro_us";
    url.password = values.password;
    const driver = nativeDriver();
    alive();
    connection = {
      pool: new driver.Pool({
        connectionString: url.toString(),
        max: 1,
        connectionTimeoutMillis: 2000,
        statement_timeout: 15000,
        ssl: { ca: values.ca, rejectUnauthorized: true, servername: "postgres.us-demo.internal" },
      }),
    };
    connection.pool.on("error", () => {});
    client = await connect(connection);
    alive();
    const actual = await client.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name, current_user AS owner",
    );
    alive();
    if (
      actual.rows.length !== 1 ||
      actual.rows[0]?.name !== "markiro_us_synthetic" ||
      actual.rows[0]?.owner !== "markiro_us"
    )
      throw invalid();
    const identity: UsHostedAdminDatabaseIdentity = Object.freeze({
      operation,
      database: "markiro_us_synthetic",
      user: "markiro_us",
    });
    const owner = { [brand]: true as const };
    Object.defineProperties(owner, {
      [brand]: { enumerable: false },
      toJSON: { value: () => "[us_hosted_admin_database]" },
      [inspect.custom]: { value: () => "[us_hosted_admin_database]" },
    });
    Object.freeze(owner);
    alive();
    owners.set(owner, { release, material, connection, client, identity, closing: undefined });
    return owner;
  } catch {
    if (connection) {
      try {
        await closeNative(connection, client);
      } catch {
        /* No successful closure is claimed. */
      }
    }
    throw invalid();
  }
}
