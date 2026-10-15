package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.OrgPrintDto
import app.markiro.handheld.core.storage.MetaStore
import kotlinx.serialization.json.Json

/**
 * The organization's print identity from the host (`GET /v1/device/org/print`: the full name, the issuer prefix, the print logo): read at every
 * entry into a shift and kept, so a label printed with the host out of reach carries the last name and logo the host gave. A failed read
 * answers the kept copy; with none kept, it answers the failure.
 */
class HostOrgPrint(private val api: HostApi, private val meta: MetaStore, private val json: Json = Json { ignoreUnknownKeys = true }) {
    suspend fun fetch(): Result<OrgPrintDto> {
        val fresh = api.orgPrint()
        fresh.onSuccess { meta.put(KEY, json.encodeToString(OrgPrintDto.serializer(), it)) }
        return fresh.recoverCatching { error -> cached() ?: throw error }
    }

    suspend fun cached(): OrgPrintDto? = meta.get(KEY)?.let { runCatching { json.decodeFromString(OrgPrintDto.serializer(), it) }.getOrNull() }

    companion object {
        const val KEY = "host_org_print"
    }
}
