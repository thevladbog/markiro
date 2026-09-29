import { z } from "zod";

import { isBadgePhc, isPinPhc } from "../lib/credentials.js";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 1;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
export const LOCAL_HOST_ADDRESS = `https://127.0.0.1:${DEFAULT_HOST_PORT}`;

// Three kinds of shapes cross the IPC boundary:
// - payloads the Rust shell rebuilds from proto types are strict: an unknown
//   key means the webview and the shell come from different builds;
// - host response bodies pass through the shell unchanged and are lenient,
//   like the Rust response types (a newer host may add fields);
// - request bodies are strict, like the host's `deny_unknown_fields`.

/** Mirrors `markiro_proto::Hello`; rebuilt by the shell, so strict. */
export const helloSchema = z
  .object({
    product: z.literal("markiro-host"),
    protocol: z.number().int().positive(),
    minProtocol: z.number().int().positive(),
    hostId: z.uuid(),
    version: z.string().min(1),
    time: z.iso.datetime(),
    initialized: z.boolean(),
  })
  .strict();
export type Hello = z.infer<typeof helloSchema>;

/** Mirrors `markiro_proto::ErrorBody`; a host response, so lenient. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Mirrors `markiro_proto::DeviceKind`. */
export const deviceKindSchema = z.enum(["station", "office", "handheld"]);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

/** Mirrors `markiro_proto::OfficeRole`. */
export const officeRoleSchema = z.enum(["admin", "technologist"]);
export type OfficeRole = z.infer<typeof officeRoleSchema>;

/** Mirrors `markiro_proto::credentials`: which credential `unauthorized` rejected. */
export const credentialSchema = z.enum(["device", "session", "password"]);
export type Credential = z.infer<typeof credentialSchema>;

// --- The Rust shell's own payloads (strict) ---

/** `device_status` / `host_local_pair`: the pairing, never the device key. */
export const deviceStatusSchema = z
  .object({
    hostAddress: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    hostId: z.uuid(),
    deviceId: z.uuid(),
    kind: deviceKindSchema,
    lineId: z.uuid().nullable(),
  })
  .strict();
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

/** `host_request`: any HTTP answer, error statuses included. */
export const hostResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  })
  .strict();
export type HostResponse = z.infer<typeof hostResponseSchema>;

