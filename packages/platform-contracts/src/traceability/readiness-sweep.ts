import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { usTraceabilityProfileCodeSchema } from "./profile.js";

const eventType = z.enum(["receiving", "transformation", "shipping"]);
const severity = z.enum(["error", "warning", "info"]);
const checkedCount = z.number().int().min(0).max(10000);
const findingCount = z.number().int().min(0).max(10000);
const unboundedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCount = findingCount.min(1);
const relativeTraceabilityLink = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.startsWith("/traceability/") && !value.startsWith("//"));

export type UsProfileCode = z.infer<typeof usTraceabilityProfileCodeSchema>;

/** Raw HTTP query fields; authorization supplies tenant, actor, profile, and tenant civil day. */
export const usReadinessQuerySchema = z
  .object({
    eventDateFrom: traceabilityCivilDateSchema.optional(),
    eventDateTo: traceabilityCivilDateSchema.optional(),
    productId: platformUuidSchema.optional(),
    lotId: platformUuidSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.eventDateFrom === undefined) !== (query.eventDateTo === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["eventDateTo"],
        message: "Both event dates are required together",
      });
      return;
    }
    if (query.eventDateFrom === undefined || query.eventDateTo === undefined) return;
    if (query.eventDateFrom > query.eventDateTo) {
      context.addIssue({
        code: "custom",
        path: ["eventDateTo"],
        message: "Reversed event-date range",
      });
      return;
    }
    const fromYear = Number(query.eventDateFrom.slice(0, 4));
    const fromMonth = Number(query.eventDateFrom.slice(5, 7));
    const toYear = Number(query.eventDateTo.slice(0, 4));
    const toMonth = Number(query.eventDateTo.slice(5, 7));
    if ((toYear - fromYear) * 12 + toMonth - fromMonth > 23)
      context.addIssue({
        code: "custom",
        path: ["eventDateTo"],
        message: "Event-date range exceeds 24 calendar months",
      });
  });
export type UsReadinessQuery = z.infer<typeof usReadinessQuerySchema>;

export const usReadinessScopeSchema = z
  .object({
    eventDateFrom: traceabilityCivilDateSchema,
    eventDateTo: traceabilityCivilDateSchema,
    productId: platformUuidSchema.nullable(),
    lotId: platformUuidSchema.nullable(),
    profileCode: usTraceabilityProfileCodeSchema,
    defaulted: z.boolean(),
  })
  .strict()
  .refine(
    (scope) =>
      usReadinessQuerySchema.safeParse({
        eventDateFrom: scope.eventDateFrom,
        eventDateTo: scope.eventDateTo,
      }).success,
    { path: ["eventDateTo"], message: "Invalid readiness scope dates" },
  );
export type UsReadinessScope = z.infer<typeof usReadinessScopeSchema>;

export const usReadinessFindingSchema = z
  .object({
    key: z.string().min(1).max(512),
    ruleVersion: z.literal("us-readiness-v1"),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
    severity,
    cte: eventType.nullable(),
    field: z.string().min(1).max(256),
    message: z
      .object({
        key: z
          .string()
          .regex(/^[a-z][a-z0-9_.]*$/)
          .max(120),
        params: z.record(z.string().max(80), z.union([z.string().max(500), z.number().finite()])),
      })
      .strict(),
    lotId: platformUuidSchema.nullable(),
    productId: platformUuidSchema.nullable(),
    eventId: platformUuidSchema.nullable(),
    rootId: platformUuidSchema.nullable(),
    eventNumber: z.string().min(1).max(128).nullable(),
    revision: z.number().int().min(1).nullable(),
    eventDate: traceabilityCivilDateSchema.nullable(),
    lineSide: z.enum(["items", "inputs", "outputs"]).nullable(),
    lineNo: z.number().int().min(1).nullable(),
    relatedEventId: platformUuidSchema.nullable(),
    relatedEvent: z
      .object({
        type: eventType,
        eventNumber: z.string().min(1).max(128),
        revision: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    links: z
      .object({
        lotHref: relativeTraceabilityLink.nullable(),
        eventHref: relativeTraceabilityLink.nullable(),
        relatedEventHref: relativeTraceabilityLink.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.code === "origin_gap" && finding.severity !== "error")
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "An origin gap is a blocking error",
      });
    const hasEvent = finding.eventId !== null;
    if ((finding.lotId === null) !== (finding.links.lotHref === null))
      context.addIssue({
        code: "custom",
        path: ["lotId"],
        message: "Lot provenance and link must appear together",
      });
    if (!hasEvent && finding.lotId === null)
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "Finding requires an event or lot source",
      });
    if (
      [
        finding.rootId,
        finding.eventNumber,
        finding.revision,
        finding.eventDate,
        finding.links.eventHref,
        finding.cte,
      ].some((value) => (value !== null) !== hasEvent)
    )
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "Event provenance and link must be complete together",
      });
    if (
      (finding.lineSide === null) !== (finding.lineNo === null) ||
      (!hasEvent && finding.lineSide !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["lineSide"],
        message: "Line provenance must identify an event and position",
      });
    if (
      (finding.relatedEventId === null) !== (finding.links.relatedEventHref === null) ||
      (finding.relatedEventId === null) !== (finding.relatedEvent === null)
    )
      context.addIssue({
        code: "custom",
        path: ["relatedEventId"],
        message: "Related origin identity and link must appear together",
      });
  });
