import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Generic Nest pipe wrapping a zod schema: parses the incoming value and
 * either returns the typed, parsed result or throws a 400 with the zod
 * issues as the error body. Reused across every module in this plan (see
 * org-profile.controller.ts) instead of hand-rolling validation per route --
 * pass a schema per parameter, e.g. `@Body(new ZodValidationPipe(schema))`.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
