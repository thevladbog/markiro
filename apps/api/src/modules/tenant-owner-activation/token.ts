import { createHash } from "node:crypto";

export function activationIdentifier(token: string): string {
  return `tenant-owner-activation:${createHash("sha256").update(token).digest("hex")}`;
}
