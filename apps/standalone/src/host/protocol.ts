import { z } from "zod";

import { isBadgePhc, isPinPhc } from "../lib/credentials.js";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 3;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
export const LOCAL_HOST_ADDRESS = `https://127.0.0.1:${DEFAULT_HOST_PORT}`;

// Three kinds of shapes cross the IPC boundary:
// - payloads the Rust shell rebuilds from proto types are strict: an unknown
//   key means the webview and the shell come from different builds;
// - host response bodies pass through the shell unchanged and are lenient,
//   like the Rust response types (a newer host may add fields), except the
//   feed records that grant access or carry the salt (`site`, `operators`,
//   `operator_badges`): those are read strictly, so an added field on one is
//   breaking for older stations, which quarantine the record and delete their
//   copy (fail-closed): an operator edited after a host upgrade cannot sign in
//   on a station that has not been updated, and `site` takes the badge salt
//   and the block sizes with it. The policy (versioning, or lenient additive
//   fields) is carried to plan 5, and the coupling of the block sizes to a
//   fail-closed record to plan 2a and the owner;
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
    /** A new UUID at every restore of the host from a copy (plan РК); absent before the first. */
    restoreEpoch: z.uuid().optional(),
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

/** Mirrors `markiro_proto::TemplatePurpose`: what a label template prints. */
export const templatePurposeSchema = z.enum(["box", "pallet", "product_duplicate"]);
export type TemplatePurpose = z.infer<typeof templatePurposeSchema>;

/**
 * Mirrors `markiro_proto::ProductStatus`: `active` once a product has a group
 * and both capacities, `draft` before. The host computes it; nobody sends it.
 */
export const productStatusSchema = z.enum(["draft", "active"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** A ЧЗ product group's code (a `u32` in `proto`). */
const groupCodeSchema = z.number().int().nonnegative();

/** A template's categories: `null` for every category, otherwise the group codes. */
const groupCodesSchema = z.array(groupCodeSchema).nullable();

/** A count a product may leave empty: units in a box, boxes on a pallet, days (a `u32` in `proto`). */
const countSchema = z.number().int().nonnegative().nullable();

/**
 * A label layout as the host keeps it: a JSON object, read as an opaque
 * value. Its own contract (the domain's `labelTemplateSpecSchema`) is checked
 * where a layout is used — by the template editor before it saves (`checkedSpec`)
 * and by the station before it prints (plan 2a) — never at sync time. A
 * dynamic-key `z.record` would put keys taken from the data into a quarantine
 * reason's paths (`AGENTS.md`, "Reference sync"); this check gives one
 * `custom` issue.
 */
export const templateSpecSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

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
    /** The name the host keeps for this device; `null` until a refresh fills an old `device.json`. */
    deviceName: z.string().min(1).nullable(),
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
    /**
     * The host's `hello.restoreEpoch` as the connection that came online last
     * read it (plan РК-С); absent before the host's first restore (and from
     * a host that predates restores). A connection whose read failed does not
     * come online.
     */
    restoreEpoch: z.uuid().optional(),
  })
  .strict();
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** `standalone://host-revision`: the host committed revision `rev`. */
export const hostRevisionSchema = z.object({ rev: z.number().int().nonnegative() }).strict();

// --- Host responses (lenient) ---
// The exception is the feed records that grant access or carry the salt
// (`site`, `operators`, `operator_badges`, below): they are strict, so an
// added field breaks older stations (quarantine, then the fail-closed delete
// of their copy); see the note at the top. The policy is plan 5's, and the
// block sizes' coupling to a fail-closed record is plan 2a's and the owner's.

// --- The site's license (plan ЛЦ-2, `proto/src/license.rs`) ---
// Answers are lenient like every host response; the state is a word, not an
// enum, so a state a newer host adds does not fail the page.

/** `state` of a license answer (spec §3.2). */
export const LICENSE_STATES = [
  "trial",
  "active",
  "expiring",
  "grace",
  "restricted",
  "wrong_host",
  "inn_mismatch",
  "trial_expired",
] as const;
/** `details.reason` of a refused file, in the host's order of checks (§4.3). */
export const LICENSE_REFUSALS = [
  "license_malformed",
  "license_unknown_key",
  "license_signature",
  "license_wrong_host",
  "license_inn_mismatch",
  "license_inn_missing",
  "license_older",
] as const;
export const LICENSE_WARNINGS = ["expired", "not_yet_valid", "over_limit"] as const;
/** `details.constraint` of a `conflict` the license causes. */
export const LICENSE_CONSTRAINTS = [
  "license_restricted",
  "seat_limit",
  "feature_disabled",
  "emergency_used",
  "emergency_not_needed",
] as const;
export const LICENSE_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
export const LICENSE_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
] as const;
/**
 * The most a license file may hold (`verify::MAX_FILE_BYTES`). Zod's `.max()`
 * counts UTF-16 units, not bytes: the host's 16 KiB byte limit is the one that
 * decides (a `.mklic` file is ASCII, where the two agree).
 */
export const MAX_LICENSE_FILE_BYTES = 16 * 1024;

const quotaUseSchema = z.object({
  limit: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative(),
  over: z.boolean(),
});
export const licenseQuotasSchema = z.object({
  lines: quotaUseSchema,
  stations: quotaUseSchema,
  kiosks: quotaUseSchema,
  cabinetUsers: quotaUseSchema,
});
export const licenseFeaturesSchema = z.object({
  labelEditor: z.boolean(),
  publicApi: z.boolean(),
  pallets: z.boolean(),
  chzIntegration: z.boolean(),
  inventory: z.boolean(),
  commerceMl: z.boolean(),
  handheld: z.boolean(),
});

/** `GET /v1/office/license`, and the answers of a load and of the emergency extension. */
export const officeLicenseSchema = z.object({
  state: z.string(),
  since: z.iso.datetime(),
  flags: z.object({
    clockBehindDays: z.number().int().positive().nullable(),
    clockAhead: z.boolean(),
  }),
  effectiveAt: z.iso.datetime(),
  phaseEndsAt: z.iso.datetime().nullable(),
  daysLeft: z.number().int().nonnegative().nullable(),
  warnDays: z.number().int().nonnegative(),
  opensNewShifts: z.boolean(),
  license: z
    .object({
      licenseId: z.uuid(),
      sequence: z.number().int().positive(),
      kid: z.string(),
      customer: z.object({ name: z.string(), inn: z.string() }),
      plan: z.string(),
      planVersionId: z.string(),
      issuedAt: z.iso.datetime(),
      validFrom: z.iso.datetime(),
      validUntil: z.iso.datetime(),
      graceDays: z.number().int().nonnegative(),
    })
    .nullable(),
  trial: z
    .object({
      startedAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      inn: z.string().nullable(),
    })
    .nullable(),
  binding: z.object({
    hostId: z.uuid(),
    fingerprint: z.string(),
    orgInn: z.string().nullable(),
    innMatches: z.boolean().nullable(),
  }),
  quotas: licenseQuotasSchema,
  features: licenseFeaturesSchema,
  emergency: z.object({ available: z.boolean(), until: z.iso.datetime().nullable() }),
  warnings: z.array(z.string()).optional(),
});
export type OfficeLicense = z.infer<typeof officeLicenseSchema>;

