package app.markiro.handheld.core.storage

/** Brief 07: a revoked or unbound device drops its credential and cache and returns to pairing. */
class DeviceWipe(
    private val config: DeviceConfigDao,
    private val operators: OperatorDao,
    private val credential: CredentialStore,
) {
    suspend fun wipeAll() {
        credential.clear()
        operators.clear()
        config.clear()
    }
}
