package app.markiro.handheld.core.storage

/** Legacy lifecycle adapter. Credential rejection always identifies its originating generation. */
class DeviceWipe(private val recovery: DeviceRecovery) {
    suspend fun reject(token: GenerationToken): Boolean = recovery.reject(token)
}
