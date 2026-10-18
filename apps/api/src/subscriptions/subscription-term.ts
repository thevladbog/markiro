/**
 * The one definition of "inside its term" for a subscription, an add-on or an
 * entitlement source: started (`startsAt` null counts as started) and not yet
 * ended (`endsAt` is exclusive). The entitlement projection, the effective
 * subscription lookup and the cabinet grant all judge time through it.
 */
export interface Term {
  startsAt: Date | null;
  endsAt: Date | null;
}

export function termContains(term: Term, at: Date): boolean {
  return (
    (term.startsAt === null || term.startsAt.getTime() <= at.getTime()) &&
    (term.endsAt === null || term.endsAt.getTime() > at.getTime())
  );
}

export function termEnded(term: Term, at: Date): boolean {
  return term.endsAt !== null && term.endsAt.getTime() <= at.getTime();
}
