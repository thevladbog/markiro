import { schema, type Db } from "@markiro/db";
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import type { DemoRequestDto } from "./demo-request.schema";

const EXPECTED_KINDS = new Set(["landing-demo-notification", "landing-demo-confirmation"]);

export interface DemoRequestRepositoryOptions {
  recipient: string;
  replyTo: string;
}

type MailDeliveryWriter = Pick<MailDeliveryService, "enqueue">;
type Clock = () => Date;

export class DemoRequestInvariantError extends Error {
  constructor() {
    super("Demo request delivery pair invariant failed");
    this.name = "DemoRequestInvariantError";
  }
}

@Injectable()
export class DemoRequestRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailDeliveryWriter,
    private readonly options: DemoRequestRepositoryOptions,
    private readonly now: Clock = () => new Date(),
  ) {}

  async accept(input: DemoRequestDto): Promise<"created" | "existing"> {
    const requestId = input.requestId.toLowerCase();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);

      const existing = await tx
        .select({ kind: schema.emailDeliveries.kind })
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.publicRequestId, requestId));
      if (existing.length > 0) {
        const kinds = new Set(existing.map((row) => row.kind));
        if (
          existing.length === EXPECTED_KINDS.size &&
          kinds.size === EXPECTED_KINDS.size &&
          [...EXPECTED_KINDS].every((kind) => kinds.has(kind))
        ) {
          return "existing";
        }
        throw new DemoRequestInvariantError();
      }

      const receivedAt = this.now();
      const phone = input.phone === undefined ? {} : { phone: input.phone };
      await this.mail.enqueue(tx, {
        scope: { publicRequestId: requestId },
        recipient: this.options.recipient,
        sourceId: requestId,
        template: {
          kind: "landing-demo-notification",
          locale: input.locale,
          requestId,
          receivedAt,
          sourcePath: input.sourcePath,
          recipientName: input.name,
          company: input.company,
          email: input.email,
          ...phone,
        },
      });
      await this.mail.enqueue(tx, {
        scope: { publicRequestId: requestId },
        recipient: input.email,
        sourceId: requestId,
        template: {
          kind: "landing-demo-confirmation",
          locale: input.locale,
          requestId,
          recipientName: input.name,
          company: input.company,
          email: input.email,
          ...phone,
          contactEmail: this.options.replyTo,
        },
      });
      return "created";
    });
  }
}
