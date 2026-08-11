import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const CLOCK_TOLERANCE_MS = 5 * 60_000;

interface ProofIdentity {
  tenantId: string;
  kioskId: string;
  subscriptionId: string;
  deviceSeq: number;
}

interface IssueProofInput extends ProofIdentity {
  secret: string;
  issuedAt: Date;
  notAfter: Date;
}

interface VerifyProofInput extends ProofIdentity {
  secrets: readonly string[];
  proof: string;
  claimedAt: Date;
  now: Date;
  expectedEndsAt: Date;
}

interface ProofPayload extends ProofIdentity {
  v: typeof VERSION;
  issuedAt: string;
  notAfter: string;
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update("kiosk-admission-v1\0").update(encoded).digest();
}

export function issueKioskAdmissionProof(input: IssueProofInput): string {
  const payload: ProofPayload = {
    v: VERSION,
    tenantId: input.tenantId,
    kioskId: input.kioskId,
    subscriptionId: input.subscriptionId,
    deviceSeq: input.deviceSeq,
    issuedAt: input.issuedAt.toISOString(),
    notAfter: input.notAfter.toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(input.secret, encoded).toString("base64url")}`;
}

export function verifyKioskAdmissionProof(
  input: VerifyProofInput,
): { ok: true; occurredAt: Date } | { ok: false } {
  const [encoded, encodedSignature, extra] = input.proof.split(".");
  if (!encoded || !encodedSignature || extra !== undefined) return { ok: false };
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    return { ok: false };
  }
  const authenticated = input.secrets.some((secret) => {
    const expected = signature(secret, encoded);
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!authenticated) {
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (!isProofPayload(payload)) return { ok: false };
  const issuedAt = new Date(payload.issuedAt);
  const notAfter = new Date(payload.notAfter);
  if (
    payload.tenantId !== input.tenantId ||
    payload.kioskId !== input.kioskId ||
    payload.subscriptionId !== input.subscriptionId ||
    payload.deviceSeq !== input.deviceSeq ||
    notAfter.getTime() !== input.expectedEndsAt.getTime() ||
    issuedAt.getTime() > input.now.getTime() + CLOCK_TOLERANCE_MS ||
    issuedAt.getTime() > notAfter.getTime() ||
    input.claimedAt.getTime() < issuedAt.getTime() - CLOCK_TOLERANCE_MS ||
    input.claimedAt.getTime() >= notAfter.getTime()
  ) {
    return { ok: false };
  }
  return { ok: true, occurredAt: input.claimedAt };
}

export function legacyProoflessOccurrenceAllowed(input: {
  now: Date;
  configuredSunset: Date | undefined;
  claimedAt: Date;
  startsAt: Date;
  endsAt: Date;
}): boolean {
  return (
    input.configuredSunset !== undefined &&
    input.now <= input.configuredSunset &&
    input.claimedAt >= input.startsAt &&
    input.claimedAt < input.endsAt &&
    input.claimedAt.getTime() <= input.now.getTime() + CLOCK_TOLERANCE_MS
  );
}

function isProofPayload(value: unknown): value is ProofPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).sort().join(",") ===
      "deviceSeq,issuedAt,kioskId,notAfter,subscriptionId,tenantId,v" &&
    payload.v === VERSION &&
    typeof payload.tenantId === "string" &&
    typeof payload.kioskId === "string" &&
    typeof payload.subscriptionId === "string" &&
    Number.isSafeInteger(payload.deviceSeq) &&
    typeof payload.issuedAt === "string" &&
    Number.isFinite(Date.parse(payload.issuedAt)) &&
    typeof payload.notAfter === "string" &&
    Number.isFinite(Date.parse(payload.notAfter))
  );
}
