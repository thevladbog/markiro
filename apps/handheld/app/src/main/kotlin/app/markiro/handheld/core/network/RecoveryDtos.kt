package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject

@Serializable
data class RecoveryIdentity(val tenantId: String, val deviceId: String, val kind: String)
@Serializable
data class RecoveryRequest(val version: Int, val code: String, val expected: RecoveryIdentity) {
    fun validate(): RecoveryRequest {
        require(version == 1 && Regex("[0-9]{8}").matches(code))
        require(expected.tenantId.isNotEmpty() && expected.kind in setOf("station", "handheld") && RecoveryResponse.UUID_PATTERN.matches(expected.deviceId))
        return this
    }
}
@Serializable
data class RecoveryDevice(val id: String, val name: String, val kind: String, val tenantId: String,
    val organizationName: String, val line: LineDto?)
@Serializable
data class RecoveryOperator(val operatorId: String, val name: String, val login: String, val role: String,
    val pinHash: String, val badgeHash: String?, val active: Boolean)
@Serializable
data class RecoverySubscription(val access: String, val status: String, val startsAt: String?, val endsAt: String?)
@Serializable
data class RecoveryResponse(val version: Int, val device: RecoveryDevice, val credential: CredentialDto,
    val operators: List<RecoveryOperator>, val subscription: RecoverySubscription? = null) {
    fun validate(): RecoveryResponse {
        require(version == 1 && device.kind in setOf("station", "handheld") && device.tenantId.isNotEmpty())
        require(UUID_PATTERN.matches(device.id) && (device.line == null || UUID_PATTERN.matches(device.line.id)))
        require(credential.apiKey.isNotEmpty() && java.net.URI(credential.serverUrl).isAbsolute)
        subscription?.let {
            require(it.access in setOf("managed", "read_only", "unmanaged"))
            require(it.status in setOf("unmanaged", "pending_activation", "trial", "active", "expired", "read_only"))
            it.startsAt?.let(java.time.Instant::parse)
            it.endsAt?.let(java.time.Instant::parse)
        }
        return this
    }
    fun pairing() = PairResponse(DeviceDto(device.id, device.name, device.kind, device.tenantId, device.organizationName, device.line),
        credential, operators.map { OperatorDto(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) })
    companion object {
        val UUID_PATTERN = Regex("([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)")
        val json = Json { ignoreUnknownKeys = false; explicitNulls = true; encodeDefaults = true }
        fun decode(text: String): RecoveryResponse {
            val payload = json.parseToJsonElement(text)
            require(payload.jsonObject["subscription"] != JsonNull)
            return json.decodeFromJsonElement(serializer(), payload).validate()
        }
    }
}
