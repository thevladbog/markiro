import { canonicalizeKm, kmHash } from "../gs1/km.js";
import {
  classifyInventoryScan,
  resolveInventoryScanSourceDate,
  type InventoryLocalClaim,
  type InventoryScanClassification,
  type InventoryScanSnapshotRow,
  type InventoryScanSourceDate,
} from "./scan.js";
import { inventoryEventBatchDigest, type InventoryEventBatchPayload } from "./station-sync.js";

/**
 * Cases the handheld's Kotlin `InventoryClassifier` and `InventoryBatchCodec`
 * must reproduce. Exported to
 * `apps/handheld/app/src/test/resources/inventory-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:inventory`;
 * `test/inventory-fixtures.test.ts` fails when the committed JSON drifts.
 */
export interface InventoryClassifyFixture {
  name: string;
  taskGtin14: string;
  rows: InventoryScanSnapshotRow[];
  claims: InventoryLocalClaim[];
  raw: string;
  expected: InventoryScanClassification;
  sourceDate: InventoryScanSourceDate;
}

export interface InventoryBatchDigestFixture {
  name: string;
  payload: InventoryEventBatchPayload;
  digest: string;
}

export interface InventoryFixtures {
  classify: InventoryClassifyFixture[];
  batchDigest: InventoryBatchDigestFixture[];
}

const GTIN = "04600000000015";
const OTHER_GTIN = "04600682000013";
const SSCC = "346006820000000014";
const OTHER_SSCC = "346006820000000021";
const GS = "\u001d";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";

function raw(serial: string, gtin14 = GTIN): string {
  return `01${gtin14}21${serial}${GS}91KEY${GS}92SIGNATURE`;
}

function row(
  serial: string,
  values: Partial<InventoryScanSnapshotRow> = {},
): InventoryScanSnapshotRow {
  const km = canonicalizeKm(raw(serial));
  return {
    codeHash: kmHash(km),
    canonicalRaw: km.raw,
    gtin14: km.gtin14,
    serial: km.serial,
    sourceStatus: "INTRODUCED",
    sourceState: null,
    sourceProductionDate: "2026-08-20",
    expected: true,
    protected: false,
    parentSscc: null,
    ...values,
  };
}

function claim(
  codeHash: string,
  deviceId: string,
  scannedAt: string,
  eventId: string,
): InventoryLocalClaim {
  return { codeHash, eventId, deviceId, scannedAt };
}

interface Scenario {
  name: string;
  rows: InventoryScanSnapshotRow[];
  claims?: InventoryLocalClaim[];
  raw: string;
}

