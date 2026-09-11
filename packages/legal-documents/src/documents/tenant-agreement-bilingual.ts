import type { LegalBlock, LegalDocumentLocaleContent } from "../types.js";

/**
 * The four Russian accounting forms. They are primary documents filled in
 * Russian for the tax authority, so an English column beside them would
 * suggest an invoice can be issued in English.
 */
export const AGREEMENT_MONOLINGUAL_SECTION_IDS: ReadonlySet<string> = new Set([
  "prilozhenie-5",
  "prilozhenie-6",
  "prilozhenie-7",
  "prilozhenie-8",
]);

export interface BilingualSection {
  readonly id: string;
  readonly startsPage?: true;
  readonly bilingual: boolean;
  readonly ru: { readonly heading: string; readonly blocks: readonly LegalBlock[] };
  readonly en: { readonly heading: string; readonly blocks: readonly LegalBlock[] };
}

export interface BilingualContent {
  readonly title: { readonly ru: string; readonly en: string };
  readonly summary: { readonly ru: string; readonly en: string };
  readonly sections: readonly BilingualSection[];
}

/**
 * Zips two locale trees of the same document. Throws on any divergence: the
 * one failure a bilingual contract hides is a clause present in one column and
 * absent from the other, and no reader checks that by eye.
 */
export function pairLocaleContent(
  ru: LegalDocumentLocaleContent,
  en: LegalDocumentLocaleContent,
  monolingualSectionIds: ReadonlySet<string>,
): BilingualContent {
  if (ru.sections.length !== en.sections.length) {
    throw new Error(
      `Bilingual agreement section count differs: ru=${ru.sections.length}, en=${en.sections.length}`,
    );
  }

  const sections = ru.sections.map((ruSection, index) => {
    // Non-null: the lengths were compared above.
    const enSection = en.sections[index] as (typeof en.sections)[number];
    if (ruSection.id !== enSection.id) {
      throw new Error(
        `Bilingual agreement section order differs at ${index}: ru=${ruSection.id}, en=${enSection.id}`,
      );
    }
    if (ruSection.blocks.length !== enSection.blocks.length) {
      throw new Error(
        `Bilingual agreement block count differs in ${ruSection.id}: ru=${ruSection.blocks.length}, en=${enSection.blocks.length}`,
      );
    }
    ruSection.blocks.forEach((ruBlock, blockIndex) => {
      // Non-null: the lengths were compared above.
      assertSameShape(ruSection.id, blockIndex, ruBlock, enSection.blocks[blockIndex] as LegalBlock);
    });

    return {
      id: ruSection.id,
      ...(ruSection.startsPage === true ? { startsPage: true as const } : {}),
      bilingual: !monolingualSectionIds.has(ruSection.id),
      ru: { heading: ruSection.heading, blocks: ruSection.blocks },
      en: { heading: enSection.heading, blocks: enSection.blocks },
    } satisfies BilingualSection;
  });

  return {
    title: { ru: ru.title, en: en.title },
    summary: { ru: ru.summary, en: en.summary },
    sections,
  };
}

function assertSameShape(
  sectionId: string,
  blockIndex: number,
  ru: LegalBlock,
  en: LegalBlock,
): void {
  const where = `${sectionId}[${blockIndex}]`;
  if (ru.kind !== en.kind) {
    throw new Error(`Bilingual agreement block kind differs in ${where}: ${ru.kind} vs ${en.kind}`);
  }
  if (ru.kind === "ordered-list" || ru.kind === "unordered-list") {
    const enList = en as Extract<LegalBlock, { kind: "ordered-list" | "unordered-list" }>;
    if (ru.items.length !== enList.items.length) {
      throw new Error(
        `Bilingual agreement list length differs in ${where}: ${ru.items.length} vs ${enList.items.length}`,
      );
    }
  }
  if (ru.kind === "definition-list") {
    const enList = en as Extract<LegalBlock, { kind: "definition-list" }>;
    if (ru.items.length !== enList.items.length) {
      throw new Error(
        `Bilingual agreement definition count differs in ${where}: ${ru.items.length} vs ${enList.items.length}`,
      );
    }
  }
  if (ru.kind === "table") {
    const enTable = en as Extract<LegalBlock, { kind: "table" }>;
    if (ru.columns.length !== enTable.columns.length || ru.rows.length !== enTable.rows.length) {
      throw new Error(
        `Bilingual agreement table shape differs in ${where}: ${ru.columns.length}x${ru.rows.length} vs ${enTable.columns.length}x${enTable.rows.length}`,
      );
    }
  }
}
