package app.markiro.handheld.feature.writeoff

import app.markiro.handheld.core.km.ParsedKm
import app.markiro.handheld.core.network.WriteoffBoxDto
import app.markiro.handheld.core.network.WriteoffItemDto
import app.markiro.handheld.core.network.WriteoffRequestDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.writeoff.MirrorOutcome
import app.markiro.handheld.core.writeoff.WriteoffMirror
import app.markiro.handheld.core.writeoff.WriteoffSyncEngine
import app.markiro.handheld.core.writeoff.contentKeys
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import java.util.UUID

/** One thing the operator is writing off. */
sealed interface WriteoffLine {
    val key: String

    data class Unit(val km: ParsedKm, val name: String) : WriteoffLine {
        override val key: String get() = app.markiro.handheld.core.km.KmCodec.key(km)
    }

    /** A closed box: its own key plus every unit key the registry says it holds. */
    data class Box(val sscc: String, val name: String, val count: Int, val contentKeys: List<String>) : WriteoffLine {
        override val key: String get() = sscc
    }
}

/** Everything the mode needs, behind one seam so the ViewModel is testable without Room. */
interface WriteoffGateway {
    fun observeReasons(): Flow<List<WriteoffReasonEntity>>

    /** By GTIN: how a unit scan resolves a product. */
    suspend fun productName(gtin14: String): String?

    /** By id: how the box registry names one. */
    suspend fun productNameById(productId: String): String?

    suspend fun box(sscc: String): BoxRegistryEntity?

    /** Null when the mirror has never covered this operator: unknown, not refused. */
    suspend fun canWriteoff(operatorId: String): Boolean?

    /** True once the catalogue has been mirrored at least once. */
    suspend fun catalogueReady(): Boolean

    val stampAt: Flow<Long?>

    suspend fun refreshMirror(): MirrorOutcome

    /** Mints the next `deviceSeq`, freezes the request bytes and files the document. Returns its id. */
    suspend fun file(operatorId: String, reason: WriteoffReasonEntity, lines: List<WriteoffLine>): String

    fun observeDocument(id: String): Flow<WriteoffOutboxEntity?>

    fun observeRecent(): Flow<List<WriteoffOutboxEntity>>
}

/**
 * The Room-backed gateway.
 *
 * [file] is the whole offline guarantee and it is one transaction: the sequence
 * is read, the bytes are built and the row is inserted together, so a document
 * either has its number or was never filed. Nothing here touches the network —
 * the engine does that, from the bytes this froze.
 */
class WriteoffRepository(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val mirror: WriteoffMirror,
    private val engine: WriteoffSyncEngine,
    private val json: Json,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : WriteoffGateway {
    override fun observeReasons(): Flow<List<WriteoffReasonEntity>> = db.writeoffReasonDao().observeAll()

    override suspend fun productName(gtin14: String): String? = db.writeoffProductDao().byGtin(gtin14)?.name

    override suspend fun productNameById(productId: String): String? = db.writeoffProductDao().byId(productId)?.name

    override suspend fun box(sscc: String): BoxRegistryEntity? = db.boxRegistryDao().bySscc(sscc)

    override suspend fun canWriteoff(operatorId: String): Boolean? =
        db.writeoffPermissionDao().get(operatorId)?.canWriteoff

    override suspend fun catalogueReady(): Boolean = meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT) != null

    override val stampAt: Flow<Long?> get() = mirror.stampAt

    override suspend fun refreshMirror(): MirrorOutcome = mirror.refresh()

    override suspend fun file(operatorId: String, reason: WriteoffReasonEntity, lines: List<WriteoffLine>): String {
        val documentId = newId()
        val createdAt = Iso.format(clock())
        db.recovery.commit {
            app.markiro.handheld.core.replacement.ReplacementReadiness(db).requireAdmission()
            val seq = (meta.get(MetaStore.WRITEOFF_NEXT_DEVICE_SEQ)?.toLongOrNull() ?: 1L)
            val units = lines.filterIsInstance<WriteoffLine.Unit>()
            val boxes = lines.filterIsInstance<WriteoffLine.Box>()
            val request = WriteoffRequestDto(
                deviceSeq = seq,
                operatorId = operatorId,
                writeoffReasonId = reason.id,
                items = units.map { WriteoffItemDto(it.km.canonicalRaw) },
                boxes = boxes.map { WriteoffBoxDto(it.sscc) },
                createdAt = createdAt,
            )
            db.writeoffOutboxDao().insert(
                WriteoffOutboxEntity(
                    documentId = documentId, deviceSeq = seq, operatorId = operatorId, reasonId = reason.id,
                    reasonName = reason.name, unitCount = units.size, boxCount = boxes.size,
                    requestJson = json.encodeToString(WriteoffRequestDto.serializer(), request), createdAt = createdAt,
                    state = "pending", orderNo = null, acceptedCount = null, conflictsJson = null, lastAttemptAt = null,
                ),
            )
            meta.put(MetaStore.WRITEOFF_NEXT_DEVICE_SEQ, (seq + 1).toString())
        }
        engine.nudge()
        return documentId
    }

    override fun observeDocument(id: String): Flow<WriteoffOutboxEntity?> = db.writeoffOutboxDao().observe(id)

    override fun observeRecent(): Flow<List<WriteoffOutboxEntity>> = db.writeoffOutboxDao().observeRecent(HISTORY)

    private companion object {
        const val HISTORY = 20
    }
}

/** The unit keys a box contributes, so a loose unit already inside it reads as a duplicate. */
fun BoxRegistryEntity.keys(): List<String> = contentKeys()
