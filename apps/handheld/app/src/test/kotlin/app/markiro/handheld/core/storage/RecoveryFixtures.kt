package app.markiro.handheld.core.storage

import kotlinx.coroutines.runBlocking

/** Real Room owner bootstrap for existing service tests; production has no permissive test mode. */
fun HandheldDatabase.initializeRecoveryForTest(credential: CredentialStore = InMemoryCredentialStore().apply { write("synthetic-key") }): DeviceRecovery = runBlocking {
    val recovery = DeviceRecovery(this@initializeRecoveryForTest, credential)
    if (deviceConfigDao().get() == null) deviceConfigDao().upsert(syntheticDeviceConfig())
    recovery.initialize()
    recovery
}

fun syntheticDeviceConfig(server: String = "https://admin.markiro.app") = DeviceConfigEntity(
    deviceId = "00000000-0000-4000-8000-000000000001", deviceName = "Synthetic handheld", tenantId = "synthetic-tenant",
    organizationName = "Synthetic", lineId = null, lineName = null, kind = "handheld", serverUrl = server, pairedAt = 1,
)

suspend fun HandheldDatabase.reconnectSameDeviceForTest() {
    val config = checkNotNull(deviceConfigDao().get())
    recovery.restore(app.markiro.handheld.core.network.PairResponse(
        app.markiro.handheld.core.network.DeviceDto(config.deviceId, config.deviceName, config.kind, config.tenantId, config.organizationName),
        app.markiro.handheld.core.network.CredentialDto("restored-synthetic-key", config.serverUrl), emptyList(),
    ), config.serverUrl)
}
