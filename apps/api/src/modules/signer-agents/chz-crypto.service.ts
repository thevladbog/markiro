import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

export interface EncryptedChzToken {
  encryptedToken: Buffer;
  tokenNonce: Buffer;
  tokenTag: Buffer;
}

/**
 * Токен True API — bearer-доступ к данным ЧЗ тенанта на 10 часов, поэтому в
 * БД он лежит только шифрованным. AAD = tenantId: чужой строкой расшифровать
 * значение нельзя даже с тем же ключом.
 */
@Injectable()
export class ChzCryptoService {
  constructor(private readonly key: Buffer | undefined) {
    if (key && key.length !== 32) {
      throw new Error("CHZ_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }

  /** Whether `CHZ_TOKEN_ENCRYPTION_KEY` was configured at boot. */
  isConfigured(): boolean {
    return this.key !== undefined;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error(
        "CHZ_TOKEN_ENCRYPTION_KEY is not configured; set it to use the Chestny ZNAK signer integration",
      );
    }
    return this.key;
  }

  encrypt(tenantId: string, token: string): EncryptedChzToken {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), nonce);
    cipher.setAAD(Buffer.from(tenantId, "utf8"));
    const encryptedToken = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { encryptedToken, tokenNonce: nonce, tokenTag: cipher.getAuthTag() };
  }

  decrypt(tenantId: string, payload: EncryptedChzToken): string {
    const decipher = createDecipheriv("aes-256-gcm", this.requireKey(), payload.tokenNonce);
    decipher.setAAD(Buffer.from(tenantId, "utf8"));
    decipher.setAuthTag(payload.tokenTag);
    return Buffer.concat([decipher.update(payload.encryptedToken), decipher.final()]).toString(
      "utf8",
    );
  }
}
