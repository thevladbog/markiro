/**
 * Typed fetchers + TanStack Query hooks for the label-templates endpoints
 * (Plan 04 Task 6: `GET /label-templates`, `GET /label-templates/:id`).
 * Thin wrapper over `../../api/client.ts`'s `apiFetch` -- see that module
 * for the shared base URL, credentials, and error-message parsing.
 *
 * `LabelTemplateSummaryDto` mirrors `apps/api/src/modules/label-templates/
 * dto.ts`'s `LabelTemplateSummaryDto` -- the list endpoint deliberately
 * projects away `spec` (avoids shipping every template's full element tree
 * to the library screen). `LabelTemplateDto` mirrors that same module's
 * full response DTO (`GET /:id`, also `POST`/`PATCH` -- not used by this
 * task, added for `TemplateThumb.tsx` and, later, Task 10's editor).
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import type { LabelTemplateSpec } from "@markiro/domain";

import { apiFetch } from "../../api/client.js";

export interface LabelTemplateSummaryDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  language: "zpl" | "tspl";
  updatedAt: string;
}

export interface LabelTemplateDto {
  id: string;
  name: string;
  spec: LabelTemplateSpec;
  createdAt: string;
  updatedAt: string;
}

interface ListLabelTemplatesResponse {
  items: LabelTemplateSummaryDto[];
}

/** Shared TanStack Query cache key for the label-templates list. */
export const LABEL_TEMPLATES_QUERY_KEY = ["label-templates"] as const;

async function fetchLabelTemplates(): Promise<LabelTemplateSummaryDto[]> {
  const response = await apiFetch<ListLabelTemplatesResponse>("/label-templates");
  return response.items;
}

function fetchLabelTemplate(id: string): Promise<LabelTemplateDto> {
  return apiFetch<LabelTemplateDto>(`/label-templates/${id}`);
}

/** `GET /label-templates` -- the active tenant's label template summaries. */
export function useLabelTemplates(): UseQueryResult<LabelTemplateSummaryDto[]> {
  return useQuery({ queryKey: LABEL_TEMPLATES_QUERY_KEY, queryFn: fetchLabelTemplates });
}

/**
 * `GET /label-templates/:id` -- a single template's FULL spec.
 *
 * DESIGN DECISION (Plan 04 Task 8 brief): `GET /label-templates` summaries
 * carry no `spec` at all, but rendering a library thumbnail needs the full
 * spec. Fetching every card's full template eagerly from the list screen
 * would be N+1 against the summary endpoint; instead each card mounts its
 * OWN `useLabelTemplate(id)` (see `TemplateThumb.tsx`), one query per
 * visible card. TanStack Query still de-dupes/caches per `queryKey`, so
 * re-mounting a card (e.g. list re-render) or opening that template's
 * editor (Task 10, same `GET /:id`) reuses the same cache entry rather than
 * re-fetching. Acceptable at library scale (dozens of templates per
 * tenant); revisit (e.g. a bulk "specs for these ids" endpoint) if/when
 * tenants reach hundreds of templates.
 */
export function useLabelTemplate(id: string): UseQueryResult<LabelTemplateDto> {
  return useQuery({
    queryKey: [...LABEL_TEMPLATES_QUERY_KEY, id],
    queryFn: () => fetchLabelTemplate(id),
  });
}