/** One column of the preview's «было → станет». */
export const licenseTermsSchema = z.object({
  licenseId: z.uuid().nullable(),
  sequence: z.number().int().positive().nullable(),
  plan: z.string(),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  graceDays: z.number().int().nonnegative(),
  quotas: licenseQuotasSchema,
  features: licenseFeaturesSchema,
});
export type LicenseTerms = z.infer<typeof licenseTermsSchema>;

/** `POST /v1/office/license/preview`. */
export const licensePreviewSchema = z.object({
  before: licenseTermsSchema,
  after: licenseTermsSchema,
  changes: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type LicensePreview = z.infer<typeof licensePreviewSchema>;

/** The license line of `GET /v1/device`. */
export const deviceLicenseSchema = z.object({
  state: z.string(),
  since: z.iso.datetime(),
  phaseEndsAt: z.iso.datetime().nullable(),
  emergencyUntil: z.iso.datetime().nullable(),
});
export type DeviceLicense = z.infer<typeof deviceLicenseSchema>;

/** `POST /v1/office/license/preview` and `PUT /v1/office/license` (strict, `licenseLoad`). */
export const licenseLoadRequestSchema = z
  .object({ file: z.string().min(1).max(MAX_LICENSE_FILE_BYTES) })
  .strict();
export type LicenseLoadRequest = z.infer<typeof licenseLoadRequestSchema>;

/**
 * `GET /v1/device`; `license` since plan ЛЦ-2. A license line of the wrong
 * shape reads as none (as `DeviceInfo.license` in proto): it never blocks the
 * device's own record.
 */
export const deviceInfoSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  pairedAt: z.iso.datetime(),
  license: deviceLicenseSchema.optional().catch(undefined),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** `GET /v1/office/devices`: a paired device as the administrator sees it. */
export const deviceRecordSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  appVersion: z.string(),
  /**
   * The protocol the device spoke when it last reported its version, or at
   * pairing (plan ОБН-1). Optional: a host before ОБН-1 of the same protocol
   * does not send it.
   */
  protocol: z.number().int().positive().optional(),
  /** When the host first heard the device report its current version; `null` while it has not. */
  versionSeenAt: z.iso.datetime().nullable().optional(),
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

/**
 * `data` of an `org_profile` item. The organization's three default templates
 * (plan 1e1) are absent from an older host's record and read as none: a
 * required field would quarantine the record and delete the copy.
 */
export const orgRecordSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
  defaultBoxTemplateId: z.uuid().nullish(),
  defaultPalletTemplateId: z.uuid().nullish(),
  defaultDuplicateTemplateId: z.uuid().nullish(),
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

/**
 * `data` of a `products` item. The catalog grants no access, so its records
 * are read with `z.object`, as `org_profile` and `lines` are: a key a newer
 * host adds is dropped, and a value this build cannot read quarantines the
 * record. An archived product stays with `archived: true`; a product is never
 * deleted.
 */
export const productRecordSchema = z.object({
  gtin14: z.string().regex(/^[0-9]{14}$/),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: groupCodeSchema.nullable(),
  boxCapacity: countSchema,
  palletBoxCapacity: countSchema,
  shelfLifeDays: countSchema,
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  archived: z.boolean(),
  status: productStatusSchema,
});
export type ProductRecord = z.infer<typeof productRecordSchema>;

/**
 * `data` of a `label_templates` item, read as a product's is. A disabled
 * template stays with `enabled: false`; a deleted one leaves as a tombstone.
 * The layout is opaque here (`templateSpecSchema`): the station checks it
 * before it prints (plan 2a).
 */
export const labelTemplateRecordSchema = z.object({
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  spec: templateSpecSchema,
});
export type LabelTemplateRecord = z.infer<typeof labelTemplateRecordSchema>;

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

/** Mirrors `markiro_proto::OrgLogo`: the organization's monochrome print logo (plan А4). */
export const orgLogoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelsBase64: z.string(),
  updatedAt: z.iso.datetime(),
});
export type OrgLogo = z.infer<typeof orgLogoSchema>;

/** Mirrors `markiro_proto::OrgLogoState`: `GET`/`PUT`/`DELETE /v1/office/org/logo`. */
export const orgLogoStateSchema = z.object({ logo: orgLogoSchema.nullable() });
export type OrgLogoState = z.infer<typeof orgLogoStateSchema>;

/** Mirrors `markiro_proto::OrgLogoPut`: the whole logo, replacing any. */
export const orgLogoPutSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelsBase64: z.string(),
  })
  .strict();
export type OrgLogoPut = z.infer<typeof orgLogoPutSchema>;

/**
 * Mirrors `markiro_proto::PalletSheet` (plan А4): an A4 pallet sheet. `spec`
 * stays unknown here — the office and the station read it with the domain's
 * `parsePalletSheetSpec`, and a sheet a newer office made does not fail the list.
 */
export const palletSheetSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean(),
  presetKey: z.string().nullable(),
  revision: z.number().int().positive(),
  spec: z.unknown(),
});
export type PalletSheet = z.infer<typeof palletSheetSchema>;

/** Mirrors `markiro_proto::PalletSheets`: every sheet by name and the default. */
export const palletSheetsSchema = z.object({
  sheets: z.array(palletSheetSchema),
  defaultId: z.uuid().nullable(),
});
export type PalletSheets = z.infer<typeof palletSheetsSchema>;

/** Mirrors `markiro_proto::PalletSheetCreate`. */
export const palletSheetCreateSchema = z
  .object({
    name: z.string(),
    presetKey: z.string().optional(),
    enabled: z.boolean().optional(),
    spec: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PalletSheetCreate = z.infer<typeof palletSheetCreateSchema>;

/** Mirrors `markiro_proto::PalletSheetUpdate`: the name or the state, over the revision. */
export const palletSheetUpdateSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    expectedRevision: z.number().int(),
  })
  .strict();
export type PalletSheetUpdate = z.infer<typeof palletSheetUpdateSchema>;

/** Mirrors `markiro_proto::PalletSheetDefaultUpdate`. */
export const palletSheetDefaultUpdateSchema = z
  .object({ templateId: z.uuid().nullable() })
  .strict();
export type PalletSheetDefaultUpdate = z.infer<typeof palletSheetDefaultUpdateSchema>;

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

/**
 * `GET /v1/office/employees` (administrators): a person of the site, as the
 * cloud's employees. Office data, never in the station feed and never a
 * credential. `operatorId` names the one operator the employee is, `null` for
 * none; the operator keeps its own personnel number, PIN and badges. An
 * archived employee is linked to no operator.
 */
