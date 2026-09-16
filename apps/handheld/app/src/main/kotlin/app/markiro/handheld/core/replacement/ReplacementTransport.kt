package app.markiro.handheld.core.replacement

import app.markiro.handheld.core.grants.grantOwnerKey
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

internal suspend fun replacementIfAvailable(block: suspend () -> Unit): Boolean = try {
    block(); true
} catch (cancelled: CancellationException) { throw cancelled }
  catch (_: java.io.IOException) { false }
  catch (_: retrofit2.HttpException) { false }
  catch (_: IllegalArgumentException) { false }
  catch (_: IllegalStateException) { false }

class ReplacementTransport(private val db: HandheldDatabase, private val api: StationApi) {
    suspend fun refresh() = db.recovery.work {
        val token = db.recovery.token()
        val local = ReplacementReadiness(db)
        val row = db.replacementDao().get()
        require(row == null || row.ownerKey == token.owner.grantOwnerKey() && (row.generation == token.generation || !row.blocked)) {
            "Replacement evidence belongs to an earlier credential"
        }
        // A lost report response must not prevent fetching an authoritative cancellation.
        if (row?.generation == token.generation && row.reportJson != null) replacementIfAvailable {
            val body = Json.parseToJsonElement(row.reportJson).jsonObject
            local.acknowledgeReport(token,body,api.replacementReadiness(body))
        }
        val known = row?.takeIf { it.generation == token.generation }?.intentJson?.let { Json.parseToJsonElement(it).jsonObject.text("intentId") }
        local.apply(token,api.replacementIntent(known))
        local.pendingClosure(token)?.let { body ->
            local.acknowledgeClosure(token,body,api.replacementAcknowledge(body))
        }
        if (db.replacementDao().get()?.state == "active") {
            val body = local.prepareReport(token)
            local.acknowledgeReport(token,body,api.replacementReadiness(body))
        }
    }
}
