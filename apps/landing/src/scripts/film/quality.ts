export type QualityTier = "high" | "mid" | "low";

export const QUALITY_TIERS: readonly QualityTier[] = ["high", "mid", "low"];

export interface DeviceHints {
  readonly coarsePointer: boolean;
  readonly deviceMemory: number | null;
  readonly cores: number | null;
}

export interface TierSettings {
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number;
  readonly ambientOcclusion: boolean;
  readonly bloom: boolean;
  readonly tiltShift: boolean;
  readonly antialiasSamples: number;
}

export const TIER_SETTINGS: Readonly<Record<QualityTier, TierSettings>> = {
  high: {
    pixelRatioCap: 2,
    shadowMapSize: 4096,
    ambientOcclusion: true,
    bloom: true,
    tiltShift: true,
    antialiasSamples: 4,
  },
  mid: {
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    ambientOcclusion: false,
    bloom: true,
    tiltShift: true,
    antialiasSamples: 2,
  },
  low: {
    pixelRatioCap: 1,
    shadowMapSize: 1024,
    ambientOcclusion: false,
    bloom: false,
    tiltShift: false,
    antialiasSamples: 0,
  },
};

export function chooseTier(hints: DeviceHints): QualityTier {
  const weakMemory = hints.deviceMemory !== null && hints.deviceMemory <= 2;
  const weakCpu = hints.cores !== null && hints.cores <= 2;
  if (weakMemory || weakCpu) return "low";
  return hints.coarsePointer ? "mid" : "high";
}

export type FrameVerdict = "measuring" | "ok" | "too-slow";

export interface FrameBudget {
  push(frameMs: number, now: number): FrameVerdict;
}

/** Judges the median frame of the first `windowMs` of rendering, once. */
export function createFrameBudget(limitMs = 50, windowMs = 2000): FrameBudget {
  const samples: number[] = [];
  let startedAt: number | null = null;
  let verdict: FrameVerdict = "measuring";
  return {
    push(frameMs, now) {
      if (verdict !== "measuring") return verdict;
      startedAt ??= now;
      samples.push(frameMs);
      if (now - startedAt < windowMs) return verdict;
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      verdict = median > limitMs ? "too-slow" : "ok";
      return verdict;
    },
  };
}
