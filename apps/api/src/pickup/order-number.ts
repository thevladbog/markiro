import { sql } from "drizzle-orm";
import { schema } from "@markiro/db";

/** Formats an order sequence + creation date as `ORD-YY-NNNN` (2-digit UTC year, 4-digit zero-padded seq; larger seqs are not truncated). */
export function formatOrderNo(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `ORD-${yy}-${String(seq).padStart(4, "0")}`;
}

// Atomic per-tenant increment. Works inside a transaction handle.
export async function nextOrderNo(
  tx: { execute: (q: unknown) => Promise<{ rows: Array<{ seq: number }> }> },
  tenantId: string,
  when: Date,
): Promise<string> {
  const result = await tx.execute(sql`
    insert into ${schema.pickupOrderCounters} (tenant_id, seq) values (${tenantId}, 1)
    on conflict (tenant_id) do update set seq = ${schema.pickupOrderCounters.seq} + 1
    returning seq`);
  return formatOrderNo(result.rows[0]!.seq, when);
}
