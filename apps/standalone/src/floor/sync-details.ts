import type { TFunction } from "i18next";

import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import type { FactsFailure, SyncState } from "../app/shell.js";
import {
  readDeliveryStuck,
  readOutboxStatus,
  waitUnits,
  type DeliveryStuck,
  type OutboxStatus,
} from "./outbox-status.js";
import { kindText, reasonText, recordText } from "./queue/QueueScreen.js";
import { readQueue, type QueueView, type SettledRecord } from "./queue/outbox-recovery.js";
import { formatQuantity } from "./shifts/shift-text.js";

/**
 * What the «Синхронизация» panel reads from the station's database (beta 3):
 * the outbox's counts, the oldest record that waits, and the queue screen's own
 * read of the records the host refused or found in conflict (`readQueue`). The
 * panel adds no query of its own to the outbox: it reuses the status bar's and
 * the queue's, so the numbers agree with both.
 */
export interface SyncDetails {
  outbox: OutboxStatus;
  stuck: DeliveryStuck | null;
  queue: QueueView;
}

/** How many refused or conflicting records the panel names; the rest are counted. */
export const LISTED_RECORDS = 8;

export async function readSyncDetails(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<SyncDetails> {
  const [outbox, stuck, queue] = await Promise.all([
    readOutboxStatus(local, pairing),
    readDeliveryStuck(local, pairing, now),
    readQueue(local, pairing),
  ]);
  return { outbox, stuck, queue };
}

/** A wait as words: `2 ч 5 мин`, `меньше минуты`. */
export function waitWords(t: TFunction, ms: number): string {
  const parts = waitUnits(ms);
  return parts.length === 0
    ? t("floor.status.wait.none")
    : parts.map((part) => t(`floor.status.wait.${part.unit}`, { n: part.n })).join(" ");
}

/** Day, month, hours and minutes on this computer's clock. */
const MOMENT = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function momentText(at: Date): string {
  return MOMENT.format(at);
}

/** The records the host refused, or found in conflict, that the panel names. */
export function problemRecords(queue: QueueView): { listed: SettledRecord[]; more: number } {
  const listed = queue.settled.slice(0, LISTED_RECORDS);
  const total = queue.tallies.reduce((sum, tally) => sum + tally.count, 0);
  return { listed, more: Math.max(0, total - listed.length) };
}

export interface SyncSummary {
  link: HostStatus | null;
  sync: SyncState;
  factsFailure: FactsFailure | null;
  refusalHeld: boolean;
  lastSyncedAt: Date | null;
  details: SyncDetails | null;
}

/** The words of a failed send of the outbox; `null` when it did not fail. */
export function factsFailureText(t: TFunction, failure: FactsFailure | null): string | null {
  switch (failure) {
    case null:
      return null;
    case "offline":
      return t("floor.sync.factsOffline");
    case "host":
      return t("floor.status.factsHost");
    case "held":
      return t("floor.status.restoreHeld");
    case "local":
      return t("floor.status.factsLocal");
  }
}

/** The link's one line, as the status line says it. */
export function linkText(t: TFunction, link: HostStatus | null, refusalHeld: boolean): string {
  if (link === null) return t("floor.sync.linkUnknown");
  if (refusalHeld || link.state === "offline") {
    return link.lastContactAt === null
      ? t("link.offline")
      : t("floor.sync.offlineSince", { at: momentText(new Date(link.lastContactAt)) });
  }
  return link.state === "connecting" ? t("link.connecting") : t("link.online");
}

/**
 * The panel as plain text, to copy and send to whoever supports the site: the
 * same lines the panel shows, in Russian, with no secret in them (counts,
 * times, the host's codes and the shifts' numbers; never a code of marking, a
 * badge, a PIN or a key).
 */
export function detailsText(t: TFunction, summary: SyncSummary, taken: Date): string {
  const lines: string[] = [t("floor.sync.copyHeader", { at: momentText(taken) })];
  lines.push(`${t("floor.sync.linkTitle")}: ${linkText(t, summary.link, summary.refusalHeld)}`);
  if (summary.link?.lastError != null && summary.link.state !== "online") {
    lines.push(t(`errors.link.${summary.link.lastError}`));
  }
  lines.push(
    `${t("floor.sync.referencesTitle")}: ${
      summary.lastSyncedAt === null
        ? t("floor.sync.notYetSynced")
        : t("floor.sync.syncedAt", { at: momentText(summary.lastSyncedAt) })
    }`,
  );
  if (summary.sync.failure !== null) lines.push(t(`errors.sync.${summary.sync.failure}`));
  if (summary.sync.quarantined > 0) {
    lines.push(t("link.quarantined", { n: summary.sync.quarantined }));
  }
  const failure = factsFailureText(t, summary.factsFailure);
  const details = summary.details;
  if (details === null) {
    lines.push(t("floor.sync.queueUnreadable"));
    return lines.join("\n");
  }
  lines.push(
    `${t("floor.sync.queueTitle")}: ${t("floor.sync.unsent", {
      n: formatQuantity(details.outbox.unsent),
    })}`,
  );
  if (details.stuck !== null) {
    lines.push(
      t("floor.sync.oldest", {
        age: waitWords(t, details.stuck.waitedMs),
        attempts: formatQuantity(details.stuck.attempts),
      }),
    );
  }
  if (failure !== null) lines.push(failure);
  if (details.outbox.rejected > 0) {
    lines.push(t("floor.sync.rejected", { n: formatQuantity(details.outbox.rejected) }));
  }
  if (details.outbox.conflicts > 0) {
    lines.push(t("floor.sync.conflicts", { n: formatQuantity(details.outbox.conflicts) }));
  }
  if (details.outbox.displaced > 0) {
    lines.push(t("floor.sync.displaced", { n: formatQuantity(details.outbox.displaced) }));
  }
  if (details.queue.stranded > 0) {
    lines.push(t("floor.sync.stranded", { n: formatQuantity(details.queue.stranded) }));
  }
  const { listed, more } = problemRecords(details.queue);
  for (const record of listed) {
    const shift =
      record.shiftNumber === null
        ? ""
        : `${t("floor.sync.shift", { number: record.shiftNumber })}: `;
    lines.push(`- ${shift}${recordText(t, record)} — ${reasonText(t, record)}`);
  }
  if (more > 0) lines.push(t("floor.sync.moreRecords", { n: formatQuantity(more) }));
  for (const kind of details.queue.unsent) {
    lines.push(
      `- ${kindText(t, kind.kind)}: ${formatQuantity(kind.count)}, ${t("floor.sync.since", {
        at: momentText(new Date(kind.oldest)),
      })}`,
    );
  }
  return lines.join("\n");
}
