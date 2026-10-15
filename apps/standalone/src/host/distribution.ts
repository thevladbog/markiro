import { z } from "zod";

import { deviceKindSchema } from "./protocol.js";

// Update distribution through the host (plan ОБН-3): mirrors
// `markiro_proto::update::distribution`. The host's answers are lenient
// like the Rust response types; `proto/fixtures/device-update-*.json`,
// `office-update-status.json` and `app-versions.json` hold the shapes both
// sides read.

const PART = /^(0|[1-9][0-9]*)$/;
/** `u32::MAX`: `markiro_proto::update::AppVersion` keeps three `u32`. */
const MAX_PART = 4_294_967_295;

/** `MAJOR.MINOR.PATCH` as `markiro_proto::update::AppVersion` reads it; `null` for anything else. */
export function parseAppVersion(text: string): [number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) return null;
  const [major, minor, patch] = parts.map(Number);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (major > MAX_PART || minor > MAX_PART || patch > MAX_PART) return null;
  return [major, minor, patch];
}

/** `-1`, `0` or `1` as `a` is older than, equal to or newer than `b`; `null` when either does not read. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** `GET /v1/device/update` (frozen like `hello`: additive only; a newer host's state stays text). */
export const deviceUpdateOfferSchema = z.object({
  hostVersion: z.string(),
  package: z.object({
    state: z.string(),
    manifest: z.string().optional(),
    version: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
  }),
});
export type DeviceUpdateOffer = z.infer<typeof deviceUpdateOfferSchema>;

export const DEVICE_VERSION_STATES = [
  "current",
  "behind",
  "incompatible",
  "newer",
  "unknown",
] as const;
export type DeviceVersionState = (typeof DEVICE_VERSION_STATES)[number];

const updateMarkSchema = z.object({ at: z.iso.datetime(), version: z.string().nullable() });

export const deviceVersionSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  lineName: z.string().nullable(),
  appVersion: z.string(),
  protocol: z.number().int().nonnegative(),
  versionSeenAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  state: z.enum(DEVICE_VERSION_STATES),
  downloaded: updateMarkSchema.nullable(),
  installStarted: updateMarkSchema.nullable(),
});
export type DeviceVersion = z.infer<typeof deviceVersionSchema>;

/** `GET /v1/office/update-status` (every office role). */
export const officeUpdateStatusSchema = z.object({
  hostVersion: z.string(),
  protocol: z.number().int().nonnegative(),
  minProtocol: z.number().int().nonnegative(),
  package: z.object({
    state: z.string(),
    version: z.string().nullable(),
    staged: z.string().nullable(),
    previous: z.string().nullable(),
    diskBytes: z.number().int().nonnegative(),
  }),
  devices: z.array(deviceVersionSchema),
  history: z.array(
    z.object({
      at: z.iso.datetime(),
      action: z.string(),
      result: z.string(),
      actor: z.string().nullable(),
      version: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
  ),
});
export type OfficeUpdateStatus = z.infer<typeof officeUpdateStatusSchema>;
