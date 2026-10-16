import { useUserAvatarPhoto } from "./avatar/avatar-photo.js";
import { avatarTone, userInitials } from "./user-avatar.js";

/** The diameters of the kit's avatar (px): 20 in a line of text, 96 in the profile. */
export type AvatarSize = 20 | 24 | 32 | 40 | 48 | 96;

export interface UserAvatarProps {
  name: string;
  size?: AvatarSize;
  /**
   * With the user's id and `avatarVersion` the avatar shows their photo (read once per version, the
   * office's session cache); without them, or without a photo, their initials.
   */
  userId?: string;
  avatarVersion?: number | null | undefined;
  /** A name for a screen reader where no name stands beside the avatar: «Фото: Иван Петров». */
  label?: string | undefined;
}

function Initials({
  name,
  size,
  label,
}: Required<Pick<UserAvatarProps, "name" | "size">> & { label?: string | undefined }) {
  return (
    <span
      className={`user-avatar user-avatar--${avatarTone(name)} user-avatar--${size}`}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {userInitials(name)}
    </span>
  );
}

function PhotoAvatar({
  name,
  size,
  userId,
  avatarVersion,
  label,
}: Required<Pick<UserAvatarProps, "name" | "size" | "userId">> &
  Pick<UserAvatarProps, "avatarVersion" | "label">) {
  const photo = useUserAvatarPhoto(userId, avatarVersion);
  if (photo.status !== "photo") return <Initials name={name} size={size} label={label} />;
  return (
    <img
      className={`user-avatar user-avatar--photo user-avatar--${size}`}
      src={photo.src}
      alt={label ?? ""}
      width={size}
      height={size}
      draggable={false}
    />
  );
}

/**
 * A person's avatar: a circle with their photo, or their initials on the tone their name fixes.
 * Decorative where their name stands beside it; give `label` where it does not.
 */
export function UserAvatar({ name, size = 32, userId, avatarVersion, label }: UserAvatarProps) {
  if (userId === undefined || avatarVersion === null || avatarVersion === undefined) {
    return <Initials name={name} size={size} label={label} />;
  }
  return (
    <PhotoAvatar
      name={name}
      size={size}
      userId={userId}
      avatarVersion={avatarVersion}
      label={label}
    />
  );
}