export type UsReadinessFinding = z.infer<typeof usReadinessFindingSchema>;

export const usReadinessDraftRefSchema = z
  .object({
    eventId: platformUuidSchema,
    rootId: platformUuidSchema,
    cte: eventType,
    eventNumber: z.string().min(1).max(128),
    revision: z.number().int().min(1),
    eventDate: traceabilityCivilDateSchema.nullable(),
    eventHref: relativeTraceabilityLink,
    readinessHref: relativeTraceabilityLink,
  })
  .strict();
export type UsReadinessDraftRef = z.infer<typeof usReadinessDraftRefSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left: UsReadinessFinding, right: UsReadinessFinding): number {
  const order = { error: 0, warning: 1, info: 2 };
  return (
    order[left.severity] - order[right.severity] ||
    compareText(left.eventDate ?? "9999-12-31", right.eventDate ?? "9999-12-31") ||
    compareText(
      left.rootId ?? left.eventId ?? left.lotId ?? "",
      right.rootId ?? right.eventId ?? right.lotId ?? "",
    ) ||
    (left.lineNo ?? 0) - (right.lineNo ?? 0) ||
    compareText(left.code, right.code) ||
    compareText(left.key, right.key)
  );
}

const severityCounts = z
  .object({ error: findingCount, warning: findingCount, info: findingCount })
  .strict();
const groups = z
  .object({
    byCte: z.array(z.object({ cte: eventType.nullable(), count: positiveCount }).strict()).max(4),
    byProduct: z
      .array(z.object({ productId: platformUuidSchema.nullable(), count: positiveCount }).strict())
      .max(10000),
    bySeverity: z.array(z.object({ severity, count: positiveCount }).strict()).max(3),
  })
  .strict();

/** Successful response is complete; bounds are refusal limits, never truncation markers. */
export const usReadinessResultSchema = z
  .object({
    scope: usReadinessScopeSchema,
    assessedAt: z.iso.datetime(),
    state: z.enum(["empty", "assessed"]),
    recordsChecked: z.object({ events: checkedCount, lots: checkedCount }).strict(),
    dependenciesChecked: unboundedCount,
    counts: severityCounts,
    groups,
    findings: z.array(usReadinessFindingSchema).max(10000),
    draftWork: z
      .object({
        total: unboundedCount,
        items: z.array(usReadinessDraftRefSchema).max(100),
        hasMore: z.boolean(),
        eventsHref: relativeTraceabilityLink,
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    const checked = result.recordsChecked.events + result.recordsChecked.lots;
    if ((result.state === "empty") !== (checked === 0))
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Empty means no checked event or lot",
      });
    if (
      result.draftWork.total < result.draftWork.items.length ||
      result.draftWork.hasMore !== result.draftWork.total > result.draftWork.items.length
    )
      context.addIssue({
        code: "custom",
        path: ["draftWork"],
        message: "Draft count and continuation must match preview",
      });
    const actual = { error: 0, warning: 0, info: 0 };
    const byCte = new Map<string, number>();
    const byProduct = new Map<string, number>();
    const keys = new Set<string>();
    result.findings.forEach((finding, index) => {
      actual[finding.severity]++;
      const cteKey = finding.cte ?? "";
      const productKey = finding.productId ?? "";
      byCte.set(cteKey, (byCte.get(cteKey) ?? 0) + 1);
      byProduct.set(productKey, (byProduct.get(productKey) ?? 0) + 1);
      if (keys.has(finding.key))
        context.addIssue({
          code: "custom",
          path: ["findings", index, "key"],
          message: "Finding keys must be distinct",
        });
      keys.add(finding.key);
      const previous = result.findings[index - 1];
      if (previous && compareFindings(previous, finding) > 0)
        context.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "Findings must be ordered by severity and source",
        });
    });
    if (severity.options.some((level) => result.counts[level] !== actual[level]))
      context.addIssue({
        code: "custom",
        path: ["counts"],
        message: "Severity counts must match findings",
      });
    const cteGroups = new Map(result.groups.byCte.map((entry) => [entry.cte ?? "", entry.count]));
    if (
      result.groups.byCte.length !== byCte.size ||
      [...byCte].some(([key, count]) => cteGroups.get(key) !== count)
    )
      context.addIssue({
        code: "custom",
        path: ["groups", "byCte"],
        message: "CTE groups must match findings",
      });
    const productGroups = new Map(
      result.groups.byProduct.map((entry) => [entry.productId ?? "", entry.count]),
    );
    if (
      result.groups.byProduct.length !== byProduct.size ||
      [...byProduct].some(([key, count]) => productGroups.get(key) !== count)
    )
      context.addIssue({
        code: "custom",
        path: ["groups", "byProduct"],
        message: "Product groups must match findings",
      });
    const severityGroups = new Map(
      result.groups.bySeverity.map((entry) => [entry.severity, entry.count]),
    );
    if (
      result.groups.bySeverity.length !==
        severity.options.filter((level) => actual[level] > 0).length ||
      severity.options.some((level) => (severityGroups.get(level) ?? 0) !== actual[level])
    )
      context.addIssue({
        code: "custom",
        path: ["groups", "bySeverity"],
        message: "Severity groups must match findings",
      });
  });
export type UsReadinessResult = z.infer<typeof usReadinessResultSchema>;
