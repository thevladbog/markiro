import { z } from "zod";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";
import { platformBillingRequestStatusSchema } from "./commercial.js";
import type { BillingRequestStatus } from "./commercial.js";

const cursorSchema = z.string().min(1).max(512);
const pageQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const episodeParamsSchema = z.object({ id: platformUuidSchema }).strict();
const requestParamsSchema = z.object({ id: platformUuidSchema }).strict();
const messageTextSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0);
const publicMessageTextSchema = z.string().min(1);
const proposalTextSchema = (limit: number) => z.string().trim().min(1).max(limit);

const transcriptNotices = {
  ru: "Переписка по этому вопросу будет добавлена в обращение. Её смогут читать владелец и администраторы вашей организации, а также поддержка Markiro. Новые сообщения этого диалога тоже будут добавляться",
  en: "The conversation about this issue will be added to the support request. The owner and administrators of your organization, as well as Markiro support, will be able to read it. New messages in this conversation will also be added",
} as const;

export type SupportTranscriptNoticeLocale = keyof typeof transcriptNotices;
export function supportTranscriptNotice(locale: SupportTranscriptNoticeLocale) {
  return { version: "support-transcript-v1" as const, locale, text: transcriptNotices[locale] };
}

export const supportOwnerSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    userId: z.string().min(1).max(128),
  })
  .strict();
export type SupportOwner = z.output<typeof supportOwnerSchema>;

export const supportMessageSchema = z
  .object({
    id: platformUuidSchema,
    direction: z.enum(["customer", "operator"]),
    text: publicMessageTextSchema,
    occurredAt: platformTimestampSchema,
    delivery: z.enum(["pending", "sent", "uncertain", "failed"]),
  })
  .strict();
export type SupportMessage = z.output<typeof supportMessageSchema>;
const transcriptMessageSchema = supportMessageSchema
  .extend({ delivery: z.literal("sent") })
  .strict();

export const supportRequestRefSchema = z
  .object({
    id: platformUuidSchema,
    number: z.string().min(1).max(100),
    status: platformBillingRequestStatusSchema,
  })
  .strict();
export type SupportRequestRef = { id: string; number: string; status: BillingRequestStatus };

export const supportProposalSchema = z
  .object({
    id: platformUuidSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4_000),
    noticeVersion: z.literal("support-transcript-v1"),
    state: z.enum(["pending", "accepted", "declined"]),
  })
  .strict();
export type SupportProposal = z.output<typeof supportProposalSchema>;

export const supportSyncSchema = z
  .object({
    state: z.enum(["pending", "healthy", "error"]),
    lastSyncedAt: platformTimestampSchema.nullable(),
    errorCode: z.enum(["consent_notice_unknown", "sync_failed"]).nullable(),
  })
  .strict();
export const supportEpisodeViewSchema = z
  .object({
    id: platformUuidSchema,
    messages: z.array(supportMessageSchema),
    nextCursor: cursorSchema.nullable(),
    proposal: supportProposalSchema.nullable(),
    request: supportRequestRefSchema.nullable(),
    sync: supportSyncSchema,
  })
  .strict();
export type SupportEpisodeView = z.output<typeof supportEpisodeViewSchema>;

export const supportTranscriptPageSchema = z
  .object({
    items: z.array(transcriptMessageSchema),
    nextCursor: cursorSchema.nullable(),
    sync: supportSyncSchema,
  })
  .strict();
export type SupportTranscriptPage = z.output<typeof supportTranscriptPageSchema>;

const episodeSummarySchema = supportEpisodeViewSchema
  .omit({ messages: true, nextCursor: true })
  .strict();
const episodeListSchema = z
  .object({
    items: z.array(episodeSummarySchema),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

export const supportChatContracts = {
  episodeList: {
    query: pageQuerySchema.extend({ cursor: platformUuidSchema.optional() }).strict(),
    response: episodeListSchema,
  },
  episodeCreate: {
    body: z.object({ idempotencyKey: platformUuidSchema }).strict(),
    response: supportEpisodeViewSchema,
  },
  episode: {
    params: episodeParamsSchema,
    query: pageQuerySchema,
    response: supportEpisodeViewSchema,
  },
  message: {
    params: episodeParamsSchema,
    body: z.object({ text: messageTextSchema, idempotencyKey: platformUuidSchema }).strict(),
    response: supportMessageSchema,
  },
  decision: {
    params: z.object({ id: platformUuidSchema, proposalId: platformUuidSchema }).strict(),
    body: z
      .object({
        decision: z.enum(["accept", "decline"]),
        revision: z.number().int().positive(),
        noticeVersion: z.string().min(1).max(80),
        noticeLocale: z.enum(["ru", "en"]),
        idempotencyKey: platformUuidSchema,
      })
      .strict(),
    response: supportEpisodeViewSchema,
  },
} as const;

export const platformSupportChatContracts = {
  episodeList: {
    query: pageQuerySchema
      .extend({
        cursor: platformUuidSchema.optional(),
        tenantId: platformTenantIdSchema.optional(),
      })
      .strict(),
    response: episodeListSchema,
  },
  episode: {
    params: episodeParamsSchema,
    query: pageQuerySchema,
    response: supportEpisodeViewSchema,
  },
  proposal: {
    params: episodeParamsSchema,
    body: z
      .object({
        title: proposalTextSchema(200),
        summary: proposalTextSchema(4_000),
        idempotencyKey: platformUuidSchema,
      })
      .strict(),
    response: supportProposalSchema,
  },
  retrySync: {
    params: episodeParamsSchema,
    body: z.object({}).strict(),
    response: supportEpisodeViewSchema,
  },
} as const;

export const supportTranscriptContracts = {
  tenant: {
    params: requestParamsSchema,
    query: pageQuerySchema,
    response: supportTranscriptPageSchema,
  },
  platform: {
    params: requestParamsSchema,
    query: pageQuerySchema,
    response: supportTranscriptPageSchema,
  },
} as const;
