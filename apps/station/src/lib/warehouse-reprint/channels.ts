/** A failed optional history channel cannot suppress another channel's durable receipts. */
export async function runWarehouseHistoryChannels(channels: readonly (() => Promise<void>)[]) {
  for (const channel of channels) {
    try {
      await channel();
    } catch {
      console.warn("station: warehouse print history retained for retry");
    }
  }
}
