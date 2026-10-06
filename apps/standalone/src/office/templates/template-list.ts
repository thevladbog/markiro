import type { LabelTemplate, LabelTemplateSummary, TemplatePurpose } from "../../host/protocol.js";
import { byNameThenId } from "../records.js";

/** What the purpose filter keeps. */
export type TemplatePurposeFilter = "all" | TemplatePurpose;

/** What the state filter keeps: every template, the enabled ones or the disabled ones. */
export type TemplateStateFilter = "all" | "enabled" | "disabled";

/** Whether a template's name holds the search, without case; a blank search matches every template. */
export function matchesTemplateSearch(
  template: Pick<LabelTemplateSummary, "name">,
  search: string,
): boolean {
  const text = search.trim().toLocaleLowerCase("ru");
  return text === "" || template.name.toLocaleLowerCase("ru").includes(text);
}

/** The templates the search and both filters keep, in the order given. */
export function findTemplates<T extends LabelTemplateSummary>(
  templates: readonly T[],
  search: string,
  purpose: TemplatePurposeFilter,
  state: TemplateStateFilter,
): T[] {
  return templates.filter(
    (template) =>
      (purpose === "all" || template.purpose === purpose) &&
      (state === "all" || template.enabled === (state === "enabled")) &&
      matchesTemplateSearch(template, search),
  );
}

/**
 * Templates by name with numbers by value («Коробка 58×40» before «Коробка
 * 100×100»), then by id so equal names keep one order (`byNameThenId`). The
 * host sorts bytewise, and a write changes the cached list in place, so a page
 * sorts what it shows itself.
 */
export function templatesByName<T extends Pick<LabelTemplateSummary, "id" | "name">>(
  templates: readonly T[],
): T[] {
  return [...templates].sort(byNameThenId);
}

/**
 * `list` with a template a write returned merged into its summary: the name,
 * the flag, the categories, `stock` and the revision come from the template;
 * the size, the resolution and the language stay, since switching a template
 * or changing its categories never touches the layout, and the layout itself
 * is no part of a summary. The summary keeps its position; a template the list
 * lacks changes nothing. A new array; neither argument is changed.
 */
export function withTemplateChange(
  list: readonly LabelTemplateSummary[],
  template: LabelTemplate,
): LabelTemplateSummary[] {
  return list.map((summary) =>
    summary.id === template.id
      ? {
          ...summary,
          name: template.name,
          enabled: template.enabled,
          chzProductGroupCodes: template.chzProductGroupCodes,
          stock: template.stock,
          rev: template.rev,
        }
      : summary,
  );
}
