import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import type { DateBound } from "../../lib/date-range";

/** `^YYYY-MM-DD$`; must be checked against the RAW query string, not the coerced `Date` -- see `date-range.ts`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateBoundSchema = z.string().transform((raw, ctx) => {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
    return z.NEVER;
  }
  return { date, dateOnly: DATE_ONLY_RE.test(raw) } satisfies DateBound;
});

/** `GET /code-search?q=` query. `q` is bounded at 1024 bytes, matching a KM's own `MAX_KM_UTF8_BYTES` ceiling (see `canonicalizeKm`) -- anything longer is unrecognized input, not a DB lookup worth attempting. */
export const classifyQuerySchema = z.object({
  q: z.string().trim().min(1).max(1024),
});
export type ClassifyQueryDto = z.infer<typeof classifyQuerySchema>;

/** One box matched by a partial-SSCC search, enough for a disambiguation list. */
export interface ClassifyBoxMatchDto {
  boxId: string;
  /** 20-значный код с GS1 AI "00", как везде в кабинете. */
  sscc: string;
  productName: string | null;
  closedAt: Date | null;
}

/**
 * `GET /code-search` response: which entity the input resolved to. `boxes`
 * is the partial-SSCC case only, and only when MORE than one box matches --
 * a single match collapses to the plain `box` variant so existing callers'
 * happy path is unchanged.
 */
export type ClassifySearchResponseDto =
  | { type: "box"; boxId: string }
  | { type: "code"; codeHash: string }
  | { type: "boxes"; items: ClassifyBoxMatchDto[] };

/** 404 body shape for `/code-search`: distinguishes "not a recognized SSCC/KM shape at all" from "well-formed, but nothing in this tenant matches". */
export interface ClassifyNotFoundDto {
  code: "unrecognized" | "not_found";
}

/**
 * Civil-day bound for the production-date filter: the shift's
 * `coalesce(production_date, planned_date)` is a plain `date`, so both
 * bounds stay date-only strings compared inclusively -- no `upperBoundCondition`
 * next-day dance needed.
 */
const civilDateSchema = z.string().regex(DATE_ONLY_RE, "must be YYYY-MM-DD");

export const listCodesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  from: z.coerce.date().optional(),
  to: dateBoundSchema.optional(),
  productionFrom: civilDateSchema.optional(),
  productionTo: civilDateSchema.optional(),
  productId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  status: z.enum(["free", "aggregated", "written_off"]).optional(),
});
export type ListCodesQueryDto = z.infer<typeof listCodesQuerySchema>;

export type CodeStatus = "free" | "aggregated" | "written_off";

/**
 * One `code_registry` row (the owner scan of a code), joined to its
 * `codes` detail row, `products` (nullable -- a scanned GTIN need not be a
 * registered product), and its current box (nullable -- a code need not be
 * in an active box).
 */
export interface CodeListItemDto {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: CodeStatus;
  scannedAt: Date;
  /** The owner shift's effective production day (`coalesce(production_date, planned_date)`), `YYYY-MM-DD`. */
  productionDate: string | null;
  boxId: string | null;
  /** 20-значный код с GS1 AI "00" (Chestny ZNAK); в БД хранится голый 18-значный SSCC. */
  boxSscc: string | null;
}

export interface ListCodesResponseDto {
  items: CodeListItemDto[];
  page: number;
  pageCount: number;
  total: number;
}

/** `codeHash` path param for `GET /code-search/codes/:codeHash`. */
export const codeHashParamSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A code's full movement history, assembled from several small queries and
 * merged/sorted ascending by `at` -- see `CodeSearchService.getCodeCard`.
 */
export type CodeHistoryEvent =
  | {
      type: "scanned";
      at: Date;
      verdict: string;
      shiftId: string;
      terminalId: string | null;
      operatorId: string | null;
    }
  | { type: "box_added"; at: Date; boxId: string; boxSscc: string | null }
  | { type: "box_displaced"; at: Date; boxId: string; boxSscc: string | null }
  | { type: "box_removed"; at: Date; boxId: string; boxSscc: string | null }
  | {
      type: "box_disassembled";
      at: Date;
      boxId: string;
      boxSscc: string | null;
      reason: string | null;
      disaggregationDocumentId: string | null;
      disaggregationDocNo: string | null;
    }
  | { type: "pickup_locked"; at: Date; orderId: string; orderNo: string }
  | {
      type: "pickup_resolved";
      at: Date;
      orderId: string;
      orderNo: string;
      orderStatus: "punched" | "writtenoff" | "cancelled";
    };

