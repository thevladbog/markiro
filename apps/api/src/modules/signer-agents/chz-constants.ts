import type { ChzOmsAuthPayload } from "@markiro/platform-contracts";
import { loadChzTrueApiTokenFormat } from "../../env";

export const CHZ_CHANNEL_TYPE = "chestny_znak" as const;

export const CHZ_TRUE_API_BASE_URLS = {
  production: "https://markirovka.crpt.ru/api/v3/true-api",
  sandbox: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
} as const;

/** СУЗ order-station base URLs, one per environment (used by the order runner, not by `oms_auth`). */
export const CHZ_OMS_BASE_URLS = {
  production: "https://suzgrid.crpt.ru/api/v3",
  sandbox: "https://suz.sandbox.crptech.ru/api/v3",
} as const;

/** СУЗ documents a 10-hour client token and returns no expiry with it. */
export const CHZ_OMS_TOKEN_TTL_MS = 10 * 3600_000;

export function buildChzTrueApiAuthPayload(settings: {
  environment: keyof typeof CHZ_TRUE_API_BASE_URLS;
  mchdInn?: string | undefined;
}) {
  const tokenFormat = loadChzTrueApiTokenFormat();
  return {
    trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS[settings.environment],
    ...(settings.mchdInn ? { inn: settings.mchdInn } : {}),
    ...(tokenFormat === "uuid" ? { tokenFormat } : {}),
  };
}

/**
 * `null` when the channel has no СУЗ installation configured yet -- the
 * scheduler must not send an agent through a СУЗ login with nothing to
 * connect to.
 */
export function buildChzOmsAuthPayload(settings: {
  environment: keyof typeof CHZ_TRUE_API_BASE_URLS;
  // Accepted but unused here: callers pass the full parsed channel settings
  // (which carry `omsId` alongside `omsConnection`), and the payload itself
  // only needs the connection id, not the installation id.
  omsId?: string | undefined;
  omsConnection?: string | undefined;
  mchdInn?: string | undefined;
}): ChzOmsAuthPayload | null {
  if (!settings.omsConnection) return null;
  return {
    trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS[settings.environment],
    omsConnection: settings.omsConnection,
    ...(settings.mchdInn ? { inn: settings.mchdInn } : {}),
  };
}

/** Начинаем обновление за 90 минут до срока, переданного True API. */
export const CHZ_TOKEN_REFRESH_LEAD_MS = 90 * 60_000;
/** pending/claimed задача старше 30 минут считается протухшей. */
export const CHZ_TASK_STALE_MS = 30 * 60_000;
/** Токен, истекающий в пределах lead-окна, показываем как "expiring". */
export type ChzTokenUiStatus = "none" | "active" | "expiring" | "expired";
