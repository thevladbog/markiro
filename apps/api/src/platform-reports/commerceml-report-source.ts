import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import { inWindow, reportRows, tenantScope, type ReportTransaction } from "./report-query";

export const COMMERCEML_COLUMNS = [
  "tenant_id",
  "record_type",
  "record_id",
  "session_id",
  "started_at",
  "finished_at",
  "event_at",
  "outcome",
  "direction",
  "grain",
  "category",
  "current_upload_chunks",
];

export async function loadCommerceMlRows(tx: ReportTransaction, input: PlatformReportInput) {
  // Messages are classified inside SQL; arbitrary text and integration JSON never leave the database.
  return reportRows(
    tx,
    sql`
    SELECT tenant_id,record_type,record_id,session_id,started_at,finished_at,event_at,outcome,direction,grain,category,current_upload_chunks FROM (
      SELECT s.tenant_id,'session' AS record_type,s.id AS record_id,s.id AS session_id,
        s.started_at,s.finished_at,NULL::timestamptz AS event_at,
        CASE WHEN s.outcome IN ('ok','error') THEN s.outcome ELSE NULL END AS outcome,
        NULL::text AS direction,'session' AS grain,NULL::text AS category,
        (SELECT count(*)::int FROM exchange_uploads u WHERE u.tenant_id=s.tenant_id AND u.session_id=s.id) AS current_upload_chunks
      FROM integration_sessions s
      WHERE ${tenantScope(sql`s.tenant_id`, input)} AND s.channel_type='commerceml'
        AND (${inWindow(sql`s.started_at`, input)} OR ${inWindow(sql`s.finished_at`, input)})
        ${input.outcome ? sql`AND s.outcome=${input.outcome}` : sql``}
      UNION ALL
      SELECT e.tenant_id,'event',e.id,session.id,NULL::timestamptz,NULL::timestamptz,e.at,
        CASE WHEN e.outcome IN ('ok','warn','error') THEN e.outcome ELSE NULL END,
        CASE WHEN e.direction IN ('in','out','local') THEN e.direction ELSE NULL END,
        CASE WHEN e.grain IN ('session','item') THEN e.grain ELSE NULL END,
        CASE WHEN e.message='init' THEN 'init'
          WHEN e.message LIKE 'checkauth:%' THEN 'authentication'
          WHEN e.message LIKE 'file:%' THEN 'upload'
          WHEN e.message LIKE 'import:%' OR e.message LIKE 'import (sale):%' THEN 'import'
          WHEN e.message LIKE 'query:%' THEN 'query'
          WHEN e.message LIKE 'success:%' THEN 'acknowledgement'
          WHEN e.message LIKE 'конфликт GTIN:%' OR e.message LIKE 'GTIN у нескольких позиций%' THEN 'gtin_conflict'
          WHEN e.message LIKE 'внутренняя ошибка:%' THEN 'internal_error'
          WHEN e.message LIKE 'неизвестный режим:%' OR e.message LIKE 'повторён параметр запроса:%' THEN 'invalid_request'
          ELSE 'other' END,NULL::int
      FROM integration_events e
      LEFT JOIN integration_sessions session ON session.id=e.session_id AND session.tenant_id=e.tenant_id AND session.channel_type='commerceml'
      WHERE ${tenantScope(sql`e.tenant_id`, input)} AND e.channel_type='commerceml' AND ${inWindow(sql`e.at`, input)}
        ${input.outcome ? sql`AND e.outcome=${input.outcome}` : sql``}
    ) journal ORDER BY tenant_id,coalesce(event_at,started_at),record_type,record_id LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