export interface CodeCardDto {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: CodeStatus;
  /** The owner shift's effective production day (`coalesce(production_date, planned_date)`), `YYYY-MM-DD`. */
  productionDate: string | null;
  currentBox: { id: string; sscc: string | null } | null;
  /** Ascending by `at`. */
  history: CodeHistoryEvent[];
}

export interface BoxCardItemDto {
  codeHash: string;
  gtin14: string | null;
  serial: string | null;
  /**
   * The FULL stored wire form (`codes.canonical_raw`) including the
   * GS-separated crypto tail -- the box card must show the code exactly as
   * printed, not just the `01…21…` identity prefix.
   */
  rawKm: string | null;
  addedAt: Date;
  displacedAt: Date | null;
  removedAt: Date | null;
}

export interface BoxCardDto {
  id: string;
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  shiftId: string;
  productId: string | null;
  productName: string | null;
  terminalId: string | null;
  operatorId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  disassembledAt: Date | null;
  items: BoxCardItemDto[];
  exceptions: {
    kind: string;
    reason: string | null;
    occurredAt: Date;
    operatorId: string | null;
    disaggregationDocumentId: string | null;
    disaggregationDocNo: string | null;
  }[];
  pickupOrders: { orderId: string; orderNo: string; status: string }[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const codeHashSchema = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
/** 20-digit GS1 AI "00" form (Chestny ZNAK), as everywhere in the cabinet. */
const ssccSchema = { type: "string", pattern: "^[0-9]{20}$" } as const;
const codeStatusSchema: SchemaObject = {
  type: "string",
  enum: ["free", "aggregated", "written_off"],
};
const productionDateSchema = {
  type: "string",
  format: "date",
  nullable: true,
  description:
    "The owner shift's effective production day (coalesce(production_date, planned_date)).",
} as const;

const classifyBoxMatchOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["boxId", "sscc", "productName", "closedAt"],
  properties: {
    boxId: uuidSchema,
    sscc: ssccSchema,
    productName: { type: "string", nullable: true },
    closedAt: { ...dateTimeSchema, nullable: true },
  },
};

export const classifySearchResponseOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "boxId"],
      properties: { type: { type: "string", enum: ["box"] }, boxId: uuidSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "codeHash"],
      properties: { type: { type: "string", enum: ["code"] }, codeHash: codeHashSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "items"],
      properties: {
        type: { type: "string", enum: ["boxes"] },
        items: {
          type: "array",
          maxItems: 20,
          items: classifyBoxMatchOpenApiSchema,
          description: "Disambiguation list; returned only when more than one box matches.",
        },
      },
    },
  ],
  discriminator: { propertyName: "type" },
};

export const classifyNotFoundOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: {
      type: "string",
      enum: ["unrecognized", "not_found"],
      description:
        "unrecognized: the input is neither an SSCC nor a KM shape; not_found: well-formed, but nothing in this tenant matches.",
    },
  },
};

const codeListItemOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "codeHash",
    "gtin14",
    "serial",
    "productId",
    "productName",
    "status",
    "scannedAt",
    "productionDate",
    "boxId",
    "boxSscc",
  ],
  properties: {
    codeHash: codeHashSchema,
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    serial: { type: "string" },
    productId: { ...uuidSchema, nullable: true },
    productName: { type: "string", nullable: true },
    status: codeStatusSchema,
    scannedAt: dateTimeSchema,
    productionDate: productionDateSchema,
    boxId: { ...uuidSchema, nullable: true },
    boxSscc: { ...ssccSchema, nullable: true },
  },
};

export const listCodesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "page", "pageCount", "total"],
  properties: {
    items: { type: "array", items: codeListItemOpenApiSchema },
    page: { type: "integer", minimum: 1 },
    pageCount: { type: "integer", minimum: 1 },
    total: { type: "integer", minimum: 0 },
  },
};

function boxHistoryEventBranch(type: "box_added" | "box_displaced" | "box_removed"): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "at", "boxId", "boxSscc"],
    properties: {
      type: { type: "string", enum: [type] },
      at: dateTimeSchema,
      boxId: uuidSchema,
      boxSscc: { ...ssccSchema, nullable: true },
    },
  };
}

const codeHistoryEventOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "at", "verdict", "shiftId", "terminalId", "operatorId"],
      properties: {
        type: { type: "string", enum: ["scanned"] },
        at: dateTimeSchema,
        verdict: { type: "string" },
        shiftId: uuidSchema,
        terminalId: { ...uuidSchema, nullable: true },
        operatorId: { ...uuidSchema, nullable: true },
      },
    },
    boxHistoryEventBranch("box_added"),
    boxHistoryEventBranch("box_displaced"),
    boxHistoryEventBranch("box_removed"),
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "at",
        "boxId",
        "boxSscc",
        "reason",
        "disaggregationDocumentId",
        "disaggregationDocNo",
      ],
      properties: {
        type: { type: "string", enum: ["box_disassembled"] },
        at: dateTimeSchema,
        boxId: uuidSchema,
        boxSscc: { ...ssccSchema, nullable: true },
        reason: { type: "string", nullable: true },
        disaggregationDocumentId: { ...uuidSchema, nullable: true },
        disaggregationDocNo: { type: "string", nullable: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "at", "orderId", "orderNo"],
      properties: {
        type: { type: "string", enum: ["pickup_locked"] },
        at: dateTimeSchema,
        orderId: uuidSchema,
        orderNo: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "at", "orderId", "orderNo", "orderStatus"],
      properties: {
        type: { type: "string", enum: ["pickup_resolved"] },
        at: dateTimeSchema,
        orderId: uuidSchema,
        orderNo: { type: "string" },
        orderStatus: { type: "string", enum: ["punched", "writtenoff", "cancelled"] },
      },
    },
  ],
  discriminator: { propertyName: "type" },
};

export const codeCardOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "codeHash",
    "gtin14",
    "serial",
    "productId",
    "productName",
    "status",
    "productionDate",
    "currentBox",
    "history",
  ],
  properties: {
    codeHash: codeHashSchema,
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    serial: { type: "string" },
    productId: { ...uuidSchema, nullable: true },
    productName: { type: "string", nullable: true },
    status: codeStatusSchema,
    productionDate: productionDateSchema,
    currentBox: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "sscc"],
      properties: { id: uuidSchema, sscc: { ...ssccSchema, nullable: true } },
    },
    history: {
      type: "array",
      items: codeHistoryEventOpenApiSchema,
      description: "Ascending by `at`.",
    },
  },
};

const boxCardItemOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["codeHash", "gtin14", "serial", "rawKm", "addedAt", "displacedAt", "removedAt"],
  properties: {
    codeHash: codeHashSchema,
    gtin14: { type: "string", pattern: "^[0-9]{14}$", nullable: true },
    serial: { type: "string", nullable: true },
    rawKm: {
      type: "string",
      nullable: true,
      description: "The FULL stored wire form, including the GS-separated crypto tail.",
    },
    addedAt: dateTimeSchema,
    displacedAt: { ...dateTimeSchema, nullable: true },
    removedAt: { ...dateTimeSchema, nullable: true },
  },
};

export const boxCardOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sscc",
    "status",
    "shiftId",
    "productId",
    "productName",
    "terminalId",
    "operatorId",
    "openedAt",
    "closedAt",
    "disassembledAt",
    "items",
    "exceptions",
    "pickupOrders",
  ],
  properties: {
    id: uuidSchema,
    sscc: { ...ssccSchema, nullable: true },
    status: { type: "string", enum: ["open", "closed", "disassembled"] },
    shiftId: uuidSchema,
    productId: { ...uuidSchema, nullable: true },
    productName: { type: "string", nullable: true },
    terminalId: { ...uuidSchema, nullable: true },
    operatorId: { ...uuidSchema, nullable: true },
    openedAt: dateTimeSchema,
    closedAt: { ...dateTimeSchema, nullable: true },
    disassembledAt: { ...dateTimeSchema, nullable: true },
    items: { type: "array", items: boxCardItemOpenApiSchema },
    exceptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "reason",
          "occurredAt",
          "operatorId",
          "disaggregationDocumentId",
          "disaggregationDocNo",
        ],
        properties: {
          kind: { type: "string" },
          reason: { type: "string", nullable: true },
          occurredAt: dateTimeSchema,
          operatorId: { ...uuidSchema, nullable: true },
          disaggregationDocumentId: { ...uuidSchema, nullable: true },
          disaggregationDocNo: { type: "string", nullable: true },
        },
      },
    },
    pickupOrders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["orderId", "orderNo", "status"],
        properties: {
          orderId: uuidSchema,
          orderNo: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
};
