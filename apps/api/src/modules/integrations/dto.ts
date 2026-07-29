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
