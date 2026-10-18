/**
 * Support chats are switched off in the platform console for now. The pages,
 * API client and tests stay in the tree; flipping this to `true` registers the
 * `/support` routes again and returns the rail entry. Nothing else links to
 * them, so the flag is the only switch.
 */
export const SUPPORT_CHAT_ENABLED = false as boolean;
