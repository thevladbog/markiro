package app.markiro.handheld.core.network.host

enum class HostCompatibility { COMPATIBLE, HOST_TOO_OLD, APP_TOO_OLD }

/** `markiro_proto::compatibility_for`: who must update, decided from the `hello` envelope before anything else is read. */
object HostCompat {
    /** The protocol this build speaks (`PROTOCOL_VERSION` of the host crate). */
    const val PROTOCOL = 6

    /** The oldest protocol this build still speaks to (`MIN_PROTOCOL_VERSION`). */
    const val MIN_PROTOCOL = 1

    fun decide(clientProtocol: Int, hostProtocol: Int, hostMinProtocol: Int): HostCompatibility = when {
        clientProtocol > hostProtocol -> HostCompatibility.HOST_TOO_OLD
        clientProtocol < hostMinProtocol -> HostCompatibility.APP_TOO_OLD
        else -> HostCompatibility.COMPATIBLE
    }
}
