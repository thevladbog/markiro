import { invoke } from "@tauri-apps/api/core";

export interface GrantClockSample {
  bootId: string;
  monotonicMs: number;
  wallMs: number;
}
export async function sampleGrantClock(): Promise<GrantClockSample> {
  const sample = await invoke<GrantClockSample>("grant_clock_sample");
  if (
    !sample.bootId ||
    ![sample.monotonicMs, sample.wallMs].every((v) => Number.isSafeInteger(v) && v >= 0)
  )
    throw new Error("untrusted grant clock sample");
  return sample;
}