export const employeeRecordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.string().nullable(),
  operatorId: z.uuid().nullable(),
  archived: z.boolean(),
  rev: z.number().int(),
});
export type EmployeeRecord = z.infer<typeof employeeRecordSchema>;

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

/**
 * `GET /v1/office/product-groups`: a ЧЗ product group, the cloud's static
 * lookup. The host answers a bare list by code, not the cloud's `{ items }`.
 */
export const productGroupSchema = z.object({
  code: groupCodeSchema,
  alias: z.string(),
  name: z.string(),
});
export type ProductGroup = z.infer<typeof productGroupSchema>;

/**
 * A product's EGAIS code as the office sends it (plan ТОВ, the cloud's
 * `egaisCode`): 1 to 64 characters after trimming; only a product of ЧЗ
 * group 15 carries one (the host's rule). Answers read it as any text, as
 * every other text of an answer, so a bound counted otherwise never fails
 * the products list or a shift's snapshot.
 */
export const egaisCodeSchema = z.string().min(1).max(64);

/** SHA-256 in lower-case hex. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Standard base64 with padding (a photo's JPEG, plan ТОВ). */
const base64Schema = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);

/**
 * `GET /v1/office/products`: a product as the office sees it, archived ones
 * included. `gtin14` is the 14 digits the office saved; the two templates are
 * preferences, which the host checks only for their purpose, and so is the
 * A4 sheet its pallets print on (`defaultPalletSheetId`, a sheet of
 * `GET /v1/office/pallet-sheets`, never a label template; absent from a host
 * before it, read as none). Plan ТОВ adds the EGAIS code, the default
 * counterparty and the photo's checksum (`null` without a photo; the bytes
 * come from `getProductPhoto`), each read as none from an older host.
 */
export const officeProductSchema = z.object({
  id: z.uuid(),
  gtin14: z.string(),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: groupCodeSchema.nullable(),
  boxCapacity: countSchema,
  palletBoxCapacity: countSchema,
  shelfLifeDays: countSchema,
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  defaultPalletSheetId: z.uuid().nullable().default(null),
  egaisCode: z.string().nullable().default(null),
  defaultCounterpartyId: z.uuid().nullable().default(null),
  photoChecksum: sha256HexSchema.nullable().default(null),
  archived: z.boolean(),
  status: productStatusSchema,
  rev: z.number().int(),
});
export type OfficeProduct = z.infer<typeof officeProductSchema>;

/**
 * Mirrors `markiro_proto::ProductPhoto` (plan ТОВ): a JPEG the office made, at
 * most 640 × 640 and 300 000 bytes, in standard base64; `checksum` is SHA-256
 * of the bytes.
 */
export const productPhotoSchema = z.object({
  width: z.number().int().min(1).max(640),
  height: z.number().int().min(1).max(640),
  dataBase64: base64Schema,
  checksum: sha256HexSchema,
  updatedAt: z.string(),
});
export type ProductPhoto = z.infer<typeof productPhotoSchema>;

/** Mirrors `markiro_proto::ProductPhotoState`: `GET`/`PUT`/`DELETE /v1/office/products/{id}/photo`. */
export const productPhotoStateSchema = z.object({ photo: productPhotoSchema.nullable() });
export type ProductPhotoState = z.infer<typeof productPhotoStateSchema>;

/** Mirrors `markiro_proto::ProductPhotoPut`: the whole photo, replacing any. */
export const productPhotoPutSchema = z
  .object({
    width: z.number().int().min(1).max(640),
    height: z.number().int().min(1).max(640),
    dataBase64: base64Schema,
  })
  .strict();
export type ProductPhotoPut = z.infer<typeof productPhotoPutSchema>;

/**
 * `GET /v1/office/templates`: a label template without its layout. The size,
 * the resolution and the language come from the stored layout as they stand:
 * `null` where it has nothing of the right type, and a size may be fractional.
 */
export const labelTemplateSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  widthMm: z.number().nullable(),
  heightMm: z.number().nullable(),
  dpi: z.number().int().nonnegative().nullable(),
  language: z.string().nullable(),
  rev: z.number().int(),
});
export type LabelTemplateSummary = z.infer<typeof labelTemplateSummarySchema>;

/** `GET /v1/office/templates/{id}`, and the answer of `POST` and `PUT`: a template with its layout. */
export const labelTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  purpose: templatePurposeSchema,
  enabled: z.boolean(),
  chzProductGroupCodes: groupCodesSchema,
  stock: z.boolean(),
  spec: templateSpecSchema,
  rev: z.number().int(),
});
export type LabelTemplate = z.infer<typeof labelTemplateSchema>;

/**
 * A category's default template of one purpose: an entry of the template
 * defaults, and `data` of a `category_template_defaults` feed item, whose id
 * is `<code>:<purpose>` (`markiro_proto::CategoryTemplateDefault` is both).
 */
export const categoryTemplateDefaultSchema = z.object({
  chzProductGroupCode: groupCodeSchema,
  purpose: templatePurposeSchema,
  templateId: z.uuid(),
});
export type CategoryTemplateDefault = z.infer<typeof categoryTemplateDefaultSchema>;

/**
 * A category's default A4 sheet (`markiro_proto::CategoryPalletSheetDefault`):
 * an entry of the template defaults, by code; a sheet, never a label template.
 * Not in the station feed.
 */
export const categoryPalletSheetDefaultSchema = z
  .object({
    chzProductGroupCode: groupCodeSchema,
    sheetId: z.uuid(),
  })
  .strict();
export type CategoryPalletSheetDefault = z.infer<typeof categoryPalletSheetDefaultSchema>;

/**
 * `GET /v1/office/template-defaults`: the organization's default of each
 * purpose and every category's, by code then purpose, and the A4 sheets chosen
 * by default beside the pallet labels (the organization's and each
 * category's, by code; absent from a host before them, read as none), as one
 * document with its revision.
 */
export const templateDefaultsSchema = z.object({
  defaultBoxTemplateId: z.uuid().nullable(),
  defaultPalletTemplateId: z.uuid().nullable(),
  defaultDuplicateTemplateId: z.uuid().nullable(),
  categories: z.array(categoryTemplateDefaultSchema),
  defaultPalletSheetId: z.uuid().nullable().default(null),
  palletSheetCategories: z.array(categoryPalletSheetDefaultSchema).default([]),
  rev: z.number().int(),
});
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;

/** Mirrors `markiro_proto::ShiftStatus`: planned in the office, active once a station opened it, closed for good. */
export const shiftStatusSchema = z.enum(["planned", "active", "closed"]);
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

/** Mirrors `markiro_proto::ShiftMode`: the host takes only `aggregation` in stage 2a. */
export const shiftModeSchema = z.enum(["aggregation", "validation"]);
export type ShiftMode = z.infer<typeof shiftModeSchema>;

