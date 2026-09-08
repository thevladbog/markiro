import { applyProductLabelEvent, DomainError, productLabelValueDigest } from "@markiro/domain";
import { recordScan } from "../journal.js";
import type { SqlExecutor } from "../mirror.js";
import type { PreparedProductLabelAcceptance, ProductLabelAcceptResult } from "./types.js";
import { parseProductLabelAcceptance } from "./validation.js";

/** One INSERT invokes a SQLite trigger; no transaction may span calls on the Tauri SQL pool. */
export async function recordProductLabelAcceptance(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<ProductLabelAcceptResult> {
  const value = parseProductLabelAcceptance(input);
  const digest = productLabelValueDigest(value);
  const projection = applyProductLabelEvent(null, value.preparedEvent, value.policy.verification);
  try {
    await exec.run(
      `INSERT INTO product_label_accept_commands
       (credential_ownership, job_id, shift_id, terminal_id, operator_id, raw, code_hash,
        gtin14, serial, accepted_at, acceptance_json, command_digest, projection_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(credential_ownership, job_id) DO NOTHING`,
      [
        value.credentialOwnership,
        value.jobId,
        value.shiftId,
        value.terminalId,
        value.operatorId,
        value.raw,
        value.codeHash,
        value.gtin14,
        value.serial,
        value.acceptedAt,
        JSON.stringify(value),
        digest,
        JSON.stringify(projection),
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PRODUCT_LABEL_BUSY")) return { status: "busy" };
    // Only this exact constraint means a duplicate unit. Other unique/write failures must surface.
    if (/UNIQUE constraint failed: codes_mirror\.code_hash(?:\s|$)/i.test(message)) {
      await recordScan(
        exec,
        {
          shiftId: value.shiftId,
          terminalId: value.terminalId,
          raw: value.raw,
          verdict: "duplicate",
          scannedAt: value.acceptedAt,
          operatorId: value.operatorId,
        },
        null,
      );
      return { status: "duplicate" };
    }
    throw error;
  }
  const [stored] = await exec.all<{ command_digest: string }>(
    "SELECT command_digest FROM product_label_accept_commands WHERE credential_ownership = ? AND job_id = ?",
    [value.credentialOwnership, value.jobId],
  );
  if (!stored || stored.command_digest !== digest) {
    throw new DomainError(
      "PRODUCT_LABEL_ACCEPTANCE_ID_CONFLICT",
      "Product label job ID already carries different acceptance data",
    );
  }
  return { status: "accepted", jobId: value.jobId };
}
