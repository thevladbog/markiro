import { DomainError } from "../errors.js";
import { isTraceabilityCivilDate } from "./civil-date.js";
import {
  validateLocationDescription,
  type LocationDescriptionInput,
} from "./location-description.js";
import { assessCoverageReview, type CoverageReviewRecord } from "./products/coverage.js";
import {
  validateProductDescription,
  type ProductDescriptionInput,
} from "./products/description.js";
import type { TraceabilityCte } from "./profile.js";
import { parseTraceabilityQuantity } from "./quantity.js";
import { isTraceabilityUom } from "./uom.js";

export const FROZEN_READINESS_RULE_VERSION = "us-readiness-v1";
export type ReadinessSourceIdentity =
  | { readonly kind: "location"; readonly locationId: string }
  | {
      readonly kind: "reference";
      readonly referenceKind: string;
      readonly referenceValue: string;
      readonly resolvedLocationId: string | null;
    };
/** Transformation saves a compact description; Receiving/Shipping save detailed ones. */
export type ReadinessLocationDescriptionFact = string | LocationDescriptionInput;
export type ReadinessProductDescriptionFact = string | ProductDescriptionInput;
export interface ReadinessRelatedEventIdentity {
  readonly type: TraceabilityCte;
  readonly eventNumber: string;
  readonly revision: number;
}
interface ReadinessLineCommon {
  readonly id: string;
  readonly lineNo: number;
  readonly side: "items" | "inputs" | "outputs";
  readonly productId: string | null;
  readonly productDescription: ReadinessProductDescriptionFact | null;
  readonly source: ReadinessSourceIdentity | null;
  readonly sourceDescription: ReadinessLocationDescriptionFact | null;
  readonly quantity: string | null;
  readonly unitOfMeasure: string | null;
  /** Saved review at finalization, never the current product master. */
  readonly coverage: CoverageReviewRecord | null;
  readonly exemptionReview: "not_applicable" | "reviewed" | "pending" | "unknown";
}
export type ReadinessLineFact =
  | (ReadinessLineCommon & {
      readonly kind: "lot";
      readonly lotId: string;
      readonly tlc: string | null;
    })
  | (ReadinessLineCommon & {
      readonly kind: "non_ftl";
      readonly side: "inputs";
      readonly lotId: null;
      readonly reference: string | null;
    });
export interface ReadinessEventFact {
  readonly id: string;
  readonly rootId: string;
  readonly eventNumber: string;
  readonly type: TraceabilityCte;
  readonly revision: number;
  /** Authoritative, valid CTE row date used for selection and finding provenance. */
  readonly eventDate: string;
  /** Independent immutable snapshot date assessed as a business KDE. */
  readonly frozenEventDate: string | null;
  /** Frozen display/location pieces; no mutable location or party record. */
  readonly header: {
    readonly receivingLocation: ReadinessLocationDescriptionFact | null;
    readonly previousSourceLocation: ReadinessLocationDescriptionFact | null;
    readonly processorLocation: ReadinessLocationDescriptionFact | null;
    readonly shipFromLocation: ReadinessLocationDescriptionFact | null;
    readonly recipientLocation: ReadinessLocationDescriptionFact | null;
  };
  readonly documents: readonly { readonly kind: string | null; readonly value: string | null }[];
  readonly lines: readonly ReadinessLineFact[];
}
export interface ReadinessLotFact {
  readonly id: string;
  readonly productId: string | null;
  readonly tlc: string | null;
  readonly source: ReadinessSourceIdentity | null;
  readonly currentOrigin: boolean;
  /** Historical origin revision, when one exists and can be linked. */
  readonly relatedEventId: string | null;
  readonly relatedEvent?: ReadinessRelatedEventIdentity | null;
}
export interface ReadinessDependencyFact {
  readonly consumingEventId: string;
  readonly consumingLineId: string;
  readonly lotId: string;
  readonly currentOrigin: boolean;
  /** Frozen identity on the verified current origin; null when origin is missing. */
  readonly tlc: string | null;
  readonly productId: string | null;
  readonly source: ReadinessSourceIdentity | null;
  readonly relatedEventId: string | null;
  readonly relatedEvent?: ReadinessRelatedEventIdentity | null;
}
export interface ReadinessRuleInput {
  readonly profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  readonly events: readonly ReadinessEventFact[];
  readonly lots: readonly ReadinessLotFact[];
  readonly dependencies: readonly ReadinessDependencyFact[];
}
export interface ReadinessRuleFinding {
  readonly key: string;
  readonly ruleVersion: typeof FROZEN_READINESS_RULE_VERSION;
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly cte: TraceabilityCte | null;
  readonly field: string;
  readonly message: {
    readonly key: string;
    readonly params: Readonly<Record<string, string | number>>;
  };
  readonly lotId: string | null;
  readonly productId: string | null;
  readonly eventId: string | null;
  readonly rootId: string | null;
  readonly eventNumber: string | null;
  readonly revision: number | null;
  readonly eventDate: string | null;
  readonly lineId: string | null;
  readonly lineSide: "items" | "inputs" | "outputs" | null;
  readonly lineNo: number | null;
  readonly relatedEventId: string | null;
  readonly relatedEvent: ReadinessRelatedEventIdentity | null;
}

