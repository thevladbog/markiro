import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildPalletSheetLotNumberPresets,
  buildStockLotNumberLabelVariants,
} from "../dist/index.js";

const output = fileURLToPath(
  new URL("../../../apps/standalone/host/stock/lot-number-variants.json", import.meta.url),
);
const variants = {
  labels: buildStockLotNumberLabelVariants(),
  sheets: buildPalletSheetLotNumberPresets(),
};
await writeFile(output, JSON.stringify(variants, null, 2) + "\n");
