import type { ImportDecision, ImportPreview } from "@markiro/platform-contracts";
export interface ReviewChoice {
  decision: ImportDecision;
  photoExplicit: boolean;
  replaceConfirmed: boolean;
  viewedCandidateIds: string[];
}
export function initialChoice(preview: ImportPreview): ReviewChoice {
  const photo = !preview.productId
    ? preview.photos.find((p) => p.state === "ready" && p.selectedByDefault && p.reason === null)
    : undefined;
  return {
    decision: {
      previewId: preview.id,
      acceptedEntryIds: preview.fields
        .filter((f) => f.applicable && !preview.productId && f.selectedByDefault)
        .map((f) => f.id),
      linkAction: preview.linkAction,
      photo: photo ? { kind: "candidate", candidateId: photo.candidateId } : { kind: "keep" },
    },
    photoExplicit: false,
    replaceConfirmed: false,
    viewedCandidateIds: [],
  };
}
export function currentChoice(
  preview: ImportPreview,
  stored: ReviewChoice | undefined,
): ReviewChoice {
  if (!stored) return initialChoice(preview);
  if (stored.photoExplicit || preview.productId) return stored;
  const photo = preview.photos.find(
    (p) => p.state === "ready" && p.selectedByDefault && p.reason === null,
  );
  return photo
    ? {
        ...stored,
        decision: {
          ...stored.decision,
          photo: { kind: "candidate", candidateId: photo.candidateId },
        },
      }
    : stored;
}
export function keepPhoto(choice: ReviewChoice): ReviewChoice {
  const reviewedCandidateId = choice.viewedCandidateIds.at(-1);
  return {
    ...choice,
    photoExplicit: true,
    decision: {
      ...choice.decision,
      photo: reviewedCandidateId ? { kind: "keep", reviewedCandidateId } : { kind: "keep" },
    },
  };
}
export function selectionWithPage(
  selected: string[],
  ids: string[],
  checked: boolean,
): string[] | null {
  const next = checked
    ? [...new Set([...selected, ...ids])]
    : selected.filter((id) => !ids.includes(id));
  return next.length <= 100 ? next : null;
}

/** Removing a prerequisite also removes dependent choices, never auto-selects it. */
export function toggleField(
  preview: ImportPreview,
  choice: ReviewChoice,
  fieldId: string,
  checked: boolean,
): ReviewChoice {
  const field = preview.fields.find((f) => f.id === fieldId);
  if (!field?.applicable) return choice;
  const accepted = new Set(choice.decision.acceptedEntryIds);
  if (checked) {
    if (!field.requiresEntryIds.every((id) => accepted.has(id))) return choice;
    accepted.add(fieldId);
  } else accepted.delete(fieldId);
  let removed = true;
  while (removed) {
    removed = false;
    for (const f of preview.fields) {
      if (accepted.has(f.id) && f.requiresEntryIds.some((id) => !accepted.has(id))) {
        accepted.delete(f.id);
        removed = true;
      }
    }
  }
  return { ...choice, decision: { ...choice.decision, acceptedEntryIds: [...accepted] } };
}