function sameSource(a: ReadinessSourceIdentity, b: ReadinessSourceIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "location") return b.kind === "location" && a.locationId === b.locationId;
  return (
    b.kind === "reference" &&
    a.referenceKind === b.referenceKind &&
    a.referenceValue === b.referenceValue &&
    a.resolvedLocationId === b.resolvedLocationId
  );
}

function present(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/** Deterministic assessment of saved facts; the caller verifies storage and current-root integrity. */
export function assessFrozenReadiness(
  input: ReadinessRuleInput,
  options: { readonly maxFindings?: number } = {},
): ReadinessRuleFinding[] {
  const { maxFindings } = options;
  if (maxFindings !== undefined && (!Number.isSafeInteger(maxFindings) || maxFindings < 0))
    throw new DomainError(
      "invalid_readiness_finding_limit",
      "Finding limit must be a nonnegative safe integer.",
    );
  const findings = new Map<string, ReadinessRuleFinding>();
  const lots = new Map(input.lots.map((lot) => [lot.id, lot]));
  const events = new Map(input.events.map((event) => [event.id, event]));
  const lines = new Map(
    input.events.flatMap((event) =>
      event.lines.map((line) => [`${event.id}:${line.id}`, line] as const),
    ),
  );
  const dependencyLines = new Set(
    input.dependencies.map(
      (dependency) => `${dependency.consumingEventId}:${dependency.consumingLineId}`,
    ),
  );
  const dependencyByLine = new Map(
    input.dependencies.map(
      (dependency) =>
        [`${dependency.consumingEventId}:${dependency.consumingLineId}`, dependency] as const,
    ),
  );
  const consumed = new Set<string>();
  const add = (
    code: string,
    field: string,
    lot: ReadinessLotFact | null,
    event: ReadinessEventFact | null,
    line: ReadinessLineFact | null,
    relatedEventId: string | null = null,
    severity: ReadinessRuleFinding["severity"] = "error",
    relatedEvent: ReadinessRelatedEventIdentity | null = null,
  ) => {
    const lotId = line?.lotId ?? lot?.id ?? null;
    const key = [code, event?.id ?? "", line?.id ?? "", lotId ?? "", field].join(":");
    const existing = findings.get(key);
    if (existing?.relatedEventId !== null && existing?.relatedEventId !== undefined) return;
    if (existing === undefined && maxFindings !== undefined && findings.size >= maxFindings)
      throw new DomainError("readiness_finding_limit_exceeded", "Finding limit exceeded.");
    findings.set(key, {
      key,
      ruleVersion: FROZEN_READINESS_RULE_VERSION,
      code,
      severity,
      cte: event?.type ?? null,
      field,
      message: { key: `readiness.${code}`, params: {} },
      lotId,
      productId: line?.productId ?? lot?.productId ?? null,
      eventId: event?.id ?? null,
      rootId: event?.rootId ?? null,
      eventNumber: event?.eventNumber ?? null,
      revision: event?.revision ?? null,
      eventDate: event?.eventDate ?? null,
      lineId: line?.id ?? null,
      lineSide: line?.side ?? null,
      lineNo: line?.lineNo ?? null,
      relatedEventId,
      relatedEvent,
    });
  };
  const checkLocationDescription = (
    description: ReadinessLocationDescriptionFact | null,
    field: string,
    lot: ReadinessLotFact | null,
    event: ReadinessEventFact,
    line: ReadinessLineFact | null,
  ) => {
    if (description === null || (typeof description === "string" && !present(description))) {
      add("required_kde", field, lot, event, line);
      return;
    }
    if (typeof description === "string") return;
    for (const issue of validateLocationDescription(description, "export_ready"))
      add(
        issue.code === "required" ? "required_kde" : "invalid_kde",
        `${field}.${issue.field}`,
        lot,
        event,
        line,
      );
  };
  const checkProductDescription = (
    description: ReadinessProductDescriptionFact | null,
    field: string,
    lot: ReadinessLotFact | null,
    event: ReadinessEventFact,
    line: ReadinessLineFact,
  ) => {
    if (description === null || (typeof description === "string" && !present(description))) {
      add("required_kde", field, lot, event, line);
      return;
    }
    if (typeof description === "string") return;
    for (const issue of validateProductDescription(description))
      add(
        issue.code === "required" ? "required_kde" : "invalid_kde",
        `${field}.${issue.field}`,
        lot,
        event,
        line,
      );
  };

  for (const event of input.events) {
    if (event.frozenEventDate === null) add("required_kde", "frozenEventDate", null, event, null);
    else if (!isTraceabilityCivilDate(event.frozenEventDate))
      add("invalid_date", "frozenEventDate", null, event, null);
    const requiredHeader =
      event.type === "receiving"
        ? (["receivingLocation", "previousSourceLocation"] as const)
        : event.type === "transformation"
          ? (["processorLocation"] as const)
          : (["shipFromLocation", "recipientLocation"] as const);
    for (const field of requiredHeader)
      checkLocationDescription(event.header[field], `header.${field}`, null, event, null);
    if (!event.documents.length)
      add(
        "required_reference",
        "documents",
        null,
        event,
        null,
        null,
        event.type === "receiving" && input.profileCode === "US_GENERIC_LOT_TRACEABILITY"
          ? "warning"
          : "error",
      );
    event.documents.forEach((document, index) => {
      if (!present(document.kind))
        add("required_reference", `documents[${index}].kind`, null, event, null);
      if (!present(document.value))
        add("required_reference", `documents[${index}].value`, null, event, null);
    });
    for (const line of event.lines) {
      const lot = line.kind === "lot" ? (lots.get(line.lotId) ?? null) : null;
      if (line.kind === "lot") consumed.add(line.lotId);
      const path = `lines.${line.side}[${line.lineNo}]`;
      if (!present(line.productId)) add("required_kde", `${path}.productId`, lot, event, line);
      checkProductDescription(
        line.productDescription,
        `${path}.productDescription`,
        lot,
        event,
        line,
      );
      if (line.source === null) add("required_kde", `${path}.source`, lot, event, line);
      else if (line.source.kind === "reference" && line.source.resolvedLocationId === null)
        add("source_unresolved", `${path}.source`, lot, event, line);
      checkLocationDescription(
        line.sourceDescription,
        `${path}.sourceDescription`,
        lot,
        event,
        line,
      );
      if (line.quantity === null) add("required_kde", `${path}.quantity`, lot, event, line);
      else {
        try {
          if (parseTraceabilityQuantity(line.quantity) !== line.quantity)
            add("invalid_quantity", `${path}.quantity`, lot, event, line);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          add("invalid_quantity", `${path}.quantity`, lot, event, line);
        }
      }
      if (line.unitOfMeasure === null)
        add("required_kde", `${path}.unitOfMeasure`, lot, event, line);
      else if (!isTraceabilityUom(line.unitOfMeasure))
        add("invalid_uom", `${path}.unitOfMeasure`, lot, event, line);
      if (line.kind === "non_ftl") {
        if (!present(line.reference))
          add("required_reference", `${path}.reference`, null, event, line);
      } else {
        if (!present(line.tlc)) add("required_kde", `${path}.tlc`, lot, event, line);
        if (lot === null) add("event_lot_mismatch", `${path}.lotId`, null, event, line);
      }
      if (line.kind === "lot" && lot !== null) {
        if (line.productId !== null && line.productId !== lot.productId)
          add("event_lot_mismatch", `${path}.productId`, lot, event, line);
        if (line.tlc !== null && line.tlc !== lot.tlc)
          add("tlc_source_mismatch", `${path}.tlc`, lot, event, line);
        if (line.source !== null && lot.source !== null && !sameSource(line.source, lot.source)) {
          const dependency = dependencyByLine.get(`${event.id}:${line.id}`);
          add(
            "tlc_source_mismatch",
            `${path}.source`,
            lot,
            event,
            line,
            dependency?.relatedEventId,
            "error",
            dependency?.relatedEvent ?? null,
          );
        }
        if (line.source !== null && lot.source === null)
          add("source_unresolved", `${path}.source`, lot, event, line);
        if (!lot.currentOrigin && !dependencyLines.has(`${event.id}:${line.id}`))
          add(
            "origin_gap",
            `${path}.origin`,
            lot,
            event,
            line,
            lot.relatedEventId,
            "error",
            lot.relatedEvent ?? null,
          );
      }
      if (input.profileCode === "US_FSMA204_PROCESSOR") {
        if (
          line.coverage === null ||
          assessCoverageReview(line.coverage, input.profileCode).state !== "reviewed"
        )
          add("coverage_unresolved", `${path}.coverage`, lot, event, line);
        if (line.exemptionReview === "pending" || line.exemptionReview === "unknown")
          add("exemption_review_required", `${path}.exemptionReview`, lot, event, line);
      }
    }
  }

  for (const dependency of input.dependencies) {
    const event = events.get(dependency.consumingEventId);
    const line = lines.get(`${dependency.consumingEventId}:${dependency.consumingLineId}`);
    if (!event || !line || line.kind !== "lot") continue;
    const lot = lots.get(dependency.lotId) ?? null;
    consumed.add(dependency.lotId);
    const path = `lines.${line.side}[${line.lineNo}]`;
    if (!dependency.currentOrigin)
      add(
        "origin_gap",
        `${path}.origin`,
        lot,
        event,
        line,
        dependency.relatedEventId,
        "error",
        dependency.relatedEvent ?? null,
      );
    else {
      if (line.tlc !== null && line.tlc !== dependency.tlc)
        add(
          "tlc_source_mismatch",
          `${path}.tlc`,
          lot,
          event,
          line,
          dependency.relatedEventId,
          "error",
          dependency.relatedEvent ?? null,
        );
      if (line.productId !== null && line.productId !== dependency.productId)
        add(
          "event_lot_mismatch",
          `${path}.productId`,
          lot,
          event,
          line,
          dependency.relatedEventId,
          "error",
          dependency.relatedEvent ?? null,
        );
    }
    if (dependency.source === null)
      add(
        "source_unresolved",
        `${path}.source`,
        lot,
        event,
        line,
        dependency.relatedEventId,
        "error",
        dependency.relatedEvent ?? null,
      );
    else if (line.source !== null && !sameSource(line.source, dependency.source))
      add(
        "tlc_source_mismatch",
        `${path}.source`,
        lot,
        event,
        line,
        dependency.relatedEventId,
        "error",
        dependency.relatedEvent ?? null,
      );
  }

  for (const lot of input.lots)
    if (!consumed.has(lot.id)) {
      if (!present(lot.productId)) add("required_kde", "lot.productId", lot, null, null);
      if (!present(lot.tlc)) add("required_kde", "lot.tlc", lot, null, null);
      if (lot.source === null) add("required_kde", "lot.source", lot, null, null);
      else if (lot.source.kind === "reference" && lot.source.resolvedLocationId === null)
        add("source_unresolved", "lot.source", lot, null, null);
      if (!lot.currentOrigin)
        add(
          "origin_gap",
          "currentOrigin",
          lot,
          null,
          null,
          lot.relatedEventId,
          "error",
          lot.relatedEvent ?? null,
        );
    }

  return [...findings.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
}
