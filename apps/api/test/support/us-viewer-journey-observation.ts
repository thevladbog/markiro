const checkpoints = [
  "preflight-snapshots",
  "preflight-authfacts",
  "preflight-privatebytes",
  "signin-page",
  "signin-submit",
  "mfa-enroll",
  "mfa-key",
  "mfa-verify",
  "organization",
  "authenticated-facts",
  "postauth-invariance",
  "reference-navigation",
  "first-events",
  "next-events",
  "readonly-controls",
  "lot-search",
  "lot-card-history",
  "regular-lot",
  "backward-trace",
  "forward-trace",
  "correction-history",
  "orphan-history",
  "readiness",
  "plan-download",
  "request-frozenrun",
  "request-detail",
  "browser-zip",
  "individual-artifact",
  "ui-variants",
  "audit-correlation",
  "business-provider-invariance",
  "privatebyte-invariance",
  "final-budget",
] as const;

/** Test-only failure witness. Never inspect or retain the caught value. */
export function observeViewerJourney<T>(
  emit: (line: string) => void,
  action: (enter: (value: unknown) => void) => Promise<T>,
): () => Promise<T> {
  return Object.freeze(async () => {
    let checkpoint = 0;
    let sealed = false;
    const enter = (value: unknown) => {
      if (sealed) return;
      checkpoint =
        typeof value === "string" ? checkpoints.findIndex((name) => name === value) + 1 : 0;
    };
    try {
      return await action(enter);
    } catch (error) {
      sealed = true;
      try {
        emit(`US_DEMO_VIEWER_JOURNEY_OBSERVATION ${JSON.stringify({ checkpoint })}`);
      } catch {
        // A diagnostic sink must never replace the original failure.
      }
      throw error;
    } finally {
      sealed = true;
    }
  });
}
