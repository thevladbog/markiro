import type { EmailTemplateInput, RenderedEmail } from "@markiro/email";
import type { Db } from "@markiro/db";

export type MailScope = { tenantId: string; userId?: never } | { userId: string; tenantId?: never };

export interface EnqueueMailInput {
  scope: MailScope;
  recipient: string;
  sourceId?: string;
  template: EmailTemplateInput;
}

export interface EncryptedMailPayload {
  encryptedPayload: Buffer;
  payloadNonce: Buffer;
  payloadTag: Buffer;
}

export type MailWriteTransaction = Pick<Db, "insert">;

export interface MailTransport {
  verify(): Promise<boolean>;
  send(rendered: RenderedEmail, recipient: string): Promise<void>;
}

export type MailHealth =
  | { status: "unknown" }
  | { status: "healthy"; checkedAt: Date }
  | { status: "degraded"; checkedAt: Date; category: "smtp_unavailable" };
