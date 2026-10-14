/** The root under `Документы\Markiro` the activation request goes to (the shell's `LICENSE_ROOT`). */
export const LICENSE_FOLDER = "Лицензия";

/** The request's file: JSON, which the SaaS panel takes as it is (license spec §6.3). */
export const ACTIVATION_FILE = "markiro-activation-request.json";

/**
 * «2026-10-20_09-00-00» of an instant, UTC, for a folder's name (as the
 * support text's file): no `:`, which the shell refuses in a name.
 */
function stamp(when: Date): string {
  return when.toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

/** A new folder for each saved request: the shell never writes over an earlier one. */
export function activationFolder(when: Date): readonly string[] {
  return [LICENSE_FOLDER, `Запрос на активацию ${stamp(when)}`];
}

/** The request as the host answered it, indented, with a final line break. It holds no secret. */
export function activationBytes(request: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(request, null, 2)}\n`);
}
