package app.markiro.handheld.core.host

import app.markiro.handheld.core.backend.NoBackend
import app.markiro.handheld.core.backend.StationBackend
import app.markiro.handheld.core.network.BoxRegistryItemDto
import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.pallets.BoxRegistryMirror
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.writeoff.MirrorOutcome
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant

@Serializable
private data class HostRegistryItem(
    val kind: String,
    val sscc: String,
    val updatedAt: String,
    val boxId: String? = null,
    val productId: String? = null,
    val bottleCount: Int? = null,
    val palletId: String? = null,
    val palletSscc: String? = null,
    val palletActive: Boolean? = null,
    val closedAt: String? = null,
    val productionDate: String? = null,
)

@Serializable
private data class HostRegistryPage(
    val until: String,
    val items: List<HostRegistryItem> = emptyList(),
    val nextCursor: String? = null,
    val restoreEpoch: String? = null,
)

/**
 * The registry of closed boxes from the host (`GET /v1/device/box-registry`), in the shape the cloud's mirror reads, so `BoxRegistryMirror` does
 * the walk itself: the pages by cursor, the mark moved only after the last page, the device's own claims carried across a full walk. What is
 * the host's here:
 * - the window of the delta starts a second before the last mark (the host stamps in whole seconds; a change made in the same second the
 *   walk was cut would otherwise be missed) and rows are `INSERT OR REPLACE`, so the overlap costs nothing;
 * - the host has no contents of a box, so a row carries no keys (the write-off mode that reads them does not exist on the host);
 * - a changed `restoreEpoch` (the host was restored from a copy) forgets the mark, so the next walk is a full one that removes what the
 *   restored host no longer holds. [guardEpoch] asks before the walk and does that.
 */
class HostBoxRegistry(private val db: HandheldDatabase, private val meta: MetaStore, private val api: HostApi) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun page(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto {
        val raw = api.boxRegistry(overlapped(since), until, cursor, limit).getOrThrow()
        val page = json.decodeFromJsonElement(HostRegistryPage.serializer(), raw)
        return BoxRegistryPageDto(
            until = page.until,
            items = page.items.map {
                BoxRegistryItemDto(
                    kind = it.kind, sscc = it.sscc, updatedAt = it.updatedAt, boxId = it.boxId, productId = it.productId, bottleCount = it.bottleCount,
                    contentKeys = if (it.kind == "upsert") emptyList() else null, palletId = it.palletId, palletSscc = it.palletSscc,
                    palletActive = it.palletActive, closedAt = it.closedAt, productionDate = it.productionDate,
                )
            },
            nextCursor = page.nextCursor,
        )
    }

    /** One small request before a walk: a restored host (another epoch) makes the walk a full one. The epoch is remembered once the question is answered. */
    suspend fun guardEpoch() {
        val since = meta.get(MetaStore.BOX_REGISTRY_UNTIL)
        val raw = api.boxRegistry(overlapped(since), null, null, 1).getOrThrow()
        val epoch = json.decodeFromJsonElement(HostRegistryPage.serializer(), raw).restoreEpoch ?: return
        val known = meta.get(EPOCH_KEY)
        if (known != null && known != epoch) meta.remove(MetaStore.BOX_REGISTRY_UNTIL)
        if (known != epoch) meta.put(EPOCH_KEY, epoch)
    }

    /** The walk on its own (the pallet mode's bootstrap runs the same through the backend). */
    suspend fun catchUp(): MirrorOutcome {
        val self = this
        val calls = HostCalls { }
        return try {
            calls.run { runCatching { guardEpoch() } }
            val backend = object : StationBackend by NoBackend {
                override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int) =
                    calls.run { runCatching { self.page(since, until, cursor, limit) } }
            }
            BoxRegistryMirror(backend, db, meta).walk()
        } catch (_: java.io.IOException) {
            MirrorOutcome.Offline
        } catch (_: retrofit2.HttpException) {
            MirrorOutcome.Failed("http")
        }
    }

    private fun overlapped(since: String?): String? = since?.let { runCatching { Instant.parse(it).minusSeconds(1).toString() }.getOrDefault(it) }

    companion object {
        const val EPOCH_KEY = "host_registry_epoch"
    }
}
