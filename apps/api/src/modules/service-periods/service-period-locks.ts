import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function lockServiceNamespace(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`service-ledger:${tenantId}`}, 0))`,
  );
}