/** Mirrors `markiro_proto::ShiftOrigin`: planned in the office or created at a station (`/S`). */
export const shiftOriginSchema = z.enum(["office", "station"]);
export type ShiftOrigin = z.infer<typeof shiftOriginSchema>;

/** A civil date as the host writes it, `YYYY-MM-DD`; the host has checked it is a real date. */
const civilDateTextSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

/**
 * A shift's figures (plan 2a2), read from its facts on every answer and never
 * stored, so they change without a revision: the live codes in its boxes, open
 * and closed alike («Принято кодов»); the live codes in boxes closed and not
 * taken apart («Кодов в закрытых коробах», the cloud's `containedUnits`); the
 * boxes closed and not taken apart; the open boxes that hold a live code; the
 * host's time of the last record of the shift; its devices, first entry first.
 * A planned shift's are zeros, `null` and `[]`.
 */
export const shiftTotalsSchema = z.object({
  acceptedUnits: z.number().int().nonnegative(),
  unitsInClosedBoxes: z.number().int().nonnegative(),
  closedBoxes: z.number().int().nonnegative(),
  openBoxes: z.number().int().nonnegative(),
  lastFactAt: z.iso.datetime().nullable(),
  deviceIds: z.array(z.uuid()),
  closedPallets: z.number().int().nonnegative(),
  openPallets: z.number().int().nonnegative(),
});
export type ShiftTotals = z.infer<typeof shiftTotalsSchema>;

/**
 * `GET /v1/office/shifts`, `GET …/{id}` and the answer of every office write of
 * a shift, each with its `totals`. It carries ids, not names: the office names
 * products, lines, counterparties and devices from its own lists.
 * `closeReasonCode` is one of the domain's six codes of a station's close
 * (plan 2a2), read as text so a code a newer host adds does not fail the list;
 * `closeReasonText` is the office's words. The pallet capacity and template
 * are set exactly when `palletsEnabled` (plan ПЛ-Х).
 */
export const officeShiftSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  status: shiftStatusSchema,
  mode: shiftModeSchema,
  palletsEnabled: z.boolean(),
  createdFrom: shiftOriginSchema,
  productId: z.uuid(),
  lineId: z.uuid(),
  counterpartyId: z.uuid().nullable(),
  productionDate: civilDateTextSchema,
  plannedQty: z.number().int().positive().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  palletBoxCapacity: z.number().int().positive().nullable(),
  palletTemplateId: z.uuid().nullable(),
  palletSheetTemplateId: z.uuid().nullable(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closeReasonCode: z.string().nullable(),
  closeReasonText: z.string().nullable(),
  lateDataAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  rev: z.number().int(),
  totals: shiftTotalsSchema,
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

/**
 * Mirrors `markiro_proto::ShiftExportRows`: `GET /v1/office/shifts/{id}/export-source`
 * (plan ЧЗ), what a shift's exports are built from, in one snapshot of the
 * host. `codes` are the codes the shift owns with their owning scans'
 * canonical text; `boxes` every box of the shift; `items` the live items of
 * those boxes only; `pallets` every pallet of the shift. A device's ids,
 * SSCCs and codes are read as plain text: the ported source rules and the
 * domain's renderer say what is wrong with one (`INVALID_BOX_SSCC`,
 * `INVALID_CIS`), as the cloud's export does, instead of the whole answer
 * failing as an invalid response.
 */
export const shiftExportRowsSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    number: z.string().min(1),
    status: shiftStatusSchema,
    productionDate: civilDateTextSchema,
    productName: z.string(),
    palletsEnabled: z.boolean(),
    closedAt: z.iso.datetime().nullable(),
    stationClosedAt: z.iso.datetime().nullable(),
    lateDataAt: z.iso.datetime().nullable(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(
    z.object({ codeHash: z.string(), scannedAt: z.iso.datetime(), canonical: z.string() }),
  ),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(z.object({ boxId: z.string(), codeHash: z.string() })),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type ShiftExportRows = z.infer<typeof shiftExportRowsSchema>;

/**
 * Mirrors `markiro_proto::OfficeBox`: a box of `GET /v1/office/shifts/{id}/boxes`
 * (plan ЧЗ, for the shift's card of plan О-Ф). `units` are its live items
 * now; `itemCountReported` and `digestMatches` are what the station's close
 * said and how it compared then, stale once the box is taken apart.
 */
export const officeBoxSchema = z.object({
  id: z.string(),
  deviceId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  palletId: z.string().nullable(),
  units: z.number().int().nonnegative(),
  itemCountReported: z.number().int().nonnegative().nullable(),
  digestMatches: z.boolean().nullable(),
  printVerifiedAt: z.iso.datetime().nullable(),
  printSkippedAt: z.iso.datetime().nullable(),
});
export type OfficeBox = z.infer<typeof officeBoxSchema>;

/**
 * Mirrors `markiro_proto::OfficePallet`: a pallet of `GET
 * /v1/office/shifts/{id}/pallets` (plan ЧЗ, for plan О-Ф). `boxes` are its
 * closed boxes not taken apart and `units` their live items, derived when
 * read; `boxCountReported` is what the station's close counted.
 */
export const officePalletSchema = z.object({
  id: z.string(),
  deviceId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  boxes: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  boxCountReported: z.number().int().positive().nullable(),
  printVerifiedAt: z.iso.datetime().nullable(),
  printSkippedAt: z.iso.datetime().nullable(),
});
export type OfficePallet = z.infer<typeof officePalletSchema>;

/**
 * Mirrors `markiro_proto::BoxReportRows`: `GET /v1/office/boxes/{id}/report-data`
 * (plan О-Ф), what «Состав короба» prints of one box, in one snapshot of the
 * host: the codes the cloud's form prints (the live ones, and of a box taken
 * apart those its disassembly took out), ordered by GTIN and serial, each
 * with the canonical text its DataMatrix encodes. Codes and SSCCs are plain
 * text, as in the export source.
 */
export const boxReportRowsSchema = z.object({
  id: z.string(),
  shiftId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  productName: z.string(),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  items: z.array(z.object({ gtin14: z.string(), serial: z.string(), canonical: z.string() })),
});
export type BoxReportRows = z.infer<typeof boxReportRowsSchema>;

/**
 * Mirrors `markiro_proto::PalletReportRows`: `GET
 * /v1/office/shifts/{id}/pallet-report-data` (plan О-Ф), what «Состав паллеты»
 * and «Ярлык паллеты» print of the shift's pallets, in one snapshot: the
 * shift's number, date and product now, and every pallet opened first first
 * with every box that stood on it closed first first, the boxes taken apart
 * too; a box's `units` are its live items now.
 */
export const palletReportRowsSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    number: z.string().min(1),
    productionDate: civilDateTextSchema,
    productName: z.string(),
    gtin14: z.string(),
    shelfLifeDays: z.number().int().positive().nullable(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
      boxes: z.array(
        z.object({
          id: z.string(),
          sscc: z.string().nullable(),
          closedAt: z.iso.datetime(),
          disassembledAt: z.iso.datetime().nullable(),
          units: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type PalletReportRows = z.infer<typeof palletReportRowsSchema>;

/**
 * The product as a shift froze it when a station opened it
 * (`markiro_proto::ShiftSnapshotProduct`); only an active product opens a
 * shift, so it has a group.
 */
export const shiftSnapshotProductSchema = z.object({
  id: z.uuid(),
  gtin14: z.string(),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: z.number().int().nonnegative(),
  shelfLifeDays: z.number().int().positive().nullable(),
  /** As the shift froze it (plan ТОВ); a snapshot of an older host has none. */
  egaisCode: z.string().nullable().optional(),
});

/**
 * The box template as a shift froze it, with its whole layout: opaque here,
 * as in the feed (`templateSpecSchema`), and checked with the domain's
 * `labelTemplateSpecSchema` where the station enters the shift
 * (`checkShiftSnapshot`, `src/floor/shifts/shift-snapshot.ts`).
 */
export const shiftSnapshotTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rev: z.number().int(),
  spec: templateSpecSchema,
});

/** Mirrors `markiro_proto::ShiftSnapshotSheet`: the A4 sheet a shift froze (plan А4). */
export const shiftSnapshotSheetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.number().int().positive(),
  spec: z.unknown(),
});

/** Mirrors `markiro_proto::ShiftSnapshotOrganization`: the organization a shift froze (plan А4). */
export const shiftSnapshotOrganizationSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  logo: z
    .object({ width: z.number().int(), height: z.number().int(), pixelsBase64: z.string() })
    .nullable(),
});

