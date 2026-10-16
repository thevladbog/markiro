import { HostError } from "../../host/client.js";
import { AVATAR_MAX_BYTES, AVATAR_MAX_SIDE, AVATAR_MIN_SIDE } from "../../host/protocol.js";
import type { OfficeRole } from "../../host/protocol.js";

/** What can be wrong with a picked file, each with its text under `office.profile.photo.problems`. */
export type AvatarProblem =
  | "unsupportedType"
  | "tooLarge"
  | "tooSmall"
  | "tooBig"
  | "notSquare"
  | "unreadable"
  | "rateLimited"
  | "forbidden"
  | "generic";

const ACCEPTED_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/** What the picker offers. */
export const AVATAR_ACCEPT = ACCEPTED_TYPES.join(",");

/** The picked file as the host's rules read it, before a byte of it is decoded. */
export function checkAvatarFile(file: { type: string; size: number }): AvatarProblem | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "unsupportedType";
  if (file.size > AVATAR_MAX_BYTES) return "tooLarge";
  return null;
}

/** The decoded picture's sides: from 128 up to 4096 each. */
export function checkAvatarDimensions(width: number, height: number): AvatarProblem | null {
  if (!(width > 0) || !(height > 0)) return "unreadable";
  if (width < AVATAR_MIN_SIDE || height < AVATAR_MIN_SIDE) return "tooSmall";
  if (width > AVATAR_MAX_SIDE || height > AVATAR_MAX_SIDE) return "tooBig";
  return null;
}

const PROBLEM_OF_CODE: Readonly<Record<string, AvatarProblem>> = {
  avatar_too_large: "tooLarge",
  avatar_unsupported_type: "unsupportedType",
  avatar_too_small: "tooSmall",
  avatar_dimensions_too_large: "tooBig",
  avatar_not_square: "notSquare",
  avatar_corrupt: "unreadable",
  rate_limited: "rateLimited",
  forbidden_replace_other: "forbidden",
  forbidden: "forbidden",
};

/** The problem a failed photo write comes to. */
export function avatarProblemOfError(error: unknown): AvatarProblem {
  if (error instanceof HostError && error.kind === "api") {
    return PROBLEM_OF_CODE[error.code] ?? "generic";
  }
  return "generic";
}

interface Viewer {
  id: string;
  role: OfficeRole;
}

/** Only the owner uploads or replaces a photo; the host refuses everyone else, an administrator too. */
export function canReplaceAvatar(viewer: Viewer, targetId: string): boolean {
  return viewer.id === targetId;
}

/** The owner removes their own photo; an administrator removes anyone's (never replaces it). */
export function canDeleteAvatar(viewer: Viewer, targetId: string, hasPhoto: boolean): boolean {
  if (!hasPhoto) return false;
  return viewer.id === targetId || viewer.role === "admin";
}

/**
 * A host before the photos has no route to answer: the read is `not_found` (a user that exists
 * without a photo answers `{avatar: null}`, and the raw route's missing photo is `avatar_not_found`).
 */
export function isAvatarUnsupported(error: unknown): boolean {
  return error instanceof HostError && error.kind === "api" && error.code === "not_found";
}
