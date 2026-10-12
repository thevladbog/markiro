import { describe, expect, it } from "vitest";
import { canonicalExportDigest } from "@markiro/domain";
import {
  correctedCaseDemoAuditIdentity,
  correctedCaseDemoCommandDigest,
  datasetCorrectedCasesError,
  parseUsDatasetCorrectedCasesResult,
  usDatasetCorrectedCasesRecordIds,
} from "../src/modules/traceability/demo/us-dataset-corrected-cases-result";
import { parseUsDatasetCasesInput } from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { caseCommandDigest } from "../src/modules/traceability/cases/us-case-operations";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
} from "../src/modules/traceability/demo/us-six-month-definition";

const uuid = (n: number) => `abcdefab-1234-4234-8234-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-09T12:00:00.000Z";
function at<T>(rows: readonly T[], index = 0): T {
  const row = rows[index];
  if (row === undefined) throw new Error("Missing corrected Cases fixture row");
  return row;
}
function fixture() {
  const input = {
    codec: "us-dataset-corrected-cases-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    references: {
      datasetId: uuid(1),
      unitKey: "references",
      stage: "references",
      revision: 2,
      operationKey: uuid(2),
      inputDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
    },
    amendment: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "amend_receiving",
      revision: 2,
      operationKey: uuid(3),
      inputDigest: "c".repeat(64),
      resultDigest: "d".repeat(64),
    },
    receivingOrigin: {
      rootId: uuid(90),
      eventId: uuid(91),
      revision: 2,
      lifecycleVersion: 4,
      inputLots: [
        { lineNo: 1, lotId: uuid(40) },
        { lineNo: 2, lotId: uuid(41) },
      ],
    },
    transformation: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "transformation",
      revision: 2,
      operationKey: uuid(70),
      inputDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
    },
    transformationOrigin: { rootId: uuid(60), eventId: uuid(60), revision: 1, lifecycleVersion: 2 },
    outputLotId: uuid(61),
    outputProductId: uuid(51),
    support: {
      capturedAt: stamp,
      shiftId: uuid(100),
      numberMonthKey: "OCT26",
      numberSeq: 261,
      boxes: makeUsSixMonthSpecialExamples().correction.correctedChain.cases.map((sscc, index) => ({
        id: uuid(101 + index),
        deviceBoxId: `corrected-case-${index + 1}`,
        sscc,
      })),
    },
  };
  const operationKey = uuid(80);
  return {
    input,
    operationKey,
    requestId: `dataset-cases:${operationKey}`,
    support: {
      shift: {
        id: input.support.shiftId,
        productId: input.outputProductId,
        status: "planned",
        mode: "aggregation",
        numberMonthKey: "OCT26",
        numberSeq: 261,
        createdAt: stamp,
      },
      boxes: input.support.boxes.map((box) => ({
        ...box,
        shiftId: input.support.shiftId,
        openedAt: stamp,
      })),
      markers: input.support.boxes.map((box) => ({
        boxId: box.id,
        seedId: input.references.datasetId,
        seedVersion: 1,
        createdAt: stamp,
      })),
    },
    linked: {
      lotId: input.outputLotId,
      unchanged: [],
      created: input.support.boxes.map((box, index) => ({
        linkId: uuid(201 + index),
        boxId: box.id,
        lotId: input.outputLotId,
        ssccAtLink: box.sscc,
        linkSource: "demo_seed",
        provenance: "synthetic_demo",
        originState: "current",
        ssccState: "consistent",
        linkedAt: stamp,
        linkedBy: "synthetic-owner",
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      })),
    },
  };
}

describe("corrected Cases result contract", () => {
  // Break caught: empty/incorrect corrected result or missing support-to-link bindings.
  it("returns all sixty corrected links bound to exact captured support", () => {
    const raw = fixture();
    const parsed = parseUsDatasetCorrectedCasesResult(raw);
    expect(parsed.linked.created).toHaveLength(60);
    expect(parsed).toEqual(raw);
    expect(parsed.linked.created[0]).toMatchObject({
      boxId: uuid(101),
      linkId: uuid(201),
      lotId: uuid(61),
      ssccAtLink: "999999990000156413",
    });
    expect(parsed.linked.created[59]).toMatchObject({
      boxId: uuid(160),
      linkId: uuid(260),
      ssccAtLink: "999999990000157007",
    });
    expect(parsed.support.shift.numberSeq).toBe(261);
    expect(usDatasetCorrectedCasesRecordIds(parsed)).toEqual([
      uuid(100),
      ...Array.from({ length: 60 }, (_, i) => uuid(101 + i)),
      ...Array.from({ length: 60 }, (_, i) => uuid(201 + i)),
    ]);
    expect(() => parseUsDatasetCasesInput(parsed.input)).toThrow("us_dataset_cases_input_invalid");
  });

  // Break caught: returning caller-owned/frozen input or shallow-only evidence copies.
  it("returns a deep frozen owned copy without freezing or retaining caller evidence", () => {
    const raw = fixture();
    const parsed = parseUsDatasetCorrectedCasesResult(raw);
    for (const value of [
      parsed,
      parsed.input,
      parsed.input.references,
      parsed.input.support,
      parsed.input.support.boxes,
      parsed.input.support.boxes[0],
      parsed.support,
      parsed.support.shift,
      parsed.support.boxes,
      parsed.support.boxes[0],
      parsed.support.markers[0],
      parsed.linked,
      parsed.linked.created[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.input.support.boxes[0])).toBe(false);
    at(raw.linked.created).linkedBy = "caller-mutated";
    at(raw.support.boxes).deviceBoxId = "caller-mutated";
    expect(parsed.linked.created[0]?.linkedBy).toBe("synthetic-owner");
    expect(parsed.support.boxes[0]?.deviceBoxId).toBe("corrected-case-1");
    expect(Object.isFrozen(usDatasetCorrectedCasesRecordIds(parsed))).toBe(true);
  });

  // Break caught: weakened strict/coherent evidence boundary or normalization of stored facts.
  it.each([
    "top extra",
    "support extra",
    "shift extra",
    "box extra",
    "marker extra",
    "link extra",
    "input extra",
    "wrong codec",
    "wrong sequence",
    "shift id",
    "shift product",
    "shift month",
    "shift status",
    "shift mode",
    "box count",
    "marker count",
    "box id",
    "box shift",
    "box device",
    "box sscc",
    "box order",
    "marker box",
    "marker seed",
    "marker version",
    "marker order",
    "lot id",
    "link count",
    "unchanged link",
    "link duplicate",
    "link order",
    "link box",
    "link lot",
    "link sscc",
    "manual source",
    "physical provenance",
    "origin gap",
    "sscc drift",
    "unlink time",
    "unlink actor",
    "unlink reason",
    "actor drift",
    "actor blank",
    "actor normalization",
    "request blank",
    "request normalization",
    "uuid uppercase",
    "link uuid uppercase",
    "noncanonical time",
    "impossible time",
    "opened time",
    "marker time",
  ])("rejects %s with a fixed corrected result error", (kind) => {
    const raw = fixture(),
      box = at(raw.support.boxes),
      marker = at(raw.support.markers),
      link = at(raw.linked.created);
    switch (kind) {
      case "top extra":
        Object.assign(raw, { extra: true });
        break;
      case "support extra":
        Object.assign(raw.support, { extra: true });
        break;
      case "shift extra":
        Object.assign(raw.support.shift, { extra: true });
        break;
      case "box extra":
        Object.assign(box, { extra: true });
        break;
      case "marker extra":
        Object.assign(marker, { extra: true });
        break;
      case "link extra":
        Object.assign(link, { extra: true });
        break;
      case "input extra":
        Object.assign(raw.input, { extra: true });
        break;
      case "wrong codec":
        raw.input.codec = "us-dataset-cases-v1";
        break;
      case "wrong sequence":
        raw.input.support.numberSeq = 260;
        break;
      case "shift id":
        raw.support.shift.id = uuid(999);
        break;
      case "shift product":
        raw.support.shift.productId = uuid(999);
        break;
      case "shift month":
        raw.support.shift.numberMonthKey = "JUN26";
        break;
      case "shift status":
        raw.support.shift.status = "open";
        break;
      case "shift mode":
        raw.support.shift.mode = "production";
        break;
      case "box count":
        raw.support.boxes.pop();
        break;
      case "marker count":
        raw.support.markers.pop();
        break;
      case "box id":
        box.id = uuid(999);
        break;
      case "box shift":
        box.shiftId = uuid(999);
        break;
      case "box device":
        box.deviceBoxId = "wrong";
        break;
      case "box sscc":
        box.sscc = at(raw.support.boxes, 1).sscc;
        break;
      case "box order":
        raw.support.boxes.reverse();
        break;
      case "marker box":
        marker.boxId = uuid(999);
        break;
      case "marker seed":
        marker.seedId = uuid(999);
        break;
      case "marker version":
        marker.seedVersion = 2;
        break;
      case "marker order":
        raw.support.markers.reverse();
        break;
      case "lot id":
        raw.linked.lotId = uuid(999);
        break;
      case "link count":
        raw.linked.created.pop();
        break;
      case "unchanged link":
        Object.assign(raw.linked, { unchanged: [structuredClone(link)] });
        break;
      case "link duplicate":
        link.linkId = at(raw.linked.created, 1).linkId;
        break;
      case "link order":
        raw.linked.created.reverse();
        break;
      case "link box":
        link.boxId = uuid(999);
        break;
      case "link lot":
        link.lotId = uuid(999);
        break;
      case "link sscc":
        link.ssccAtLink = at(raw.linked.created, 1).ssccAtLink;
        break;
      case "manual source":
        link.linkSource = "manual";
        break;
      case "physical provenance":
        link.provenance = "existing_record";
        break;
      case "origin gap":
        link.originState = "gap";
        break;
      case "sscc drift":
        link.ssccState = "inconsistent";
        break;
      case "unlink time":
        Object.assign(link, { unlinkedAt: stamp });
        break;
      case "unlink actor":
        Object.assign(link, { unlinkedBy: "synthetic-owner" });
        break;
      case "unlink reason":
        Object.assign(link, { unlinkReason: "correction" });
        break;
      case "actor drift":
        link.linkedBy = "another-owner";
        break;
      case "actor blank":
        link.linkedBy = "";
        break;
      case "actor normalization":
        raw.linked.created.forEach((row) => {
          row.linkedBy = " synthetic-owner ";
        });
        break;
      case "request blank":
        raw.requestId = "";
        break;
      case "request normalization":
        raw.requestId = " request ";
        break;
      case "uuid uppercase":
        raw.operationKey = raw.operationKey.toUpperCase();
        break;
      case "link uuid uppercase":
        link.linkId = link.linkId.toUpperCase();
        break;
      case "noncanonical time":
        link.linkedAt = "2026-10-09T12:00:00Z";
        break;
      case "impossible time":
        link.linkedAt = "2026-02-30T12:00:00.000Z";
        break;
      case "opened time":
        box.openedAt = "2026-10-09T12:00:00Z";
        break;
      case "marker time":
        marker.createdAt = "2026-10-09T12:00:00Z";
        break;
    }
    expect(() => parseUsDatasetCorrectedCasesResult(raw)).toThrow(
      "us_dataset_corrected_cases_result_invalid",
    );
    try {
      parseUsDatasetCorrectedCasesResult(raw);
    } catch (error) {
      expect(error).toMatchObject({
        unitKey: "correction_0001",
        stage: "cases",
        cause: expect.anything(),
      });
    }
  });

  // Break caught: only link IDs unique, while aliases to support/prerequisite ownership pass.
  it.each([
    "shift",
    "box",
    "dataset",
    "receiving root",
    "receiving event",
    "input lot",
    "transformation origin",
    "output lot",
    "product",
  ])("rejects an owned link aliasing %s", (kind) => {
    const raw = fixture();
    const aliases: Record<string, string> = {
      shift: raw.input.support.shiftId,
      box: at(raw.input.support.boxes).id,
      dataset: raw.input.references.datasetId,
      "references operation": raw.input.references.operationKey,
      "amendment operation": raw.input.amendment.operationKey,
      "transformation operation": raw.input.transformation.operationKey,
      "receiving root": raw.input.receivingOrigin.rootId,
      "receiving event": raw.input.receivingOrigin.eventId,
      "input lot": at(raw.input.receivingOrigin.inputLots).lotId,
      "transformation origin": raw.input.transformationOrigin.rootId,
      "output lot": raw.input.outputLotId,
      product: raw.input.outputProductId,
      "cases operation": raw.operationKey,
    };
    at(raw.linked.created).linkId = aliases[kind] ?? "invalid";
    expect(() => parseUsDatasetCorrectedCasesResult(raw)).toThrow(
      "us_dataset_corrected_cases_result_invalid",
    );
  });

  // Operation keys belong to a separate namespace and are not business-record ownership.
  it.each(["shift", "box", "link"])(
    "accepts coherent %s identity also used as a prerequisite operation key",
    (kind) => {
      const raw = fixture(),
        alias = raw.input.references.operationKey;
      if (kind === "shift") {
        raw.input.support.shiftId = alias;
        raw.support.shift.id = alias;
        raw.support.boxes.forEach((row) => {
          row.shiftId = alias;
        });
      } else if (kind === "box") {
        at(raw.input.support.boxes).id = alias;
        at(raw.support.boxes).id = alias;
        at(raw.support.markers).boxId = alias;
        at(raw.linked.created).boxId = alias;
      } else {
        at(raw.linked.created).linkId = alias;
      }
      const parsed = parseUsDatasetCorrectedCasesResult(raw);
      expect(parsed.linked.created).toHaveLength(60);
      expect(usDatasetCorrectedCasesRecordIds(parsed)).toContain(alias);
    },
  );

  // Break caught: accessing caller getters/iterators before the bounded descriptor walk.
  it.each([
    "getter",
    "array getter",
    "array prototype",
    "object prototype",
    "symbol",
    "cycle",
    "nonfinite",
    "oversize",
    "depth",
  ])("rejects unsafe %s without invoking accessors", (kind) => {
    const raw = fixture();
    let calls = 0;
    if (kind === "getter")
      Object.defineProperty(raw, "input", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("getter invoked");
        },
      });
    if (kind === "array getter")
      Object.defineProperty(raw.linked.created, "0", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("getter invoked");
        },
      });
    if (kind === "array prototype")
      Object.setPrototypeOf(raw.linked.created, {
        [Symbol.iterator]() {
          calls++;
          throw new Error("iterator invoked");
        },
      });
    if (kind === "object prototype") Object.setPrototypeOf(raw.support, { inherited: true });
    if (kind === "symbol") Object.assign(raw, { [Symbol("hidden")]: true });
    if (kind === "cycle") Object.assign(raw, { cycle: raw });
    if (kind === "nonfinite") Object.assign(raw, { value: Infinity });
    if (kind === "oversize") Object.assign(raw, { value: "x".repeat(256 * 1024) });
    if (kind === "depth") {
      let nested: unknown = null;
      for (let i = 0; i < 100; i++) nested = { nested };
      Object.assign(raw, { nested });
    }
    expect(() => parseUsDatasetCorrectedCasesResult(raw)).toThrow(
      "us_dataset_corrected_cases_result_invalid",
    );
    expect(calls).toBe(0);
  });

  // Break caught: corrected commands replaying manual operations or losing recipe/input identity.
  it("binds native command version/source/lot/sorted SSCCs to corrected audit identity", () => {
    const parsed = parseUsDatasetCorrectedCasesResult(fixture());
    const identity = correctedCaseDemoAuditIdentity(parsed.input);
    expect(identity).toEqual({
      datasetId: uuid(1),
      recipeVersion: "us-processor-six-month-v1",
      recipeDigest: usSixMonthDefinition.digest,
      unitKey: "correction_0001",
      intentDigest: canonicalExportDigest(parsed.input),
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(correctedCaseDemoCommandDigest(parsed.input)).toBe(
      canonicalExportDigest({
        commandVersion: 2,
        command: "case.link",
        source: "demo_seed",
        lotId: uuid(61),
        input: { ssccs: parsed.input.support.boxes.map(({ sscc }) => sscc).sort() },
        seed: identity,
      }),
    );
    expect(correctedCaseDemoCommandDigest(parsed.input)).not.toBe(
      caseCommandDigest("case.link", parsed.input.outputLotId, {
        ssccs: parsed.input.support.boxes.map(({ sscc }) => sscc),
      }),
    );
    const changed = structuredClone(parsed.input);
    const updated = {
      ...changed,
      support: { ...changed.support, capturedAt: "2026-10-10T12:00:00.000Z" },
    };
    expect(correctedCaseDemoCommandDigest(updated)).not.toBe(
      correctedCaseDemoCommandDigest(parsed.input),
    );
  });

  it("preserves original causes in fixed corrected persistence errors", () => {
    const cause = new Error("driver-failure");
    for (const code of [
      "us_dataset_corrected_cases_conflict",
      "us_dataset_corrected_cases_mismatch",
    ] as const) {
      const error = datasetCorrectedCasesError(code, cause);
      expect(error).toMatchObject({ message: code, unitKey: "correction_0001", stage: "cases" });
      expect(error.cause).toBe(cause);
    }
  });
});
