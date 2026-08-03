import { Injectable, Logger } from "@nestjs/common";
import type { MailPgPool } from "./mail-jobs.service";

const RETENTION_DELETE_BATCH_SIZE = 500;

export interface MailRetentionResult {
  payloadsErased: number;
  successfulDeleted: number;
  failedDeleted: number;
}

@Injectable()
export class MailRetentionService {
  readonly #logger = new Logger(MailRetentionService.name);

  constructor(private readonly pool: MailPgPool) {}

  async prune(): Promise<MailRetentionResult> {
    const erased = await this.pool.query(
      [
        "UPDATE email_deliveries",
        "SET encrypted_payload = null, payload_nonce = null, payload_tag = null, updated_at = now()",
        "WHERE status IN ('sent', 'canceled', 'failed')",
        "  AND terminal_at < now() - interval '24 hours'",
        "  AND encrypted_payload IS NOT NULL",
      ].join("\n"),
    );
    const successfulDeleted = await this.deleteInBatches(["sent", "canceled"], 30);
    const failedDeleted = await this.deleteInBatches(["failed"], 90);
    const result = {
      payloadsErased: erased.rowCount ?? 0,
      successfulDeleted,
      failedDeleted,
    };
    this.#logger.log(
      "Mail retention completed: " +
        result.payloadsErased +
        " payload(s) erased, " +
        (result.successfulDeleted + result.failedDeleted) +
        " delivery row(s) deleted",
    );
    return result;
  }

  private async deleteInBatches(
    statuses: readonly string[],
    retentionDays: number,
  ): Promise<number> {
    let deleted = 0;
    for (;;) {
      const result = await this.pool.query(
        [
          "WITH doomed AS (",
          "  SELECT id FROM email_deliveries",
          "  WHERE status = ANY($1::email_delivery_status[])",
          "    AND terminal_at < now() - ($2 * interval '1 day')",
          "  ORDER BY id",
          "  LIMIT $3",
          ")",
          "DELETE FROM email_deliveries AS delivery",
          "USING doomed",
          "WHERE delivery.id = doomed.id",
        ].join("\n"),
        [statuses, retentionDays, RETENTION_DELETE_BATCH_SIZE],
      );
      const batch = result.rowCount ?? 0;
      deleted += batch;
      if (batch < RETENTION_DELETE_BATCH_SIZE) return deleted;
    }
  }
}
