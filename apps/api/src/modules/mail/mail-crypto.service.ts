import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { EncryptedMailPayload } from "./mail.types";

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

@Injectable()
export class MailCryptoService {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error("MAIL_PAYLOAD_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    this.#key = Buffer.from(key);
  }

  encrypt(deliveryId: string, value: unknown): EncryptedMailPayload {
    const payloadNonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, payloadNonce);
    cipher.setAAD(Buffer.from(deliveryId, "utf8"));
    const encryptedPayload = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return {
      encryptedPayload,
      payloadNonce,
      payloadTag: cipher.getAuthTag(),
    };
  }

  decrypt<T = unknown>(deliveryId: string, payload: EncryptedMailPayload): T {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, payload.payloadNonce);
    decipher.setAAD(Buffer.from(deliveryId, "utf8"));
    decipher.setAuthTag(payload.payloadTag);
    const plaintext = Buffer.concat([
      decipher.update(payload.encryptedPayload),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  }
}
