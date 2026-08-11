const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;

export type StationVersion = [major: number, minor: number, patch: number, beta: number];

export function parseStationVersion(value: unknown): StationVersion {
  if (typeof value !== "string") throw new Error("invalid station update state");
  const match = VERSION.exec(value);
  if (!match) throw new Error("invalid station update state");
  const parsed = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
  ] as StationVersion;
  if (!parsed.every(Number.isSafeInteger)) throw new Error("invalid station update state");
  return parsed;
}

export function isStationBetaVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && value.includes("-beta.");
}

export function compareStationVersions(left: string, right: string): number {
  const a = parseStationVersion(left);
  const b = parseStationVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
