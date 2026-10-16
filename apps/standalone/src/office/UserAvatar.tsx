import { avatarTone, userInitials } from "./user-avatar.js";

export interface UserAvatarProps {
  name: string;
  /** The circle's diameter in px: 32 on the top bar's trigger, 40 in the menu's header. */
  size?: 32 | 40;
}

/**
 * A person's avatar: a circle with their initials on the tone their name fixes. Decorative — the
 * name stands beside it. (A photo replaces the initials in a later phase.)
 */
export function UserAvatar({ name, size = 32 }: UserAvatarProps) {
  return (
    <span
      className={`user-avatar user-avatar--${avatarTone(name)} user-avatar--${size}`}
      aria-hidden="true"
    >
      {userInitials(name)}
    </span>
  );
}
