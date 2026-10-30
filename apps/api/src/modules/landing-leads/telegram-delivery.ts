import { TelegramSendError, type TelegramNotificationTarget } from "./telegram.client";

type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";
interface Delivery {
  id: string;
  status: DeliveryStatus;
  attempts: number;
  errorCode: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStatus(value: unknown): value is DeliveryStatus {
  return value === "pending" || value === "sent" || value === "failed" || value === "skipped";
}

function deliveriesFromPayload(
  payload: Record<string, unknown>,
  targets: readonly TelegramNotificationTarget[],
  attemptsSoFar: number,
  maxAttempts: number,
): Delivery[] {
  const stored = payload.telegramDelivery;
  if (stored === undefined)
    return targets.map((target) => ({
      id: target.id,
      status: "pending",
      attempts: attemptsSoFar,
      errorCode: null,
    }));
  const state = record(stored);
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.targets) ||
    state.targets.length < 1 ||
    state.targets.length > 2
  )
    throw new TelegramSendError("telegram_delivery_state", false);
  const result: Delivery[] = [];
  const entries: readonly unknown[] = state.targets;
  for (const raw of entries) {
    const entry = record(raw);
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) ||
      !isStatus(entry.status) ||
      typeof entry.attempts !== "number" ||
      !Number.isInteger(entry.attempts) ||
      entry.attempts < 0 ||
      entry.attempts > maxAttempts ||
      (entry.status === "pending" && entry.attempts >= maxAttempts) ||
      !(
        entry.errorCode === null ||
        (typeof entry.errorCode === "string" && /^[a-z0-9_]{1,64}$/.test(entry.errorCode))
      ) ||
      result.some((value) => value.id === entry.id)
    )
      throw new TelegramSendError("telegram_delivery_state", false);
    result.push({
      id: entry.id,
      status: entry.status,
      attempts: entry.attempts,
      errorCode: entry.errorCode,
    });
  }
  return result;
}

/** Ordinary retries preserve successful recipients. A crash before the DB commit remains at-least-once. */
export async function deliverTelegramNotification(
  payload: Record<string, unknown>,
  targets: readonly TelegramNotificationTarget[],
  text: string,
  attemptsSoFar: number,
  maxAttempts: number,
  onFailure: (code: string) => void,
): Promise<{ status: DeliveryStatus; payload: Record<string, unknown>; errorCode: string | null }> {
  const deliveries = deliveriesFromPayload(payload, targets, attemptsSoFar, maxAttempts);
  for (const delivery of deliveries) {
    if (delivery.status !== "pending") continue;
    const target = targets.find((target) => target.id === delivery.id);
    if (!target) {
      delivery.status = "skipped";
      delivery.errorCode = "telegram_target_removed";
      continue;
    }
    delivery.attempts += 1;
    try {
      await target.sender.sendMessage(text);
      delivery.status = "sent";
      delivery.errorCode = null;
    } catch (error) {
      const failure =
        error instanceof TelegramSendError
          ? error
          : new TelegramSendError("telegram_message_build", false);
      delivery.status = failure.transient && delivery.attempts < maxAttempts ? "pending" : "failed";
      delivery.errorCode = failure.code;
      onFailure(failure.code);
    }
  }
  const pending = deliveries.find((delivery) => delivery.status === "pending");
  const failed = deliveries.find((delivery) => delivery.status === "failed");
  const status = pending
    ? "pending"
    : failed
      ? "failed"
      : deliveries.some((delivery) => delivery.status === "sent")
        ? "sent"
        : "skipped";
  return {
    status,
    errorCode:
      pending?.errorCode ??
      failed?.errorCode ??
      (status === "skipped" ? "telegram_target_removed" : null),
    payload: { ...payload, telegramDelivery: { version: 1, targets: deliveries } },
  };
}
