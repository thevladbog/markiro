import { asc, eq, notExists } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";
import { loadEnv } from "../env";

export interface UnmanagedTenantReport {
  tenants: {
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    subscriptionState: "unmanaged";
  }[];
}

export async function reportUnmanagedTenants(db: Db): Promise<UnmanagedTenantReport> {
  const tenants = await db
    .select({
      tenantId: schema.organization.id,
      tenantName: schema.organization.name,
      tenantSlug: schema.organization.slug,
    })
    .from(schema.organization)
    .where(
      notExists(
        db
          .select({ id: schema.tenantSubscriptions.id })
          .from(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, schema.organization.id)),
      ),
    )
    .orderBy(asc(schema.organization.slug), asc(schema.organization.id));
  return {
    tenants: tenants.map((tenant) => ({ ...tenant, subscriptionState: "unmanaged" as const })),
  };
}

export function renderUnmanagedTenantsReport(report: UnmanagedTenantReport): string {
  return `${JSON.stringify(report)}\n`;
}

interface CliStream {
  write(value: string): unknown;
}

export async function runReportUnmanagedTenantsCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    if (options.argv.length > 0) throw new Error("Unknown report argument");
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const report = await reportUnmanagedTenants(db);
      (options.stdout ?? process.stdout).write(renderUnmanagedTenantsReport(report));
    } finally {
      await pool.end();
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unmanaged tenant report failed";
    (options.stderr ?? process.stderr).write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runReportUnmanagedTenantsCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
