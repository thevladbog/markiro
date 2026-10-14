import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { standaloneUpdateManifestV1Schema } from "@markiro/domain";

// The shell's update commands (plan ОБН-2, `src-tauri/src/update/mod.rs`).
// The webview names a package only by a path the shell found; the keys, the
// installer's bytes and the launch stay in Rust. Answers are read with the
// schemas below; a refusal is a bare code (`UpdateError::code`), and a
// rejection that is none — no shell at all in a browser or a test — reads as
// `unsupported`.

/** The codes the update commands refuse with. */
export const UPDATE_SHELL_CODES = [
  "invalid_request",
  "documents_unavailable",
  "storage",
  "unsupported",
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "installer_missing",
  "installer_mismatch",
  "update_refused",
  "confirmation_required",
  "uac_cancelled",
  "launch_failed",
] as const;
export type UpdateShellCode = (typeof UPDATE_SHELL_CODES)[number];

export class UpdateShellError extends Error {
  readonly code: UpdateShellCode;

  constructor(code: UpdateShellCode, message: string) {
    super(message);
    this.name = "UpdateShellError";
    this.code = code;
  }
}

/** Why a found package shows no version (`PackageError::code` of a search). */
export const PACKAGE_PROBLEMS = [
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "storage",
] as const;

/** The signed manifest (spec §10.2), as the domain reads it. */
export const updateManifestSchema = standaloneUpdateManifestV1Schema;
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

/** One package `update_scan` found; the manifest only when its signature verified. */
export const foundPackageSchema = z.object({
  path: z.string().min(1),
  place: z.enum(["documents", "removable"]),
  fileName: z.string().min(1),
  manifest: updateManifestSchema.nullable(),
  problem: z.enum(PACKAGE_PROBLEMS).nullable(),
});
export type FoundPackage = z.infer<typeof foundPackageSchema>;

export const confirmationSchema = z.enum(["reinstall", "host_unreachable"]);
export type Confirmation = z.infer<typeof confirmationSchema>;

export const refusalSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("older"), installed: z.string() }),
  z.object({ code: z.literal("min_upgrade"), minUpgradeFrom: z.string() }),
  z.object({
    code: z.literal("host_first"),
    hostProtocol: z.number().int(),
    protocol: z.number().int(),
  }),
]);
export type Refusal = z.infer<typeof refusalSchema>;

/** `update_verify`: the package checked whole and what the version rules say of it. */
export const verifiedReportSchema = z.object({
  path: z.string().min(1),
  kid: z.string().min(1),
  manifest: updateManifestSchema,
  installed: z.string(),
  installerPath: z.string().min(1),
  comparison: z.enum(["newer", "same", "older"]),
  refusal: refusalSchema.nullable(),
  confirmations: z.array(confirmationSchema),
  host: z
    .object({
      version: z.string().nullable(),
      protocol: z.number().int(),
      minProtocol: z.number().int(),
    })
    .nullable(),
});
export type VerifiedReport = z.infer<typeof verifiedReportSchema>;

/** What the last update came to, as the app's start found it. */
export const updateOutcomeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("updated"), from: z.string(), to: z.string() }),
    z.object({
      kind: z.literal("not_finished"),
      from: z.string(),
      to: z.string(),
      startedAtMs: z.number().int(),
    }),
  ])
  .nullable();
export type UpdateOutcome = z.infer<typeof updateOutcomeSchema>;

/**
 * The update commands as the office calls them. Every member is a
 * function-typed property (`@typescript-eslint/unbound-method`); a test
 * passes its own through `UpdateShellProvider`.
 */
export interface UpdateShell {
  scan: () => Promise<FoundPackage[]>;
  verify: (path: string) => Promise<VerifiedReport>;
  /** Starts the installer; the app leaves, so on success the promise never settles. */
  install: (path: string, confirm: readonly Confirmation[]) => Promise<void>;
  outcome: () => Promise<UpdateOutcome>;
  dismissOutcome: () => Promise<void>;
  openFolder: () => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function createTauriUpdateShell(call: Invoke = invoke): UpdateShell {
  async function run<T>(
    command: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let answer: unknown;
    try {
      answer = await call(command, args);
    } catch (error) {
      const code = UPDATE_SHELL_CODES.find((candidate) => candidate === error) ?? "unsupported";
      throw new UpdateShellError(code, `${command}: ${String(error)}`);
    }
    return schema.parse(answer);
  }
  return {
    scan: () => run("update_scan", {}, z.array(foundPackageSchema)),
    verify: (path) => run("update_verify", { path }, verifiedReportSchema),
    install: async (path, confirm) => {
      await run("update_install", { path, confirm: [...confirm] }, z.null());
    },
    outcome: () => run("update_outcome", {}, updateOutcomeSchema),
    dismissOutcome: async () => {
      await run("update_outcome_dismiss", {}, z.null());
    },
    openFolder: async () => {
      await run("update_open_folder", {}, z.null());
    },
  };
}
