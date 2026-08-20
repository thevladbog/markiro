import { sql } from "drizzle-orm";
import { schema } from "@markiro/db";

/** Formats a document sequence + creation date as `DSG-YY-NNNN`. */
export function formatDocNo(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `DSG-${yy}-${String(seq).padStart(4, "0")}`;
}

/** Atomic per-tenant increment; works inside a transaction handle. */
export async function nextDocNo(
  tx: { execute: (q: unknown) => Promise<{ rows: Array<{ seq: number }> }> },
  tenantId: string,
  when: Date,
): Promise<string> {
  const result = await tx.execute(sql`
    insert into ${schema.disaggregationDocCounters} (tenant_id, seq) values (${tenantId}, 1)
    on conflict (tenant_id) do update set seq = ${schema.disaggregationDocCounters.seq} + 1
    returning seq`);
  return formatDocNo(result.rows[0]!.seq, when);
}
