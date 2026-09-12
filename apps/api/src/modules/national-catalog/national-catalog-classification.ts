import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { z } from "zod";

export const catalogClassificationSchema = z
  .object({
    tnVedCode: z
      .string()
      .regex(/^\d{10}$/)
      .nullable(),
    okpd2Code: z
      .string()
      .regex(/^\d{2}(?:\.\d{1,3}){1,3}$/)
      .nullable(),
  })
  .strict();

type Attribute = { id: number; name?: string | undefined; value: string; gtin: string | null };

/** NC API documents 13933 as the full TN VED code; 3959 is only its four-digit group.
 * https://docs.crpt.ru/gismt/API_%D0%9D%D0%9A/ section 3.2.1.
 * OKPD2 uses exact source labels, like the existing EGAIS/shelf-life import.
 * No substring matching, invented IDs, or conversion of classification codes.
 */
export function readCatalogClassification(attributes: readonly Attribute[], gtin14: string) {
  const scoped = attributes.filter(
    (a) => a.gtin === null || (isValidGtin(a.gtin) && normalizeToGtin14(a.gtin) === gtin14),
  );
  const read = (matches: (a: Attribute) => boolean, format: z.ZodType<string>) => {
    const candidates = scoped.filter(matches);
    const first = candidates[0];
    if (
      !first ||
      new Set(candidates.map((a) => a.id)).size !== 1 ||
      new Set(candidates.map((a) => a.value.trim())).size !== 1 ||
      scoped.some((a) => a.id === first.id && !matches(a))
    )
      return null;
    const parsed = format.safeParse(first.value.trim());
    if (!parsed.success) return null;
    sourceAttributeIds.push(first.id);
    return parsed.data;
  };
  const sourceAttributeIds: number[] = [];
  return {
    classification: {
      tnVedCode: read((a) => a.id === 13933, z.string().regex(/^\d{10}$/)),
      okpd2Code: read(
        (a) => ["ОКПД2", "Код ОКПД2", "Код ОКПД 2"].includes(a.name?.trim() ?? ""),
        z.string().regex(/^\d{2}(?:\.\d{1,3}){1,3}$/),
      ),
    },
    sourceAttributeIds,
  };
}