/**
 * What a shift freezes when a station opens it (`markiro_proto::ShiftSnapshot`):
 * the station prints and reprints from this alone. A response type, so a
 * field a newer host adds is tolerated (and dropped). A shift with pallets
 * freezes its pallet template too (protocol 3); one without has none.
 */
export const shiftSnapshotSchema = z.object({
  product: shiftSnapshotProductSchema,
  boxTemplate: shiftSnapshotTemplateSchema,
  issuerPrefix: z.string(),
  counterpartyName: z.string().nullable(),
  palletTemplate: shiftSnapshotTemplateSchema.optional(),
  palletSheet: shiftSnapshotSheetSchema.optional(),
  organization: shiftSnapshotOrganizationSchema.optional(),
});
export type ShiftSnapshot = z.infer<typeof shiftSnapshotSchema>;

/**
 * A shift as a station sees it (`GET /v1/device/shifts`,
 * `markiro_proto::DeviceShift`): named by the snapshot once open and by the
 * records before; `ownerDeviceId` is the station that opened it, and another
 * station's id means the shift is busy. A shift with pallets names their
 * capacity and template (protocol 3, plan ПЛ-Х); one without names neither —
 * the fields are absent, not `null`.
 */
export const deviceShiftSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  status: shiftStatusSchema,
  mode: shiftModeSchema,
  palletsEnabled: z.boolean(),
  createdFrom: shiftOriginSchema,
  lineId: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  productGtin14: z.string(),
  counterpartyName: z.string().nullable(),
  productionDate: civilDateTextSchema,
  plannedQty: z.number().int().positive().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  palletBoxCapacity: z.number().int().positive().optional(),
  palletTemplateId: z.uuid().optional(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type DeviceShift = z.infer<typeof deviceShiftSchema>;

/** `GET /v1/device/shifts`: the station's shifts, without snapshots. */
export const deviceShiftsSchema = z.object({ shifts: z.array(deviceShiftSchema) });

/**
 * The answer of `POST /v1/device/shifts/{id}/enter`: the shift, now active and
 * this station's, with its snapshot (the same one on every re-entry).
 */
export const enteredShiftSchema = deviceShiftSchema.extend({ snapshot: shiftSnapshotSchema });
export type EnteredShift = z.infer<typeof enteredShiftSchema>;

/**
 * The scan that owns a code on the host (`markiro_proto::CodeOwner`): the
 * earliest accepted scan of it. `sameDevice` says the scan is this
 * station's own. A `conflict` receipt names its winner in this shape too.
 */
export const codeOwnerSchema = z.object({
  shiftId: z.uuid(),
  shiftNumber: z.string(),
  deviceId: z.uuid(),
  scannedAt: z.string(),
  sameDevice: z.boolean(),
});
export type CodeOwner = z.infer<typeof codeOwnerSchema>;

/** `GET /v1/device/codes/{codeHash}` (`markiro_proto::CodeCheck`): whether an accepted scan owns the code. */
export const codeCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("free") }),
  z.object({ status: z.literal("taken"), owner: codeOwnerSchema }),
]);
export type CodeCheck = z.infer<typeof codeCheckSchema>;

/**
 * The answer of `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlock`):
 * the serials `fromSerial`-`toSerial`, both ends included, of one issuer
 * prefix and extension, issued to this station.
 */
export const ssccBlockSchema = z.object({
  id: z.uuid(),
  issuerPrefix: z.string(),
  extension: z.number().int().min(0).max(9),
  fromSerial: z.number().int().nonnegative(),
  toSerial: z.number().int().nonnegative(),
});
export type SsccBlock = z.infer<typeof ssccBlockSchema>;

/** How the host answered a fact (`markiro_proto::FactOutcome`). */
export const FACT_OUTCOMES = ["accepted", "conflict", "rejected"] as const;
export type FactOutcome = (typeof FACT_OUTCOMES)[number];

/**
 * The codes of a `rejected` receipt (`markiro_proto::receipt_codes`,
 * `proto/fixtures/fact-receipt-codes.json`). A receipt carries its code as
 * text: a code a newer host adds does not fail the batch.
 */
export const FACT_RECEIPT_CODES = [
  "invalid_record",
  "payload_mismatch",
  "unknown_shift",
  "not_entered",
  "gtin_mismatch",
  "box_unknown",
  "box_closed",
  "box_already_closed",
  "box_state",
  "sscc_not_issued",
  "sscc_taken",
  "no_pallets",
  "pallet_unknown",
  "pallet_already_closed",
  "pallet_state",
] as const;

/**
 * The host's answer to one record (`markiro_proto::FactReceipt`): `id` is the
 * record's, or `null` when the host could not read it (the receipt then
 * matches its record by its place in the batch); a `rejected` one names its
 * code; `details` carries the field of an `invalid_record`, the winner of a
 * `conflict` and `alreadyClosed` of a shift's close.
 */
