import { clamp01 } from "./math";

export type Rgb = readonly [number, number, number];
export type ColourStop = readonly [position: number, colour: string];

const HEX = /^#([0-9a-f]{6})$/iu;

export function parseHex(hex: string): Rgb {
  const digits = HEX.exec(hex)?.[1];
  if (digits === undefined) throw new Error(`Expected a #rrggbb colour, got ${hex}`);
  const value = Number.parseInt(digits, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function formatHex(rgb: Rgb): string {
  const channel = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function toSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Mixes two sRGB colours in linear light, the way the renderer blends them. */
export function mixHex(from: string, to: string, amount: number): string {
  const t = clamp01(amount);
  const a = parseHex(from);
  const b = parseHex(to);
  const mix = (x: number, y: number): number =>
    toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return formatHex([mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]);
}

export function mixStops(stops: readonly ColourStop[], position: number): string {
  const first = stops[0];
  const last = stops.at(-1);
  if (first === undefined || last === undefined) throw new Error("mixStops needs a stop");
  if (position <= first[0]) return first[1];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (previous === undefined || next === undefined) continue;
    if (position <= next[0]) {
      return mixHex(previous[1], next[1], (position - previous[0]) / (next[0] - previous[0]));
    }
  }
  return last[1];
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex);
  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}
