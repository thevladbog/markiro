package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import java.security.MessageDigest

/** `inventorySnapshotPageDigest` / `inventorySnapshotContentDigest` from packages/domain/src/inventory/station-bundle.ts. */
object InventoryDigests {
    fun itemJson(c: InventoryBundleCodeDto): String = CanonicalJson.obj(
        "codeHash" to CanonicalJson.str(c.codeHash),
        "canonicalRaw" to CanonicalJson.str(c.canonicalRaw),
        "gtin14" to CanonicalJson.str(c.gtin14),
        "serial" to CanonicalJson.str(c.serial),
        "sourceStatus" to CanonicalJson.str(c.sourceStatus),
        "sourceState" to CanonicalJson.strOrNull(c.sourceState),
        "sourceProductionDate" to CanonicalJson.strOrNull(c.sourceProductionDate),
        "parentSscc" to CanonicalJson.strOrNull(c.parentSscc),
        "expected" to CanonicalJson.bool(c.expected),
        "protected" to CanonicalJson.bool(c.protected),
    )

    fun itemJson(e: InventorySnapshotCodeEntity): String = itemJson(
        InventoryBundleCodeDto(
            codeHash = e.codeHash, canonicalRaw = e.canonicalRaw, gtin14 = e.gtin14, serial = e.serial, sourceStatus = e.sourceStatus,
            sourceState = e.sourceState, sourceProductionDate = e.sourceProductionDate, parentSscc = e.parentSscc, expected = e.expected,
            protected = e.protected,
        ),
    )

    fun pageDigest(
        snapshotId: String,
        snapshotFixedAt: String,
        contentDigest: String,
        cursor: String?,
        items: List<InventoryBundleCodeDto>,
        nextCursor: String?,
    ): String = CanonicalJson.sha256Hex(
        CanonicalJson.obj(
            "version" to CanonicalJson.num(1),
            "snapshotId" to CanonicalJson.str(snapshotId),
            "snapshotFixedAt" to CanonicalJson.str(snapshotFixedAt),
            "contentDigest" to CanonicalJson.str(contentDigest),
            "cursor" to CanonicalJson.strOrNull(cursor),
            "items" to CanonicalJson.arr(items.map(::itemJson)),
            "nextCursor" to CanonicalJson.strOrNull(nextCursor),
        ),
    )
}

/** Streams `{"version":1,"items":[…]}` through SHA-256 so a 100 000-row snapshot never sits in memory. */
class ContentDigest {
    private val digest = MessageDigest.getInstance("SHA-256")
    private var count = 0

    init {
        digest.update("""{"version":1,"items":[""".toByteArray(Charsets.UTF_8))
    }

    fun add(itemJson: String) {
        if (count > 0) digest.update(','.code.toByte())
        digest.update(itemJson.toByteArray(Charsets.UTF_8))
        count += 1
    }

    fun finish(): String = digest.digest("]}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
