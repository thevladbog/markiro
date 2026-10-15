import type { DeviceInfo, DeviceLicense, OfficeLicense } from "../../src/host/protocol.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";

export const LICENSE_ID = "5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f";
export const HOST_FINGERPRINT = "cd".repeat(32);
/** INNs with a valid checksum (plan ЛЦ-2, Д10): the organization's and another one. */
export const ORG_INN = "7707083893";
export const OTHER_INN = "7802000015";

/**
 * A subscription valid through 31.10.2027 in Moscow (`validUntil` is the
 * exclusive 01.11.2027 00:00 MSK), nothing to warn of: the office's default
 * answer, so every office test that is not about the license stays silent.
 */
export const ACTIVE_LICENSE: OfficeLicense = {
  state: "active",
  since: "2026-10-01T00:00:00Z",
  flags: { clockBehindDays: null, clockAhead: false },
  effectiveAt: "2026-10-20T09:00:00Z",
  phaseEndsAt: "2027-10-01T21:00:00Z",
  daysLeft: 346,
  warnDays: 30,
  opensNewShifts: true,
  license: {
    licenseId: LICENSE_ID,
    sequence: 3,
    kid: "lic-2026-1",
    customer: { name: "ООО «Атолл»", inn: ORG_INN },
    plan: "subscription",
    planVersionId: "0d5c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    issuedAt: "2026-10-01T08:00:00Z",
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2027-10-31T21:00:00Z",
    graceDays: 14,
  },
  trial: null,
  binding: {
    hostId: HOST_ID,
    fingerprint: HOST_FINGERPRINT,
    orgInn: ORG_INN,
    innMatches: true,
  },
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 5, used: 3, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 3, used: 2, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: false,
    commerceMl: false,
    handheld: true,
    customLogo: true,
  },
  emergency: { available: false, until: null },
};

export function licenseOf(patch: Partial<OfficeLicense>): OfficeLicense {
  return { ...ACTIVE_LICENSE, ...patch };
}

const TRIAL_PERIOD = {
  startedAt: "2026-10-10T09:00:00Z",
  endsAt: "2026-10-24T09:00:00Z",
  inn: ORG_INN,
};

/** The built-in trial, 12 days left of 14: the neutral line. */
export const TRIAL = licenseOf({
  state: "trial",
  since: TRIAL_PERIOD.startedAt,
  effectiveAt: "2026-10-12T09:00:00Z",
  phaseEndsAt: TRIAL_PERIOD.endsAt,
  daysLeft: 12,
  warnDays: 4,
  license: null,
  trial: TRIAL_PERIOD,
  quotas: {
    lines: { limit: null, used: 1, over: false },
    stations: { limit: null, used: 1, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: null, used: 1, over: false },
  },
});

/** The trial with 4 days left: the warning tone (spec §3.2, from the 10th day). */
export const TRIAL_ENDING = licenseOf({
  ...TRIAL,
  effectiveAt: "2026-10-20T09:00:00Z",
  daysLeft: 4,
});

/** A 14-day demo file, still valid. */
export const DEMO = licenseOf({
  phaseEndsAt: "2026-10-30T21:00:00Z",
  daysLeft: 14,
  warnDays: 4,
  license: {
    ...ACTIVE_LICENSE.license!,
    plan: "demo",
    graceDays: 0,
    validUntil: "2026-11-03T21:00:00Z",
  },
});

export const EXPIRING = licenseOf({
  state: "expiring",
  since: "2027-10-01T21:00:00Z",
  effectiveAt: "2027-10-11T09:00:00Z",
  phaseEndsAt: "2027-10-31T21:00:00Z",
  daysLeft: 20,
});

/** Expired 31.10.2027; the 14 days of grace end on 14.11.2027 inclusive. */
export const GRACE = licenseOf({
  state: "grace",
  since: "2027-10-31T21:00:00Z",
  effectiveAt: "2027-11-05T09:00:00Z",
  phaseEndsAt: "2027-11-14T21:00:00Z",
  daysLeft: 9,
});

/** Past the grace: no new shift since 15.11.2027 (Moscow), the emergency still unused. */
export const RESTRICTED = licenseOf({
  state: "restricted",
  since: "2027-11-14T21:00:00Z",
  effectiveAt: "2027-11-20T06:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  emergency: { available: true, until: null },
});

export const TRIAL_EXPIRED = licenseOf({
  ...TRIAL,
  state: "trial_expired",
  since: TRIAL_PERIOD.endsAt,
  effectiveAt: "2026-10-25T09:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  emergency: { available: true, until: null },
});

export const WRONG_HOST = licenseOf({
  state: "wrong_host",
  since: "2026-10-20T09:00:00Z",
  phaseEndsAt: "2026-11-19T09:00:00Z",
  daysLeft: 30,
});

/** The organization's INN changed after the load: no new shift since 18.10.2026. */
export const INN_MISMATCH = licenseOf({
  state: "inn_mismatch",
  since: "2026-10-18T09:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  binding: { ...ACTIVE_LICENSE.binding, orgInn: OTHER_INN, innMatches: false },
  emergency: { available: true, until: null },
});

/** `GET /v1/device` without a license (a host before plan ЛЦ-2): the station stays silent. */
export const DEVICE_INFO: DeviceInfo = {
  id: DEVICE_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: null,
  pairedAt: "2026-09-26T09:15:00Z",
};

/** The license line of `GET /v1/device` in `state`. */
export function deviceLicense(
  state: string,
  phaseEndsAt: string | null = null,
  emergencyUntil: string | null = null,
): DeviceLicense {
  return { state, since: "2027-11-14T21:00:00Z", phaseEndsAt, emergencyUntil };
}
