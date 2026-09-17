package app.markiro.handheld.core.writeoff

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.pallets.BoxRegistryMirror
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.WriteoffPermissionEntity
import app.markiro.handheld.core.storage.WriteoffProductEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.IOException

sealed interface MirrorOutcome {
    data object Ok : MirrorOutcome
    /** The server was unreachable. Every cache keeps the values it already held. */
    data object Offline : MirrorOutcome
    data class Failed(val reason: String) : MirrorOutcome
}

/** The box contents the registry listed, as `01…21…` keys. */
fun BoxRegistryEntity.contentKeys(): List<String> =
    runCatching { Json.decodeFromString(KEYS, contentKeysJson) }.getOrDefault(emptyList())

internal val KEYS = ListSerializer(String.serializer())

/**
 * Fills the write-off mode's offline caches: the shared reason dictionary, the
 * tenant catalogue and per-operator permission.
 *
 * The three bootstrap caches are replaced wholesale, because the server's answer
 * IS the current dictionary — an archived reason must disappear from the device,
 * not linger. The closed-box registry the mode reads is a delta instead and is
 * shared with the pallet mode, so it lives in [BoxRegistryMirror]; this refresh
 * ends in that walk.
 */
class WriteoffMirror(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val registry: BoxRegistryMirror,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** When the bootstrap last landed, feeding the mode's «данные на 10:42» stamp. */
    val stampAt: Flow<Long?> = db.metaDao().observe(MetaStore.WRITEOFF_BOOTSTRAP_AT).map { it?.toLongOrNull() }

    suspend fun refresh(): MirrorOutcome = try {
        db.recovery.work { refreshOwned() }
    } catch (_: IOException) {
        MirrorOutcome.Offline
    } catch (_: retrofit2.HttpException) {
        MirrorOutcome.Failed("http")
    } catch (_: SerializationException) {
        MirrorOutcome.Failed("shape")
    }

    private suspend fun refreshOwned(): MirrorOutcome {
        val bootstrap = api.writeoffBootstrap()
        db.recovery.commit {
            db.writeoffReasonDao().replaceAll(bootstrap.reasons.map { WriteoffReasonEntity(it.id, it.name, it.sortOrder) })
            db.writeoffProductDao().replaceAll(bootstrap.products.map { WriteoffProductEntity(it.gtin14, it.id, it.name) })
            db.writeoffPermissionDao().replaceAll(bootstrap.operators.map { WriteoffPermissionEntity(it.employeeId, it.canWriteoff) })
            meta.put(MetaStore.WRITEOFF_BOOTSTRAP_AT, clock().toString())
        }
        return registry.walk()
    }
}
