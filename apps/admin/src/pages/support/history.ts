import type { SupportEpisodeView, SupportMessage } from "@markiro/platform-contracts";

type Boundary = Pick<SupportMessage, "id" | "occurredAt">;
export type EpisodeHistory = SupportEpisodeView & {
  recovery?: { cursor: string; boundary: Boundary | null } | null;
};

function compare(a: Boundary, b: Boundary) {
  return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);
}

export function mergeMessages(...pages: SupportMessage[][]): SupportMessage[] {
  return Array.from(new Map(pages.flat().map((message) => [message.id, message])).values()).sort(
    compare,
  );
}

/** One backward read per poll, independent of the customer's manual history cursor. */
export async function reconcileHistory(
  previous: EpisodeHistory,
  latest: SupportEpisodeView,
  readPage: (cursor: string) => Promise<SupportEpisodeView>,
): Promise<EpisodeHistory> {
  const boundary = previous.nextCursor === null ? null : (previous.messages[0] ?? null);
  // Restart completed sweeps even when latest overlaps the cache: remote backfill
  // can insert a message anywhere in the chronological range after we passed it.
  const recovery =
    previous.recovery ?? (latest.nextCursor ? { cursor: latest.nextCursor, boundary } : null);
  if (!recovery) {
    return {
      ...latest,
      messages: mergeMessages(previous.messages, latest.messages),
      nextCursor: previous.nextCursor,
      recovery: null,
    };
  }
  const page = await readPage(recovery.cursor);
  const oldest = page.messages[0];
  const floor = recovery.boundary;
  const covered = floor !== null && oldest !== undefined && compare(oldest, floor) <= 0;
  const openedMessages = floor
    ? page.messages.filter((message) => compare(message, floor) >= 0)
    : page.messages;
  return {
    ...latest,
    messages: mergeMessages(previous.messages, latest.messages, openedMessages),
    nextCursor: previous.nextCursor,
    recovery: !covered && page.nextCursor ? { ...recovery, cursor: page.nextCursor } : null,
  };
}
