import { mixHex, mixStops, type ColourStop } from "./color";
import { clamp01, ramp } from "./math";

/** Time of day in the middle of each chapter: morning, sunset, night. */
export const CHAPTER_TIME_OF_DAY = [0.05, 0.15, 0.25, 0.42, 0.52, 0.72, 1] as const;

export interface LightingState {
  readonly timeOfDay: number;
  readonly background: string;
  /** How far materials move towards the night palette. */
  readonly materialNight: number;
  readonly skyColor: string;
  readonly groundColor: string;
  readonly skyIntensity: number;
  readonly sunColor: string;
  readonly sunIntensity: number;
  readonly sunPosition: readonly [number, number, number];
  readonly fillIntensity: number;
  readonly lamps: number;
  readonly glow: number;
  readonly bloom: number;
  readonly ambientOcclusion: number;
  readonly contactShadow: number;
  readonly uiTheme: "light" | "dark";
}

const BACKGROUND: readonly ColourStop[] = [
  [0, "#fafaf8"],
  [0.42, "#f1eae1"],
  [0.62, "#6b6461"],
  [0.82, "#1e1c21"],
  [1, "#131216"],
];

export function timeOfDayAt(filmTime: number): number {
  const first = CHAPTER_TIME_OF_DAY[0];
  const last = CHAPTER_TIME_OF_DAY[CHAPTER_TIME_OF_DAY.length - 1] ?? 1;
  if (filmTime <= 0.5) return first;
  if (filmTime >= CHAPTER_TIME_OF_DAY.length - 0.5) return last;
  const position = filmTime - 0.5;
  const index = Math.floor(position);
  const from = CHAPTER_TIME_OF_DAY[index] ?? last;
  const to = CHAPTER_TIME_OF_DAY[index + 1] ?? last;
  const k = position - index;
  return from + (to - from) * k * k * (3 - 2 * k);
}

function blend(tod: number, day: number, sunset: number, night: number): number {
  return tod < 0.5 ? day + (sunset - day) * tod * 2 : sunset + (night - sunset) * (tod - 0.5) * 2;
}

function blendColour(tod: number, day: string, sunset: string, night: string): string {
  return tod < 0.5 ? mixHex(day, sunset, tod * 2) : mixHex(sunset, night, (tod - 0.5) * 2);
}

export function lightingAt(timeOfDay: number): LightingState {
  const tod = clamp01(timeOfDay);
  return {
    timeOfDay: tod,
    background: mixStops(BACKGROUND, tod),
    materialNight: ramp(tod, 0.5, 1) * 0.6,
    skyColor: blendColour(tod, "#ffffff", "#f1ddcb", "#7d879f"),
    groundColor: blendColour(tod, "#cfcac0", "#8c8178", "#131216"),
    skyIntensity: blend(tod, 1.1, 0.9, 0.62),
    sunColor: blendColour(tod, "#ffffff", "#ffc49a", "#b4c2ff"),
    sunIntensity: blend(tod, 2.7, 2.2, 0.8),
    sunPosition: [blend(tod, -11, -16, 9), blend(tod, 12, 5.5, 15), blend(tod, 7, 3, -11)],
    fillIntensity: blend(tod, 0.3, 0.12, 0),
    lamps: ramp(tod, 0.35, 0.8),
    glow: ramp(tod, 0.4, 0.9),
    bloom: 0.7 * ramp(tod, 0.35, 0.9),
    ambientOcclusion: blend(tod, 1.15, 1.05, 0.9),
    contactShadow: 0.24 + 0.31 * ramp(tod, 0.3, 0.9),
    uiTheme: tod >= 0.6 ? "dark" : "light",
  };
}
