import { platformErrorSchema, type PlatformError } from "@markiro/platform-contracts";

export interface PlatformResponseSchema<T> {
  parse(value: unknown): T;
}

export function parsePlatformResponse<T>(schema: PlatformResponseSchema<T>, value: unknown): T {
  return schema.parse(value);
}

export function parsePlatformError(value: unknown): PlatformError {
  return platformErrorSchema.parse(value);
}

export function safePlatformMachineCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value)) return null;
  return value;
}
