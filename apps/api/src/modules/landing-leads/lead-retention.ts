import { sql, type SQL } from "drizzle-orm";

/** Alias `l` must name landing_leads. Only incoming requests extend the inquiry purpose.
 * Staff notes, outgoing touches, mail delivery and technical updates do not. */
export function leadRetentionDue(now: Date, months: number): SQL {
  if (!Number.isInteger(months) || months < 1 || months > 12)
    throw new Error("Invalid lead retention months");
  const lastRequest = sql`coalesce((SELECT max(e.created_at) FROM landing_lead_events AS e
    WHERE e.lead_id = l.id AND e.kind IN ('download', 'invoice_request', 'demo_request', 'activation_request')), l.created_at)`;
  return sql`l.anonymized_at IS NULL AND (
    (l.status = 'lost' AND l.status_changed_at >= ${lastRequest}
      AND l.status_changed_at <= ${new Date(now.getTime() - 30 * 86_400_000)})
    OR ${lastRequest} <= (${now}::timestamptz - make_interval(months => ${months}))
  )`;
}
