import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { Injectable } from "@nestjs/common";
import { MailCryptoService } from "./mail-crypto.service";
import type { EnqueueMailInput, MailWriteTransaction } from "./mail.types";

type IdFactory = () => string;

@Injectable()
export class MailDeliveryService {
  constructor(
    private readonly crypto: MailCryptoService,
    private readonly createId: IdFactory = randomUUID,
  ) {}

  async enqueue(tx: MailWriteTransaction, input: EnqueueMailInput): Promise<string> {
    const id = this.createId();
    const recipient = normalizeRecipient(input.recipient);
    const encrypted = this.crypto.encrypt(id, input.template);
    const tenantId = "tenantId" in input.scope ? (input.scope.tenantId ?? null) : null;
    const userId = "userId" in input.scope ? (input.scope.userId ?? null) : null;
    const platformUserId =
      "platformUserId" in input.scope ? (input.scope.platformUserId ?? null) : null;

    await tx.insert(schema.emailDeliveries).values({
      id,
      tenantId,
      userId,
      platformUserId,
      recipient,
      kind: input.template.kind,
      sourceId: input.sourceId ?? null,
      status: "queued",
      ...encrypted,
    });
    await tx.insert(schema.emailOutbox).values({ deliveryId: id });
    return id;
  }
}

function normalizeRecipient(value: string): string {
  const recipient = value.trim().toLocaleLowerCase("en-US");
  if (!recipient || !recipient.includes("@") || /\s/.test(recipient)) {
    throw new Error("Invalid email recipient");
  }
  return recipient;
}