/** `connection_status` and `standalone://host-status`: the link to the host. */
export const hostStatusSchema = z
  .object({
    state: z.enum(["online", "connecting", "offline"]),
    /** When the host last sent anything, in milliseconds since the Unix epoch. */
    lastContactAt: z.number().int().nonnegative().nullable(),
    lastError: z
      .enum([
        "unreachable",
        "certificate_mismatch",
        "key_rejected",
        "stream_refused",
        "stream_ended",
      ])
      .nullable(),
    /** Grows with every status the shell publishes. */
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** `standalone://host-revision`: the host committed revision `rev`. */
export const hostRevisionSchema = z.object({ rev: z.number().int().nonnegative() }).strict();

// --- Host responses (lenient) ---

/** `GET /v1/device`. */
export const deviceInfoSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  pairedAt: z.iso.datetime(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** `GET /v1/office/devices`: a paired device as the administrator sees it. */
export const deviceRecordSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  appVersion: z.string(),
  pairedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

/** One changed or deleted reference record of `GET /v1/changes`. */
export const changeItemSchema = z.object({
  entity: z.string().min(1),
  id: z.string().min(1),
  rev: z.number().int().nonnegative(),
  deleted: z.boolean(),
  data: z.unknown().optional(),
});
export type ChangeItem = z.infer<typeof changeItemSchema>;

/** `GET /v1/changes`: apply `items`, keep `rev`, ask again while `hasMore`. */
export const changesResponseSchema = z.object({
  hostId: z.uuid(),
  rev: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  items: z.array(changeItemSchema),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/**
 * A canonical 16-byte salt: standard base64 with padding, 22 characters and
 * `==`. Those 22 characters hold 132 bits for 128 of data, so the last one
 * carries 2 data bits and 4 zero ones: it is `A`, `Q`, `g` or `w`. This is the
 * host's `decode_canonical` (`secrets::parse_phc`), which refuses anything
 * else, and `hashBadge` embeds the salt verbatim, so a salt that only looks
 * like base64 (unpadded, 17 or 18 bytes, stray bits) would make the host refuse
 * every badge hash as `validation_failed`.
 */
export const canonicalSaltSchema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/);

/** `data` of an `org_profile` item. */
export const orgRecordSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/**
 * `data` of a `site` item: the badge salt is 16 bytes, standard base64 with
 * padding. Exactly these keys (`z.strictObject`), like the people records:
 * the salt decides which badges a station matches.
 */
export const siteRecordSchema = z.strictObject({
  badgeSalt: canonicalSaltSchema,
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
});
export type SiteRecord = z.infer<typeof siteRecordSchema>;

/** `data` of a `lines` item. */
export const lineRecordSchema = z.object({ name: z.string(), archived: z.boolean() });
export type LineRecord = z.infer<typeof lineRecordSchema>;

/**
 * `data` of an `operators` item. It grants sign-in, so it has exactly these
 * keys (`z.strictObject`): an unknown one, which a newer host could use to
 * say something this build would miss, quarantines the record instead of
 * being dropped. A personnel number of 3–12 digits, and a PIN hash a station
 * can verify (`isPinPhc`).
 */
export const operatorRecordSchema = z.strictObject({
  login: z.string().regex(/^[0-9]{3,12}$/),
  name: z.string(),
  role: z.string().nullable(),
  pinPhc: z.string().refine(isPinPhc),
});
export type OperatorRecord = z.infer<typeof operatorRecordSchema>;

/**
 * `data` of an `operator_badges` item: exactly these keys, as for an
 * operator, and a badge hash a station can match (`isBadgePhc`).
 */
export const operatorBadgeRecordSchema = z.strictObject({
  operatorId: z.uuid(),
  badgePhc: z.string().refine(isBadgePhc),
  label: z.string().nullable(),
});
export type OperatorBadgeRecord = z.infer<typeof operatorBadgeRecordSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: officeRoleSchema,
});
export type OfficeUser = z.infer<typeof officeUserSchema>;

/** `POST /v1/office/login`: the token is shown once and kept only in memory. */
export const officeSessionSchema = z.object({
  token: z.string().min(1),
  user: officeUserSchema,
  expiresAt: z.iso.datetime(),
});
export type OfficeSession = z.infer<typeof officeSessionSchema>;

/** `POST /v1/bootstrap`. */
export const bootstrapResponseSchema = z.object({ session: officeSessionSchema });
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/**
 * `POST /v1/office/pairing-codes`: a one-time code; the payload is what the DataMatrix encodes.
 * `id` is what «Новый код» sends as `replaces`, and `createdAt` starts the code's lifetime.
 */
export const pairingCodeSchema = z.object({
  id: z.uuid(),
  code: z.string().regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`)),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  payload: z.string().startsWith("markiro-host:1?"),
});
export type PairingCode = z.infer<typeof pairingCodeSchema>;

/** `GET /v1/office/org`. */
export const orgProfileSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
  rev: z.number().int(),
});
export type OrgProfile = z.infer<typeof orgProfileSchema>;

/** One SSCC counter; `extension` 0 is a box, 1 a pallet. */
export const ssccCounterSchema = z.object({
  issuerPrefix: z.string(),
  extension: z.number().int().min(0).max(9),
  nextSerial: z.number().int().nonnegative(),
  maxSerial: z.number().int().nonnegative(),
  rev: z.number().int(),
});
export type SsccCounter = z.infer<typeof ssccCounterSchema>;

/** `GET /v1/office/sscc`. */
export const ssccStateSchema = z.object({
  counters: z.array(ssccCounterSchema),
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
  currentIssuerPrefix: z.string(),
  blockSizesRev: z.number().int(),
});
export type SsccState = z.infer<typeof ssccStateSchema>;

/** An office user as the administrator sees it. */
export const officeUserRecordSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: officeRoleSchema,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  rev: z.number().int(),
});
export type OfficeUserRecord = z.infer<typeof officeUserRecordSchema>;

/** `GET /v1/office/counterparties`: a customer of contract manufacturing; archived instead of deleted. */
export const counterpartyRecordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  archived: z.boolean(),
  rev: z.number().int(),
});
export type CounterpartyRecord = z.infer<typeof counterpartyRecordSchema>;

/** `GET /v1/office/lines`: a production line as the office sees it, archived ones included. */
export const officeLineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  rev: z.number().int(),
});
export type OfficeLine = z.infer<typeof officeLineSchema>;

/** A badge as the administrator sees it: never its hash; revoked badges stay listed with `revokedAt`. */
export const badgeInfoSchema = z.object({
  id: z.uuid(),
  label: z.string().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type BadgeInfo = z.infer<typeof badgeInfoSchema>;

/**
 * `GET /v1/office/operators`: an operator as the administrator sees it,
 * `hasPin` and the badges' details instead of any hash. `login` is the
 * personnel number, text with its leading zeros.
 */
export const officeOperatorSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  active: z.boolean(),
  hasPin: z.boolean(),
  badges: z.array(badgeInfoSchema),
  rev: z.number().int(),
});
export type OfficeOperator = z.infer<typeof officeOperatorSchema>;

/** `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard base64 with padding. */
export const badgeSaltSchema = z.object({ badgeSalt: canonicalSaltSchema });
export type BadgeSalt = z.infer<typeof badgeSaltSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
  .object({ login: z.string(), password: z.string() })
  .strict();
export type OfficeLoginRequest = z.infer<typeof officeLoginRequestSchema>;

export const newOfficeUserSchema = z
  .object({ login: z.string(), name: z.string(), password: z.string() })
  .strict();
export type NewOfficeUser = z.infer<typeof newOfficeUserSchema>;

export const orgProfileInputSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable().optional(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
  })
  .strict();
export type OrgProfileInput = z.infer<typeof orgProfileInputSchema>;

export const ssccStartSchema = z
  .object({
    boxNextSerial: z.number().int().nonnegative(),
    palletNextSerial: z.number().int().nonnegative(),
  })
  .strict();
export type SsccStart = z.infer<typeof ssccStartSchema>;

export const bootstrapRequestSchema = z
  .object({
    admin: newOfficeUserSchema,
    org: orgProfileInputSchema,
    sscc: ssccStartSchema,
    lines: z.array(z.string()),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const orgProfileUpdateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable().optional(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OrgProfileUpdate = z.infer<typeof orgProfileUpdateSchema>;

export const ssccCounterUpdateSchema = z
  .object({ nextSerial: z.number().int().nonnegative(), expectedRev: z.number().int() })
  .strict();
export type SsccCounterUpdate = z.infer<typeof ssccCounterUpdateSchema>;

export const blockSizesUpdateSchema = z
  .object({
    boxBlockSize: z.number().int().positive(),
    palletBlockSize: z.number().int().positive(),
    expectedRev: z.number().int(),
  })
  .strict();
export type BlockSizesUpdate = z.infer<typeof blockSizesUpdateSchema>;

export const officeUserCreateSchema = z
  .object({ login: z.string(), name: z.string(), role: officeRoleSchema, password: z.string() })
  .strict();
export type OfficeUserCreate = z.infer<typeof officeUserCreateSchema>;

export const officeUserUpdateSchema = z
  .object({
    name: z.string(),
    role: officeRoleSchema,
    active: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OfficeUserUpdate = z.infer<typeof officeUserUpdateSchema>;

export const passwordSetSchema = z.object({ password: z.string() }).strict();
export type PasswordSet = z.infer<typeof passwordSetSchema>;

export const passwordChangeSchema = z
  .object({ currentPassword: z.string(), newPassword: z.string() })
  .strict();
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

/** `POST /v1/office/counterparties`; the office always sends `inn`, `null` for none. */
export const counterpartyCreateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
  })
  .strict();
export type CounterpartyCreate = z.infer<typeof counterpartyCreateSchema>;

/** `PUT /v1/office/counterparties/{id}`: the whole record, `archived` included. */
export const counterpartyUpdateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type CounterpartyUpdate = z.infer<typeof counterpartyUpdateSchema>;

/** `POST /v1/office/lines`. */
export const lineCreateSchema = z.object({ name: z.string() }).strict();
export type LineCreate = z.infer<typeof lineCreateSchema>;

/** `PUT /v1/office/lines/{id}`: only the fields sent change. */
export const lineUpdateSchema = z
  .object({
    name: z.string().optional(),
    archived: z.boolean().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type LineUpdate = z.infer<typeof lineUpdateSchema>;

/** `PUT /v1/office/devices/{id}`: only the fields sent change; `lineId: null` clears the line. */
export const deviceUpdateSchema = z
  .object({ name: z.string().optional(), lineId: z.uuid().nullable().optional() })
  .strict();
export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;

/** The optional body of `POST /v1/office/pairing-codes`: the code «Новый код» replaces. */
export const pairingCodeRequestSchema = z.object({ replaces: z.uuid().optional() }).strict();
export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;

/**
 * `POST /v1/office/operators`: the PIN's hash, never the PIN; the office
 * always sends `role`, `null` for none.
 */
export const operatorCreateSchema = z
  .object({ login: z.string(), name: z.string(), role: z.string().nullable(), pinPhc: z.string() })
  .strict();
export type OperatorCreate = z.infer<typeof operatorCreateSchema>;

/** `PUT /v1/office/operators/{id}`: only the fields sent change; `role: null` clears the role. */
export const operatorUpdateSchema = z
  .object({
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    active: z.boolean().optional(),
    pinPhc: z.string().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OperatorUpdate = z.infer<typeof operatorUpdateSchema>;

/**
 * `POST /v1/office/operators/{id}/badges`: the badge code's hash under the
 * site's salt, never the code; the office always sends `label`, `null` for none.
 */
export const badgeCreateSchema = z
  .object({ badgePhc: z.string(), label: z.string().nullable() })
  .strict();
export type BadgeCreate = z.infer<typeof badgeCreateSchema>;