function scenarios(): Scenario[] {
  const expected = row("EXPECTED-1");
  const dated = row("DATED-1", { sourceProductionDate: "2026-08-05" });
  const emitted = row("EMITTED", { sourceStatus: "EMITTED", expected: false });
  const retired = row("RETIRED", { sourceStatus: "RETIRED", expected: false });
  const moving = row("MOVING", { sourceState: "MOVING_BY_UD", expected: true });
  const flagged = row("FLAGGED", { protected: true, expected: false });
  const boxA = row("BOX-A", { parentSscc: SSCC, sourceProductionDate: "2026-08-10" });
  const boxB = row("BOX-B", { parentSscc: SSCC, sourceProductionDate: "2026-08-10" });
  const boxC = row("BOX-C", { parentSscc: SSCC, sourceProductionDate: "2026-08-12" });
  const boxProtected = row("BOX-P", { parentSscc: SSCC, sourceState: "MOVING_BY_UD" });
  const boxIneligible = row("BOX-I", {
    parentSscc: SSCC,
    sourceStatus: "APPLIED",
    expected: false,
  });
  const onlyProtected = row("ONLY-P", { parentSscc: OTHER_SSCC, sourceState: "MOVING_BY_UD" });
  const onlyIneligible = row("ONLY-I", {
    parentSscc: OTHER_SSCC,
    sourceStatus: "RETIRED",
    expected: false,
  });
  const claimedA = claim(
    boxA.codeHash,
    DEVICE,
    "2026-08-25T10:00:00.000Z",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const claimedB = claim(
    boxB.codeHash,
    OTHER_DEVICE,
    "2026-08-25T09:59:00.000Z",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
  const claimedC = claim(
    boxC.codeHash,
    OTHER_DEVICE,
    "2026-08-25T09:59:00.000Z",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  );
  return [
    {
      name: "expected item with aim prefix and edges",
      rows: [expected],
      raw: ` \t]d2${raw("EXPECTED-1")}\t `,
    },
    { name: "expected item plain", rows: [expected], raw: raw("EXPECTED-1") },
    { name: "expected item with its own date", rows: [dated], raw: raw("DATED-1") },
    { name: "wrong gtin", rows: [], raw: raw("OTHER", OTHER_GTIN) },
    { name: "bare gtin is unsupported", rows: [], raw: GTIN },
    { name: "malformed", rows: [], raw: "not a code" },
    { name: "emitted is known ineligible", rows: [emitted], raw: emitted.canonicalRaw },
    { name: "retired is known ineligible", rows: [retired], raw: retired.canonicalRaw },
    { name: "moving by ud is protected", rows: [moving], raw: moving.canonicalRaw },
    { name: "protected flag wins", rows: [flagged], raw: flagged.canonicalRaw },
    { name: "unknown item", rows: [], raw: raw("NOWHERE") },
    {
      name: "duplicate item here",
      rows: [expected],
      claims: [
        claim(
          expected.codeHash,
          DEVICE,
          "2026-08-25T08:00:00.000Z",
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ),
      ],
      raw: raw("EXPECTED-1"),
    },
    { name: "box with aim prefix", rows: [boxA, boxB], raw: `]C100${SSCC}` },
    { name: "box with parentheses", rows: [boxA, boxB], raw: `(00)${SSCC}` },
    { name: "box bare twenty digits", rows: [boxA, boxB], raw: `00${SSCC}` },
    { name: "box bare eighteen digits mixed dates", rows: [boxA, boxC], raw: SSCC },
    {
      name: "box partially claimed keeps single date",
      rows: [boxA, boxB, boxC],
      claims: [claimedC],
      raw: SSCC,
    },
    {
      name: "box fully claimed is duplicate with the earliest winner",
      rows: [boxA, boxB],
      claims: [claimedA, claimedB],
      raw: SSCC,
    },
    {
      name: "box with only protected left",
      rows: [boxA, boxProtected],
      claims: [claimedA],
      raw: SSCC,
    },
    {
      name: "box with only ineligible left",
      rows: [boxA, boxIneligible],
      claims: [claimedA],
      raw: SSCC,
    },
    {
      name: "box of protected and ineligible",
      rows: [onlyProtected, onlyIneligible],
      raw: OTHER_SSCC,
    },
    { name: "box unknown", rows: [], raw: SSCC },
    { name: "box with a bad check digit is malformed", rows: [], raw: "346006820000000015" },
  ];
}

function classify(scenario: Scenario): InventoryScanClassification {
  const rowsByHash = new Map(scenario.rows.map((item) => [item.codeHash, item]));
  const claimsByHash = new Map((scenario.claims ?? []).map((item) => [item.codeHash, item]));
  return classifyInventoryScan(scenario.raw, {
    taskGtin14: GTIN,
    findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
    findSnapshotChildren: (parentSscc) =>
      scenario.rows.filter((item) => item.parentSscc === parentSscc),
    findLocalClaim: (codeHash) => claimsByHash.get(codeHash) ?? null,
  });
}

function batchPayloads(): { name: string; payload: InventoryEventBatchPayload }[] {
  const unicode = canonicalizeKm(raw("сериЯ-1"));
  const quoted = canonicalizeKm(raw('Q"\\/é'));
  const base = {
    snapshotId: "33333333-3333-4333-8333-333333333333",
    snapshotRevision: 1 as const,
    openBoxCount: 0,
  };
  const event = (
    deviceSequence: number,
    extra: Pick<
      InventoryEventBatchPayload["events"][number],
      "kind" | "normalizedIdentity" | "codeHash" | "canonicalRaw" | "localVerdict"
    >,
  ): InventoryEventBatchPayload["events"][number] => ({
    eventId: `4444444${deviceSequence}-4444-4444-8444-444444444444`,
    deviceSequence,
    operatorId: "55555555-5555-4555-8555-555555555555",
    scannedAt: "2026-08-25T10:00:00.000Z",
    activeProductionDate: "2026-08-20",
    ...extra,
  });
  return [
    {
      name: "single expected item with unicode serial and gs",
      payload: {
        ...base,
        sequenceCeiling: 1,
        pendingEventCount: 0,
        events: [
          event(1, {
            kind: "item",
            normalizedIdentity: `item:${kmHash(unicode)}`,
            codeHash: kmHash(unicode),
            canonicalRaw: unicode.raw,
            localVerdict: "expected",
          }),
        ],
      },
    },
    {
      name: "known box and old box",
      payload: {
        ...base,
        sequenceCeiling: 3,
        pendingEventCount: 7,
        events: [
          event(2, {
            kind: "known_box",
            normalizedIdentity: `known_box:${SSCC}`,
            codeHash: null,
            canonicalRaw: SSCC,
            localVerdict: "expected",
          }),
          event(3, {
            kind: "old_box",
            normalizedIdentity: `old_box:${OTHER_SSCC}`,
            codeHash: null,
            canonicalRaw: OTHER_SSCC,
            localVerdict: "unknown",
          }),
        ],
      },
    },
    {
      name: "duplicate with quote backslash slash and a non-ascii letter in the serial",
      payload: {
        ...base,
        sequenceCeiling: 4,
        pendingEventCount: 0,
        events: [
          event(4, {
            kind: "item",
            normalizedIdentity: `item:${kmHash(quoted)}`,
            codeHash: kmHash(quoted),
            canonicalRaw: quoted.raw,
            localVerdict: "duplicate",
          }),
        ],
      },
    },
  ];
}

export function buildInventoryFixtures(): InventoryFixtures {
  return {
    classify: scenarios().map((scenario) => {
      const expected = classify(scenario);
      const rowsByHash = new Map(scenario.rows.map((item) => [item.codeHash, item]));
      return {
        name: scenario.name,
        taskGtin14: GTIN,
        rows: scenario.rows,
        claims: scenario.claims ?? [],
        raw: scenario.raw,
        expected,
        sourceDate: resolveInventoryScanSourceDate(expected, {
          findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
          findSnapshotChildren: (parentSscc) =>
            scenario.rows.filter((item) => item.parentSscc === parentSscc),
        }),
      };
    }),
    batchDigest: batchPayloads().map(({ name, payload }) => ({
      name,
      payload,
      digest: inventoryEventBatchDigest(payload),
    })),
  };
}
