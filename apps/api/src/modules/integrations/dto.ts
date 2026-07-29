import { z } from "zod";
import type { IntegrationChannelType } from "./channel-registry";

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

/** Позиция внешней системы, ещё не сопоставленная с каталогом (Task 9's queue). */
export interface CandidateDto {
  id: string;
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  price: string | null;
  priceType: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  hidden: boolean;
  /**
   * Только при единственном совпадении по нормализованному имени/артикулу
   * среди ещё не связанных товаров -- см. `suggestProductId` в
   * `integrations.service.ts`. Двусмысленная подсказка хуже отсутствующей:
   * её примут не глядя (бриф Task 10).
   */
  suggestedProductId: string | null;
}

export interface CandidatesPageDto {
  candidates: CandidateDto[];
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
