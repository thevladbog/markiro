import type { ScannedCode, SetItem } from "../../host/protocol.js";

export function setIdentificationCode({ gtin14, serial }: ScannedCode): string {
  return `01${gtin14}21${serial}`;
}

export interface SetContentsGroup {
  gtin14: string;
  productName: string | null;
  codes: ScannedCode[];
}

/** The shift's frozen recipe supplies names; the assembled marks supply the quantities. */
export function groupSetContents(
  items: readonly ScannedCode[],
  recipe: readonly SetItem[] = [],
): SetContentsGroup[] {
  const contents = new Map<string, SetContentsGroup>(
    recipe.map(
      ({ gtin14, productName }) =>
        [gtin14, { gtin14, productName, codes: [] } satisfies SetContentsGroup] as const,
    ),
  );
  for (const item of items) {
    const group = contents.get(item.gtin14) ?? {
      gtin14: item.gtin14,
      productName: null,
      codes: [],
    };
    group.codes.push(item);
    contents.set(item.gtin14, group);
  }
  return [...contents.values()].filter(({ codes }) => codes.length > 0);
}