export const factReceiptSchema = z.object({
  id: z.string().nullable(),
  outcome: z.enum(FACT_OUTCOMES),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type FactReceipt = z.infer<typeof factReceiptSchema>;

/** The answer of `POST /v1/device/facts`: a receipt per record, in the records' order. */
export const factReceiptsSchema = z.object({ receipts: z.array(factReceiptSchema) });

// --- Warehouse label reprint (plan СКЛ) ---

/**
 * What `POST /v1/device/warehouse/lookup` asks (`markiro_proto::WarehouseLookup`):
 * the hash of a unit's code (`kmHash`) or the SSCC of a box or a pallet, one of the two.
 */
export const warehouseLookupSchema = z.union([
  z.object({ codeHash: z.string() }).strict(),
  z.object({ sscc: z.string() }).strict(),
]);
export type WarehouseLookup = z.infer<typeof warehouseLookupSchema>;

/** What a warehouse reprint prints (`markiro_proto::WarehouseSubjectKind`). */
export const WAREHOUSE_SUBJECT_KINDS = ["unit", "box", "pallet"] as const;
export type WarehouseSubjectKind = (typeof WAREHOUSE_SUBJECT_KINDS)[number];

/**
 * A record the host found (`markiro_proto::WarehouseSource`): what its label is
 * rendered from, the full canonical code of a unit, the SSCC of a box or a pallet.
 */
export const warehouseSourceSchema = z.object({
  kind: z.enum(WAREHOUSE_SUBJECT_KINDS),
  subjectId: z.string().min(1),
  identity: z.string().min(1),
  canonical: z.string().optional(),
  sscc: z.string().optional(),
  product: shiftSnapshotProductSchema,
  counterpartyName: z.string().nullable(),
  shiftId: z.uuid(),
  shiftNumber: z.string(),
  productionDate: z.string(),
  at: z.string(),
  itemCount: z.number().int().nonnegative(),
  boxCount: z.number().int().nonnegative().optional(),
  operatorName: z.string().nullable(),
  deviceId: z.uuid(),
});
export type WarehouseSource = z.infer<typeof warehouseSourceSchema>;

/** Why a found record is not printed again (`markiro_proto::WarehouseUnavailable`). */
export const WAREHOUSE_UNAVAILABLE = ["released", "disassembled"] as const;

/** The answer of `POST /v1/device/warehouse/lookup`. */
export const warehouseLookupResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), source: warehouseSourceSchema }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unavailable"), reason: z.enum(WAREHOUSE_UNAVAILABLE) }),
]);
export type WarehouseLookupResult = z.infer<typeof warehouseLookupResultSchema>;

/** `markiro_proto::WAREHOUSE_REASONS`: why a label is printed again. */
export const WAREHOUSE_REASONS = ["not_printed", "damaged", "lost"] as const;
/** `markiro_proto::WAREHOUSE_OUTCOMES`: where one attempt ended. */
export const WAREHOUSE_OUTCOMES = ["sent", "unknown", "failed", "verified", "cancelled"] as const;
/** `markiro_proto::warehouse_receipt_codes` (`proto/fixtures/warehouse-receipt-codes.json`). */
export const WAREHOUSE_RECEIPT_CODES = [
  "invalid_record",
  "payload_mismatch",
  "subject_unknown",
] as const;

/** One attempt of a reprint as recorded (`markiro_proto::WarehouseRecord`). */
export const warehouseRecordSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    jobId: z.uuid(),
    attempt: z.number().int().nonnegative(),
    subjectKind: z.enum(WAREHOUSE_SUBJECT_KINDS),
    subjectId: z.string().min(1),
    identity: z.string().min(1),
    reasonCode: z.enum(WAREHOUSE_REASONS),
    repair: z.literal("legacy_tspl_fnc1_literal").nullable(),
    templateId: z.string().min(1),
    templateRev: z.number().int().nonnegative(),
    outcome: z.enum(WAREHOUSE_OUTCOMES),
    errorCode: z.string().nullable(),
    operatorId: z.uuid().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type WarehouseRecord = z.infer<typeof warehouseRecordSchema>;

/** `POST /v1/device/warehouse/reprints`; the answer is `factReceiptsSchema`. */
export const warehouseBatchSchema = z
  .object({ records: z.array(warehouseRecordSchema).min(1).max(100) })
  .strict();

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

/**
 * A stock label template of the wizard (plan 1e3 sends them): stored enabled,
 * for every category, and kept as it came. `orgDefault: true` makes it the
 * organization's default of its purpose; left out it is `false`, and the host
 * refuses `null` there.
 */
export const stockTemplateSchema = z
  .object({
    name: z.string(),
    purpose: templatePurposeSchema,
    spec: templateSpecSchema,
    orgDefault: z.boolean().optional(),
  })
  .strict();
export type StockTemplate = z.infer<typeof stockTemplateSchema>;

