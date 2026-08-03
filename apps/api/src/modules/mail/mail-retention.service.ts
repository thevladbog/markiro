import { Injectable, Logger } from "@nestjs/common";
import type { MailPgPool } from "./mail-jobs.service";

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
    const successful = await this.pool.query(
      [
        "DELETE FROM email_deliveries",
        "WHERE status IN ('sent', 'canceled')",
        "  AND terminal_at < now() - interval '30 days'",
      ].join("\n"),
    );
    const failed = await this.pool.query(
      [
        "DELETE FROM email_deliveries",
        "WHERE status = 'failed'",
        "  AND terminal_at < now() - interval '90 days'",
      ].join("\n"),
    );
    const result = {
      payloadsErased: erased.rowCount ?? 0,
      successfulDeleted: successful.rowCount ?? 0,
      failedDeleted: failed.rowCount ?? 0,
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
}
