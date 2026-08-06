import type { OperatorMirrorRecord } from "@markiro/db";

export interface OperatorSearchResult {
  operatorId: string;
  name: string;
  login: string;
}

/** Normalizes only presentation text; operator logins are never normalized here. */
export function normalizeOperatorNameQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Returns a credential-free, deterministic and display-bounded view of the
 * offline roster. Name selection identifies an exact login; authentication
 * still happens later through verifyOperatorPin.
 */
export function searchOperatorsByName(
  operators: readonly OperatorMirrorRecord[],
  query: string,
): OperatorSearchResult[] {
  const normalizedQuery = normalizeOperatorNameQuery(query);
  const letterCount = Array.from(normalizedQuery).filter((character) =>
    /\p{L}/u.test(character),
  ).length;
  if (letterCount < 2) return [];

  const queryTokens = normalizedQuery.split(" ");
  return operators
    .filter((operator) => {
      if (!operator.active || !/^\d{3,12}$/.test(operator.login)) return false;
      const normalizedName = normalizeOperatorNameQuery(operator.name);
      let fromIndex = 0;
      return queryTokens.every((token) => {
        const index = normalizedName.indexOf(token, fromIndex);
        if (index < 0) return false;
        fromIndex = index + token.length;
        return true;
      });
    })
    .sort((left, right) => {
      const byName = compareText(
        normalizeOperatorNameQuery(left.name),
        normalizeOperatorNameQuery(right.name),
      );
      return byName || compareText(left.operatorId, right.operatorId);
    })
    .slice(0, 5)
    .map(({ operatorId, name, login }) => ({ operatorId, name, login }));
}
