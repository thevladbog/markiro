package app.markiro.handheld.feature.signin

/** What the sign-in screen needs of the roster's refresh: read it again, and when it was last read. */
interface RosterSource {
    /** `true` when the host (or the cloud) answered and the mirror is current; a failure keeps the previous roster. */
    suspend fun refreshRoster(): Boolean

    suspend fun rosterFetchedAt(): Long?
}