/** `templates` may be left out (a wizard before plan 1e3), never `null`. */
export const bootstrapRequestSchema = z
  .object({
    admin: newOfficeUserSchema,
    org: orgProfileInputSchema,
    sscc: ssccStartSchema,
    lines: z.array(z.string()),
    templates: z.array(stockTemplateSchema).optional(),
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

/** `POST /v1/office/employees`; the office always sends `role` and `operatorId`, `null` for none. */
export const employeeCreateSchema = z
  .object({ name: z.string(), role: z.string().nullable(), operatorId: z.uuid().nullable() })
  .strict();
export type EmployeeCreate = z.infer<typeof employeeCreateSchema>;

/**
 * `PUT /v1/office/employees/{id}`: the whole record; `operatorId: null`
 * unlinks, and `archived: true` needs `operatorId: null`.
 */
export const employeeUpdateSchema = z
  .object({
    name: z.string(),
    role: z.string().nullable(),
    operatorId: z.uuid().nullable(),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type EmployeeUpdate = z.infer<typeof employeeUpdateSchema>;

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

/**
 * `POST /v1/office/products`: the GTIN as its 14 digits; the office sends
 * every field, `null` for one left blank.
 */
export const productCreateSchema = z
  .object({
    gtin14: z.string(),
    name: z.string(),
    printName: z.string().nullable(),
    chzProductGroupCode: groupCodeSchema.nullable(),
    boxCapacity: countSchema,
    palletBoxCapacity: countSchema,
    shelfLifeDays: countSchema,
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
    defaultPalletSheetId: z.uuid().nullable(),
    egaisCode: egaisCodeSchema.nullable(),
    defaultCounterpartyId: z.uuid().nullable(),
  })
  .strict();
export type ProductCreate = z.infer<typeof productCreateSchema>;

/**
 * `PUT /v1/office/products/{id}`: the whole record with `archived` and the
 * loaded revision, as a counterparty's; `null` clears a field. The office
 * always sends `defaultPalletSheetId`, `egaisCode` and `defaultCounterpartyId`
 * (the host keeps each when an older office leaves it out).
 */
export const productUpdateSchema = z
  .object({
    gtin14: z.string(),
    name: z.string(),
    printName: z.string().nullable(),
    chzProductGroupCode: groupCodeSchema.nullable(),
    boxCapacity: countSchema,
    palletBoxCapacity: countSchema,
    shelfLifeDays: countSchema,
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
    defaultPalletSheetId: z.uuid().nullable(),
    egaisCode: egaisCodeSchema.nullable(),
    defaultCounterpartyId: z.uuid().nullable(),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;

/** `POST /v1/office/templates`: a template of the office's own; `chzProductGroupCodes: null` for every category. */
export const templateCreateSchema = z
  .object({
    name: z.string(),
    purpose: templatePurposeSchema,
    enabled: z.boolean(),
    chzProductGroupCodes: groupCodesSchema,
    spec: templateSpecSchema,
  })
  .strict();
export type TemplateCreate = z.infer<typeof templateCreateSchema>;

/**
 * `PUT /v1/office/templates/{id}`: only the fields sent change. Categories
 * have three states: left out keeps them, `null` widens the template to every
 * category, a list narrows it to those. `name`, `enabled` and `spec` are left
 * out or a value, never `null`: the host would read `null` there as «keep»,
 * which only leaving the field out says here. A purpose never changes, so it
 * is no field.
 */
export const templateUpdateSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: groupCodesSchema.optional(),
    spec: templateSpecSchema.optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;

/** A category default in `PUT /v1/office/template-defaults`. */
export const categoryTemplateDefaultInputSchema = z
  .object({
    chzProductGroupCode: groupCodeSchema,
    purpose: templatePurposeSchema,
    templateId: z.uuid(),
  })
  .strict();

/**
 * `PUT /v1/office/template-defaults`: the whole document over the loaded
 * revision. An organization default `null` is none; a category default left
 * out of `categories` (or of `palletSheetCategories`) is cleared. The office
 * always sends the sheet defaults (the host keeps them when an older office
 * leaves them out).
 */
export const templateDefaultsUpdateSchema = z
  .object({
    defaultBoxTemplateId: z.uuid().nullable(),
    defaultPalletTemplateId: z.uuid().nullable(),
    defaultDuplicateTemplateId: z.uuid().nullable(),
    categories: z.array(categoryTemplateDefaultInputSchema),
    defaultPalletSheetId: z.uuid().nullable(),
    palletSheetCategories: z.array(categoryPalletSheetDefaultSchema),
    expectedRev: z.number().int(),
  })
  .strict();
export type TemplateDefaultsUpdate = z.infer<typeof templateDefaultsUpdateSchema>;

/**
 * `POST /v1/office/shifts`: a planned shift. The office always sends the box
 * capacity, `null` for no plan or no counterparty, and `mode` and
 * `palletsEnabled`. A shift with pallets names its pallet template and may
 * name its pallet capacity (the product's when left out); one without sends
 * neither (plan ПЛ-Х).
 */
export const shiftCreateSchema = z
  .object({
    productId: z.uuid(),
    lineId: z.uuid(),
    productionDate: z.string(),
    boxTemplateId: z.uuid(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
    palletSheetTemplateId: z.uuid().optional(),
  })
  .strict();
export type ShiftCreate = z.infer<typeof shiftCreateSchema>;

/**
 * `PUT /v1/office/shifts/{id}`: only the fields sent change, over the loaded
 * revision. `plannedQty: null` and `counterpartyId: null` clear them;
 * `palletSheetTemplateId: null` is «the organization's main sheet», resolved
 * by the host at this edit (plan А4); every other field is left out or a
 * value, never `null`, which the host would read as «keep». The product never changes, so it is no field. Pallets turned
 * off clear their capacity and template, which the edit then does not send.
 */
export const shiftUpdateSchema = z
  .object({
    lineId: z.uuid().optional(),
    productionDate: z.string().optional(),
    boxTemplateId: z.uuid().optional(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
    palletSheetTemplateId: z.uuid().nullable().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type ShiftUpdate = z.infer<typeof shiftUpdateSchema>;

/** `POST /v1/office/shifts/{id}/close`: the office's reason in words, over the loaded revision. */
export const shiftCloseSchema = z
  .object({ reason: z.string(), expectedRev: z.number().int() })
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;

/**
 * Mirrors `markiro_proto::ShiftExportRecord`: `POST /v1/office/shifts/{id}/exports`
 * (plan ЧЗ), the record of an export the office saved. Built only by
 * `shiftExportRecord` (`src/host/requests.ts`).
 */
export const shiftExportRecordSchema = z
  .object({
    formatId: z.string(),
    formatVersion: z.number().int(),
    maxLines: z.number().int().nullable(),
    palletId: z.string().nullable(),
    documentId: z.uuid(),
    partCount: z.number().int(),
    codeCount: z.number().int(),
    boxCount: z.number().int(),
    palletCount: z.number().int(),
    openPalletSuppressedBoxCount: z.number().int(),
  })
  .strict();
export type ShiftExportRecord = z.infer<typeof shiftExportRecordSchema>;

/** `MAJOR.MINOR.PATCH` as `markiro_proto::update::AppVersion` reads it: no leading zeros, nothing around it. */
export const appVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
  // Each part is a `u32` on the Rust side.
  .refine((text) => text.split(".").every((part) => Number(part) <= 4_294_967_295));

/**
 * Mirrors `markiro_proto::update::UpdateStarted`: `POST /v1/office/updates/started`
 * (plan ОБН-2), the office starts an installer on its PC. No device: the host
 * takes the session's.
 */
export const updateStartedSchema = z
  .object({
    from: appVersionSchema,
    to: appVersionSchema,
    installerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    source: z.enum(["file", "host"]),
  })
  .strict();
export type UpdateStarted = z.infer<typeof updateStartedSchema>;

/**
 * `POST /v1/device/shifts` (`markiro_proto::DeviceShiftCreate`): a station's
 * planned shift on its own line. `requestId`, a UUID the station made up,
 * makes it repeatable: the same request answers the shift it created. A
 * shift with pallets names its pallet template and may name its pallet
 * capacity (the product's when left out); one without sends none of the
 * three (protocol 3, `device-shift-create-pallets.json`).
 */
export const deviceShiftCreateSchema = z
  .object({
    requestId: z.uuid(),
    productId: z.uuid(),
    boxTemplateId: z.uuid(),
    productionDate: z.string(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
    palletSheetTemplateId: z.uuid().optional(),
  })
  .strict();
export type DeviceShiftCreate = z.infer<typeof deviceShiftCreateSchema>;

/**
 * `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlockRequest`): a block
 * of the shift's issuer prefix and an extension (0, a box; 1, a pallet). The station keeps
 * the request (`floor_block_requests`) and repeats it whole until it has the
 * block: the same `requestId` answers the same block.
 */
export const ssccBlockRequestSchema = z
  .object({
    requestId: z.uuid(),
    issuerPrefix: z.string(),
    extension: z.number().int().min(0).max(9),
  })
  .strict();
export type SsccBlockRequest = z.infer<typeof ssccBlockRequestSchema>;

/** The verdict of a scan (`markiro_proto::ScanVerdict`). */
export const SCAN_VERDICTS = ["ok", "duplicate", "wrong_gtin", "invalid"] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/** What the domain's `classifyScan` read a scan as (`markiro_proto::ScanRawKind`). */
export const SCAN_RAW_KINDS = ["km", "gtin", "sscc", "unknown"] as const;
export type ScanRawKind = (typeof SCAN_RAW_KINDS)[number];

/**
 * A code of marking as the domain read it (`markiro_proto::ScannedCode`):
 * `codeHash` is `kmHash`, `canonical` the text `canonicalizeKm` kept, its
 * group separators and crypto tail included.
 */
export const scannedCodeSchema = z
  .object({ codeHash: z.string(), gtin14: z.string(), serial: z.string(), canonical: z.string() })
  .strict();
export type ScannedCode = z.infer<typeof scannedCodeSchema>;

/**
 * `data` of a `scan` fact (`markiro_proto::ScanFact`). Every instant of a fact
 * is exactly what `Date.toISOString` writes (`device-instants.json`); the
 * host refuses any other form.
 */
export const scanFactSchema = z
  .object({
    scannedAt: z.string(),
    verdict: z.enum(SCAN_VERDICTS),
    duplicateSource: z.enum(["local", "host"]).nullable(),
    rawKind: z.enum(SCAN_RAW_KINDS),
    rawLength: z.number().int().nonnegative(),
    code: scannedCodeSchema.nullable(),
    boxId: z.uuid().nullable(),
  })
  .strict();
export type ScanFact = z.infer<typeof scanFactSchema>;

/**
 * `data` of a `box_closed` fact (`markiro_proto::BoxClosedFact`); `palletId`
 * is the pallet the box joined as it closed (protocol 3, plan ПЛ-Х), absent
 * in a shift without pallets.
 */
export const boxClosedFactSchema = z
  .object({
    boxId: z.uuid(),
    sscc: z.string(),
    blockId: z.uuid(),
    serial: z.number().int().nonnegative(),
    openedAt: z.string(),
    closedAt: z.string(),
    itemCount: z.number().int().positive(),
    membershipDigest: z.string(),
    palletId: z.uuid().optional(),
  })
  .strict();
export type BoxClosedFact = z.infer<typeof boxClosedFactSchema>;

/** `data` of a `box_label` fact (`markiro_proto::BoxLabelFact`). */
export const boxLabelFactSchema = z
  .object({ boxId: z.uuid(), outcome: z.enum(["verified", "skipped"]), at: z.string() })
  .strict();
export type BoxLabelFact = z.infer<typeof boxLabelFactSchema>;

/** `data` of a `box_exception` fact (`markiro_proto::BoxExceptionFact`); the fields of each kind are the host's rule. */
export const boxExceptionFactSchema = z
  .object({
    exception: z.enum(["undo", "clear", "reprint", "disassemble"]),
    boxId: z.uuid(),
    codeHash: z.string().nullable(),
    targetScannedAt: z.string().nullable(),
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type BoxExceptionFact = z.infer<typeof boxExceptionFactSchema>;

/** `data` of a `shift_closed` fact (`markiro_proto::ShiftClosedFact`). */
export const shiftClosedFactSchema = z
  .object({
    plannedQtySnapshot: z.number().int().positive().nullable(),
    actualQty: z.number().int().nonnegative(),
    closedBoxCount: z.number().int().nonnegative(),
    reasonCode: z.string().nullable(),
    closedAt: z.string(),
  })
  .strict();
export type ShiftClosedFact = z.infer<typeof shiftClosedFactSchema>;

/**
 * `data` of a `pallet_closed` fact (`markiro_proto::PalletClosedFact`): the
 * pallet closed with the SSCC of one of this station's blocks of extension 1;
 * `openedAt` is when its first box closed, `boxCount` the boxes on it that
 * are not taken apart, as this station counts them.
 */
export const palletClosedFactSchema = z
  .object({
    palletId: z.uuid(),
    sscc: z.string(),
    blockId: z.uuid(),
    serial: z.number().int().nonnegative(),
    openedAt: z.string(),
    closedAt: z.string(),
    boxCount: z.number().int().positive(),
  })
  .strict();
export type PalletClosedFact = z.infer<typeof palletClosedFactSchema>;

/** `data` of a `pallet_label` fact (`markiro_proto::PalletLabelFact`): the check of a closed pallet's label. */
export const palletLabelFactSchema = z
  .object({ palletId: z.uuid(), outcome: z.enum(["verified", "skipped"]), at: z.string() })
  .strict();
export type PalletLabelFact = z.infer<typeof palletLabelFactSchema>;

/**
 * `data` of a `pallet_exception` fact (`markiro_proto::PalletExceptionFact`):
 * a reprint or a disassembly of a closed pallet, always with a reason code,
 * and words only with `other`.
 */
export const palletExceptionFactSchema = z
  .object({
    exception: z.enum(["reprint", "disassemble"]),
    palletId: z.uuid(),
    reasonCode: z.string(),
    reasonText: z.string().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type PalletExceptionFact = z.infer<typeof palletExceptionFactSchema>;

/** The envelope of every record: its own id, the shift and the operator signed in, or `null`. */
const factHead = { id: z.uuid(), shiftId: z.uuid(), operatorId: z.uuid().nullable() };

/**
 * One record of the outbox (`markiro_proto::FactRecord`): the envelope and
 * `data` read by `kind`. The outbox keeps it whole as its `payload`, and it is
 * sent as kept.
 */
export const factRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...factHead, kind: z.literal("scan"), data: scanFactSchema }).strict(),
  z.object({ ...factHead, kind: z.literal("box_closed"), data: boxClosedFactSchema }).strict(),
  z.object({ ...factHead, kind: z.literal("box_label"), data: boxLabelFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("box_exception"), data: boxExceptionFactSchema })
    .strict(),
  z.object({ ...factHead, kind: z.literal("shift_closed"), data: shiftClosedFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("pallet_closed"), data: palletClosedFactSchema })
    .strict(),
  z.object({ ...factHead, kind: z.literal("pallet_label"), data: palletLabelFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("pallet_exception"), data: palletExceptionFactSchema })
    .strict(),
]);
export type FactRecord = z.infer<typeof factRecordSchema>;
export type FactKind = FactRecord["kind"];

/** `POST /v1/device/facts` (`markiro_proto::FactBatch`): 1-100 records, in the outbox's order. */
export const MAX_FACT_BATCH = 100;
export const factBatchSchema = z
  .object({ records: z.array(factRecordSchema).min(1).max(MAX_FACT_BATCH) })
  .strict();
