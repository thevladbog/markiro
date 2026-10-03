import {
  buildLocationDescriptionSnapshot,
  validateUsPlanApproval,
  type UsPlanApprovalInput,
  type UsPlanConfiguredFacts,
} from "@markiro/domain";

/** Complete business rules shared by capture, validation and preview. */
export function validateUsPlanSavedContent(
  input: UsPlanApprovalInput,
  facts: UsPlanConfiguredFacts,
  mode: "approval" | "preview" = "approval",
) {
  // Preview does not confer confirmation authority. Keep all actual assertions
  // false and exclude only approval-specific confirmation findings from rendering.
  const issues = validateUsPlanApproval(input).filter(
    (issue) => mode !== "preview" || issue.code !== "confirmation_required",
  );
  for (const location of facts.tlcSourceLocations) {
    if (!buildLocationDescriptionSnapshot({ id: location.id, ...location.description }).ok)
      issues.push({
        section: "tlcAssignment",
        path: `tlcSourceLocations.${location.id}`,
        code: "tlc_source_location_incomplete",
      });
  }
  return issues;
}
