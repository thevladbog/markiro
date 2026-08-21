export interface PlatformResponseSchema<T> {
  parse(value: unknown): T;
}

export function parsePlatformResponse<T>(schema: PlatformResponseSchema<T>, value: unknown): T {
  return schema.parse(value);
}
