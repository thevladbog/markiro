import type { ImportDecision, ImportPreview } from "@markiro/platform-contracts";
export interface ReviewChoice {
  decision: ImportDecision;
  photoExplicit: boolean;
  replaceConfirmed: boolean;
  loadedCandidateIds: string[];
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
    loadedCandidateIds: [],
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

/** Carry only the same reviewed values onto a newly prepared snapshot. */
export function reconcileChoice(
  preview: ImportPreview,
  previous: ImportPreview,
  choice: ReviewChoice,
): ReviewChoice {
  if (preview.id === previous.id) return currentChoice(preview, choice);
  if (
    preview.itemId !== previous.itemId ||
    preview.productId !== previous.productId ||
    preview.identity.cardId !== previous.identity.cardId ||
    preview.identity.gtin14 !== previous.identity.gtin14 ||
    preview.linkAction !== previous.linkAction
  )
    return {
      ...initialChoice(preview),
      decision: {
        ...initialChoice(preview).decision,
        acceptedEntryIds: [],
        photo: { kind: "keep" },
      },
    };

  const matched = new Map<string, string>();
  for (const field of preview.fields) {
    const candidates = previous.fields.filter(
      (old) =>
        old.labelKey === field.labelKey &&
        old.label === field.label &&
        old.before === field.before &&
        old.after === field.after &&
        old.source === field.source &&
        old.applicable === field.applicable &&
        old.reason === field.reason &&
        (field.labelKey !== "category" ||
          JSON.stringify(
            previous.categoryOptions
              .filter((o) => o.selected)
              .map((o) => o.optionId)
              .sort(),
          ) ===
            JSON.stringify(
              preview.categoryOptions
                .filter((o) => o.selected)
                .map((o) => o.optionId)
                .sort(),
            )),
    );
    if (candidates.length === 1 && candidates[0]) matched.set(field.id, candidates[0].id);
  }
  const oldMatches = [...matched.values()];
  for (const [newId, oldId] of matched) {
    if (oldMatches.filter((id) => id === oldId).length > 1) matched.delete(newId);
  }
  // A changed or removed prerequisite invalidates every dependent choice.
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of preview.fields) {
      const old = previous.fields.find((f) => f.id === matched.get(field.id));
      if (
        old &&
        (old.requiresEntryIds.length !== field.requiresEntryIds.length ||
          field.requiresEntryIds.some(
            (id) => !old.requiresEntryIds.includes(matched.get(id) ?? ""),
          ))
      ) {
        matched.delete(field.id);
        changed = true;
      }
    }
  }
  const photo = choice.decision.photo;
  const available = (id: string) =>
    preview.photos.some(
      (p) =>
        p.candidateId === id &&
        p.state === "ready" &&
        (p.reason === null || p.reason === "barcode_mismatch"),
    );
  return {
    ...choice,
    // A new snapshot does not expose the current link revision, so its
    // replacement must be acknowledged again even if the target card matches.
    replaceConfirmed: false,
    photoExplicit: true,
    loadedCandidateIds: choice.loadedCandidateIds.filter(available),
    decision: {
      previewId: preview.id,
      linkAction: preview.linkAction,
      acceptedEntryIds: preview.fields
        .filter(
          (f) => f.applicable && choice.decision.acceptedEntryIds.includes(matched.get(f.id) ?? ""),
        )
        .map((f) => f.id),
      photo:
        photo.kind === "candidate"
          ? available(photo.candidateId)
            ? photo
            : { kind: "keep" }
          : photo.reviewedCandidateId && available(photo.reviewedCandidateId)
            ? photo
            : { kind: "keep" },
    },
  };
}
export function keepPhoto(choice: ReviewChoice): ReviewChoice {
  const photo = choice.decision.photo;
  // Automatic image loads must not choose the source baseline. Retain only the
  // candidate explicitly selected by the user and successfully displayed.
  const reviewedCandidateId =
    photo.kind === "candidate"
      ? choice.photoExplicit && choice.loadedCandidateIds.includes(photo.candidateId)
        ? photo.candidateId
        : undefined
      : photo.reviewedCandidateId;
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
