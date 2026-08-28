import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import { CHANNELS, type IntegrationChannelType } from "./channel-registry";

export type ChannelState = "not_configured" | "working" | "error" | "silent" | "unavailable";

export interface ChannelSummaryDto {
  type: IntegrationChannelType;
  labelKey: string;
  state: ChannelState;
  lastEventAt: string | null;
}

export interface ChannelDetailDto extends ChannelSummaryDto {
  settings: Record<string, unknown>;
  silentAfterHours: number;
  /** Логин обмена; пароль не отдаётся никогда — он показан один раз при выпуске. */
  credentialLogin: string | null;
}

export interface JournalEventDto {
  at: string;
  direction: string;
  outcome: string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface JournalSessionDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  summary: Record<string, unknown> | null;
  events: JournalEventDto[];
}

export interface JournalPageDto {
  sessions: JournalSessionDto[];
}

/** Выпускается ровно один раз при `POST /integrations/:type/credentials`; в базе живёт только хэш секрета. */
export interface CredentialsIssuedDto {
  login: string;
  secret: string;
}

export const updateChannelSchema = z.record(z.string(), z.unknown());
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;

/**
 * Bounds for `silentAfterHours` (brief 08: the silence threshold is a
 * per-channel setting -- "у одного тенанта обмен раз в час, у другого раз в
 * сутки, и общая константа соврёт обоим"). It is a whole number of hours
 * because that's the column's own unit (`silent_after_hours` integer, see
 * packages/db/src/schema/integrations.ts) and the granularity `stateOf` in
 * integrations.service.ts actually compares against.
 *
 * Lower bound is 1, not 0: a zero-hour threshold would make the channel read
 * as "silent" from the instant its very first event lands (nothing can ever
 * be *less* than zero hours old), so the state could never mean anything
 * else -- it's not a stricter setting, it's a permanently tripped one.
 *
 * Upper bound is 720 (24 * 30 -- thirty days): generous enough to cover every
 * exchange cadence the brief names (hourly, daily) with a wide safety
 * margin, but still low enough that a channel that has genuinely gone quiet
 * surfaces that within a month instead of never. An unbounded-in-practice
 * threshold is the mirror image of the zero-hour case: "silent" would exist
 * as a state but be unreachable, which is just as useless as it always
 * being true.
 */
export const SILENT_AFTER_HOURS_MIN = 1;
export const SILENT_AFTER_HOURS_MAX = 24 * 30;

export const silentAfterHoursSchema = z
  .number()
  .int()
  .min(SILENT_AFTER_HOURS_MIN)
  .max(SILENT_AFTER_HOURS_MAX);

/** Позиция внешней системы, ещё не сопоставленная с каталогом (Task 9's queue). */
export interface CandidateDto {
  id: string;
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  gtin: string | null;
  price: string | null;
  priceType: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  hidden: boolean;
  /**
   * Только при единственном совпадении по нормализованному ИМЕНИ среди ещё
   * не связанных товаров -- см. `suggestProductId` в
   * `integrations.service.ts`. Артикул кандидата в сравнении не участвует: у
   * `products` нет собственного поля артикула, сравнивать попросту не с чем
   * (см. `suggestProductId`'s own comment для истории, почему это не всегда
   * было так). Двусмысленная подсказка хуже отсутствующей: её примут не
   * глядя (бриф Task 10).
   */
  suggestedProductId: string | null;
}

export interface CandidatesPageDto {
  candidates: CandidateDto[];
  /** True when the page hit `CANDIDATES_PAGE_SIZE` -- there may be more rows the queue isn't showing. */
  truncated: boolean;
}

/** GET /integrations/:type/candidates query schema. */
export const listCandidatesQuerySchema = z.object({
  hidden: z.enum(["true", "false"]).optional(),
});
export type ListCandidatesQueryDto = z.infer<typeof listCandidatesQuerySchema>;

/** POST /integrations/:type/candidates/:id/link body schema. */
export const linkCandidateSchema = z.object({
  productId: z.string().uuid(),
});
export type LinkCandidateDto = z.infer<typeof linkCandidateSchema>;

export const INTEGRATION_CHANNEL_TYPES = CHANNELS.map((channel) => channel.type);

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

const channelStates: ChannelState[] = [
  "not_configured",
  "working",
  "error",
  "silent",
  "unavailable",
];

export const channelSummaryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["type", "labelKey", "state", "lastEventAt"],
  properties: {
    type: { type: "string", enum: INTEGRATION_CHANNEL_TYPES },
    labelKey: { type: "string" },
    state: { type: "string", enum: channelStates },
    lastEventAt: { ...dateTimeSchema, nullable: true },
  },
};

export const listChannelsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: { channels: { type: "array", items: channelSummaryOpenApiSchema } },
};

export const channelDetailOpenApiSchema: SchemaObject = {
  ...channelSummaryOpenApiSchema,
  required: [
    ...(channelSummaryOpenApiSchema.required ?? []),
    "settings",
    "silentAfterHours",
    "credentialLogin",
  ],
  properties: {
    ...channelSummaryOpenApiSchema.properties,
    settings: { type: "object", additionalProperties: true },
    silentAfterHours: {
      type: "integer",
      minimum: SILENT_AFTER_HOURS_MIN,
      maximum: SILENT_AFTER_HOURS_MAX,
    },
    credentialLogin: { type: "string", nullable: true },
  },
};

const journalEventOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["at", "direction", "outcome", "message", "details"],
  properties: {
    at: dateTimeSchema,
    direction: { type: "string", enum: ["in", "out", "local"] },
    outcome: { type: "string", enum: ["ok", "warn", "error"] },
    message: { type: "string" },
    details: { type: "object", nullable: true, additionalProperties: true },
  },
};

const journalSessionOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "startedAt", "finishedAt", "outcome", "summary", "events"],
  properties: {
    id: uuidSchema,
    startedAt: dateTimeSchema,
    finishedAt: { ...dateTimeSchema, nullable: true },
    outcome: { type: "string", nullable: true },
    summary: { type: "object", nullable: true, additionalProperties: true },
    events: { type: "array", items: journalEventOpenApiSchema },
  },
};

export const journalPageOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["sessions"],
  properties: { sessions: { type: "array", items: journalSessionOpenApiSchema } },
};

export const credentialsIssuedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["login", "secret"],
  properties: {
    login: { type: "string" },
    secret: { type: "string", description: "Shown exactly once; only its hash is stored." },
  },
};

const candidateOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "externalRef",
    "name",
    "article",
    "unit",
    "price",
    "priceType",
    "firstSeenAt",
    "lastSeenAt",
    "hidden",
    "suggestedProductId",
  ],
  properties: {
    id: uuidSchema,
    externalRef: { type: "string" },
    name: { type: "string" },
    article: { type: "string", nullable: true },
    unit: { type: "string", nullable: true },
    price: { type: "string", nullable: true },
    priceType: { type: "string", nullable: true },
    firstSeenAt: dateTimeSchema,
    lastSeenAt: dateTimeSchema,
    hidden: { type: "boolean" },
    suggestedProductId: { ...uuidSchema, nullable: true },
  },
};

export const candidatesPageOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "truncated"],
  properties: {
    candidates: { type: "array", items: candidateOpenApiSchema },
    truncated: { type: "boolean" },
  },
};
