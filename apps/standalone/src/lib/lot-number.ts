/** A stored lot number has only Russian and Latin letters and ASCII digits. */
export function isLotNumber(value: string): boolean {
  return value.length > 0 && !/[^A-Za-zА-Яа-яЁё0-9]/u.test(value);
}

/** The same Unicode whitespace as Rust's `str::trim`, including at paste boundaries. */
export function optionalLotNumber(text: string): string | null {
  const trimmed = text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  return trimmed === "" ? null : trimmed;
}

interface LotTemplate {
  id: string;
  lotNumberSourceId?: string | null | undefined;
}

/** The lot-enabled variant of an eligible stock template, or the original choice. */
export function lotTemplateId<T extends string | null>(
  selected: T,
  templates: readonly LotTemplate[],
): string | T {
  if (selected === null || selected === "") return selected;
  return templates.find((template) => template.lotNumberSourceId === selected)?.id ?? selected;
}

/** Offer the stock revision intended for this shift alongside the user templates. */
export function lotTemplateChoices<T extends LotTemplate>(
  templates: readonly T[],
  hasLot: boolean,
  selected?: string | null,
): T[] {
  if (!hasLot) {
    const available = new Set(templates.map((template) => template.id));
    return templates.filter(
      (template) =>
        template.lotNumberSourceId == null ||
        template.id === selected ||
        !available.has(template.lotNumberSourceId),
    );
  }
  const superseded = new Set(templates.map((template) => template.lotNumberSourceId));
  return templates.filter((template) => !superseded.has(template.id));
}
