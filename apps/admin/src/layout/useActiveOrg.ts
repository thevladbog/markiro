import { useAuthClient } from "../auth/client.js";

export interface ActiveOrg {
  orgId: string | null;
  orgName: string | null;
}

/**
 * Resolves the active organization's id (from the session) and display name
 * (from the org list) for the header/sidebar.
 *
 * Org-name source: uses `authClient.useListOrganizations()` -- the React
 * hook Better Auth's `organizationClient()` plugin actually exposes (see the
 * doc comment on `AuthClientLike.useListOrganizations` in `src/auth/
 * client.ts`, verified against the installed package's `.d.mts` files, not
 * assumed) -- rather than a one-shot `authClient.organization.list()` fetch
 * (the pattern `pages/auth/SelectOrgPage.tsx` uses). The hook keeps this
 * reactive to the session's `activeOrganizationId` and to the org list
 * itself, so the header updates immediately after `SelectOrgPage` activates
 * a different organization, with no extra effect/state here.
 *
 * `orgName` is `null` (not an error) while the org list is still loading or
 * doesn't (yet) contain the active org id -- callers render a fallback.
 */
export function useActiveOrg(): ActiveOrg {
  const authClient = useAuthClient();
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();

  const orgId = session?.session.activeOrganizationId ?? null;
  const orgName = (orgId && organizations?.find((org) => org.id === orgId)?.name) || null;

  return { orgId, orgName };
}
