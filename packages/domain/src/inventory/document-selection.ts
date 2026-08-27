import { z } from "zod";

import { compareText, createUtf8ByteComparator } from "../document-text-encoding.js";
import type { InventoryDocumentGenerationSource } from "./document-generators.js";

export interface EligibleInventoryFinalBox {
  sscc: string;
  oldSsccContext: string | null;
  productionDate: string;
  codes: readonly {
    codeHash: string;
    canonicalRaw: string;
    observedProductionDate: string;
  }[];
}

const civilDateSchema = z.iso.date();

export function selectEligibleInventoryFinalBoxes(
  source: InventoryDocumentGenerationSource,
): EligibleInventoryFinalBox[] {
  const protectedHashes = new Set(source.protected.map((code) => code.codeHash));
  const verifiedByHash = new Map(source.verified.map((code) => [code.codeHash, code]));

  return [...source.newBoxes]
    .sort((left, right) => compareText(left.sscc, right.sscc))
    .flatMap((box) => {
      if (
        box.state !== "closed" ||
        box.printState !== "printed" ||
        box.codeHashes.length === 0 ||
        new Set(box.codeHashes).size !== box.codeHashes.length ||
        !civilDateSchema.safeParse(box.productionDate).success
      ) {
        return [];
      }

      const codes: EligibleInventoryFinalBox["codes"][number][] = [];
      for (const codeHash of box.codeHashes) {
        const code = verifiedByHash.get(codeHash);
        if (
          protectedHashes.has(codeHash) ||
          code === undefined ||
          code.observedProductionDate !== box.productionDate
        ) {
          return [];
        }
        codes.push({
          codeHash: code.codeHash,
          canonicalRaw: code.canonicalRaw,
          observedProductionDate: code.observedProductionDate,
        });
      }

      codes.sort(createUtf8ByteComparator((code) => code.canonicalRaw));
      return [
        {
          sscc: box.sscc,
          oldSsccContext: box.oldSsccContext,
          productionDate: box.productionDate,
          codes,
        },
      ];
    });
}
