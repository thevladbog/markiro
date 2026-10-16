import { useQueryClient } from "@tanstack/react-query";

import type { UserAvatarState } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { isAvatarUnsupported } from "./avatar-rules.js";

/** A photo as an `<img>`'s source. */
export function avatarSrc(avatar: { mediaType: string; dataBase64: string }): string {
  return `data:${avatar.mediaType};base64,${avatar.dataBase64}`;
}

/** What the office knows of a user's photo. */
export type AvatarPhoto =
  | { status: "loading" }
  /** No photo; `failed` when the read itself failed (the initials stay, the profile says so). */
  | { status: "none"; failed?: boolean }
  /** A host before the photos: no route, so the profile hides its upload. */
  | { status: "unsupported" }
  | { status: "photo"; src: string; version: number };

/**
 * A user's photo, read once per `avatarVersion` and kept for the session (a changed photo has a new
 * version, hence a new key). A user without a version (none, or a host before the photos) is not
 * read at all unless `force`: the profile dialog asks anyway, to tell «no photo» from «no feature».
 * A `not_found` answer is that old host's missing route: no photo, nothing thrown. Any other
 * failure leaves the initials in place.
 */
export function useUserAvatarPhoto(
  userId: string | null,
  version: number | null | undefined,
  force = false,
): AvatarPhoto {
  const wanted = userId !== null && (force || (version !== null && version !== undefined));
  const query = useOfficeQuery<UserAvatarState | "unsupported">(
    officeKeys.userAvatar(userId ?? "", version ?? 0),
    async (api, token) => {
      try {
        return await api.getUserAvatar(token, userId ?? "");
      } catch (error) {
        if (isAvatarUnsupported(error)) return "unsupported";
        throw error;
      }
    },
    { enabled: wanted, staleTime: Infinity },
  );
  if (!wanted) return { status: "none" };
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "none", failed: true };
  if (query.data === "unsupported") return { status: "unsupported" };
  const avatar = query.data.avatar;
  if (avatar === null) return { status: "none" };
  return { status: "photo", src: avatarSrc(avatar), version: avatar.version };
}

/** Writes the answer of a photo write into the cache under its version, so nothing reads it again. */
export function useStoreAvatar(): (userId: string, state: UserAvatarState) => void {
  const queryClient = useQueryClient();
  return (userId, state) => {
    if (state.avatar !== null) {
      queryClient.setQueryData(officeKeys.userAvatar(userId, state.avatar.version), state);
    }
    void queryClient.invalidateQueries({ queryKey: officeKeys.users, exact: true });
  };
}
