export type TeamActorRole = "owner" | "admin" | "manager" | "member";
export type AssignableTeamRole = "admin" | "manager";

export interface TeamMutationTarget {
  actorId: string;
  actorRole: TeamActorRole;
  targetId: string;
  targetRole: TeamActorRole;
}

export function canMutateTeamTarget(target: TeamMutationTarget): boolean {
  if (target.actorRole !== "owner" && target.actorRole !== "admin") return false;
  if (target.actorId === target.targetId) return false;
  return target.targetRole !== "owner";
}

export function canAssignTeamRole(actorRole: TeamActorRole, nextRole: AssignableTeamRole): boolean {
  if (actorRole !== "owner" && actorRole !== "admin") return false;
  return nextRole === "admin" || nextRole === "manager";
}
