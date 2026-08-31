import { loadChzTrueApiTokenFormat } from "../../env";

export const CHZ_CHANNEL_TYPE = "chestny_znak" as const;

export const CHZ_TRUE_API_BASE_URLS = {
  production: "https://markirovka.crpt.ru/api/v3/true-api",
  sandbox: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
} as const;

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

/** Начинаем обновление за 90 минут до истечения 10-часового токена. */
export const CHZ_TOKEN_REFRESH_LEAD_MS = 90 * 60_000;
/** pending/claimed задача старше 30 минут считается протухшей. */
export const CHZ_TASK_STALE_MS = 30 * 60_000;
/** Токен, истекающий в пределах lead-окна, показываем как "expiring". */
export type ChzTokenUiStatus = "none" | "active" | "expiring" | "expired";
