import { NotFoundException } from "@nestjs/common";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { parseMasterDataInput } from "./us-master-data-support";

const idsSchema = z.array(platformUuidSchema).max(256);

export function parseMasterDataIds(input: unknown): string[] {
  return parseMasterDataInput(idsSchema, input);
}

/** Preserve caller order and repetitions; a missing row uses the ordinary native error. */
export function orderedMasterDataRows<T>(
  ids: readonly string[],
  rows: readonly T[],
  idOf: (row: T) => string,
  missingCode: string,
): T[] {
  const byId = new Map(rows.map((row) => [idOf(row), row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundException({ code: missingCode });
    return row;
  });
}
