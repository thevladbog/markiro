package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec

data class SnapshotRow(
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String?,
    val sourceProductionDate: String?,
    val expected: Boolean,
    val protected: Boolean,
    val parentSscc: String?,
)

data class LocalClaim(val codeHash: String, val eventId: String, val deviceId: String, val scannedAt: String)

enum class Origin(val wire: String) { EXPECTED("expected"), PROTECTED("protected"), KNOWN_INELIGIBLE("known-ineligible") }

data class BoxChild(val codeHash: String, val origin: Origin, val firstWinning: LocalClaim?)

sealed interface Identity {
    val scanKind: String

    data class Item(val codeHash: String, val canonicalRaw: String, val gtin14: String, val serial: String) : Identity {
        override val scanKind get() = "item"
    }

    data class KnownBox(val sscc: String, val children: List<BoxChild>) : Identity {
        override val scanKind get() = "known_box"
    }

    data class OldBox(val sscc: String) : Identity {
        override val scanKind get() = "old_box"
    }
}

/** Port of `InventoryScanClassification`; `sourceStatus` is set for protected / ineligible items. */
sealed interface InventoryClassification {
    val kind: String
    val identity: Identity
    val sourceStatus: String? get() = null

    data class Expected(override val identity: Identity) : InventoryClassification {
        override val kind get() = "expected"
    }

    data class Protected(override val identity: Identity, override val sourceStatus: String?) : InventoryClassification {
        override val kind get() = "protected"
    }

    data class KnownIneligible(override val identity: Identity, override val sourceStatus: String?) : InventoryClassification {
        override val kind get() = "known-ineligible"
    }

    data class Unknown(override val identity: Identity) : InventoryClassification {
        override val kind get() = "unknown"
    }

    data class Duplicate(override val identity: Identity, val firstWinning: LocalClaim) : InventoryClassification {
        override val kind get() = "duplicate"
    }

    /** `malformed`, `wrong_gtin` or `unsupported` (a bare GTIN). Carries no identity. */
    data class Invalid(val reason: String) : InventoryClassification {
        override val kind get() = "invalid"
        override val identity: Identity get() = throw IllegalStateException("invalid scan has no identity")
    }
}

interface ClassifierContext {
    val taskGtin14: String
    fun snapshotCode(codeHash: String): SnapshotRow?
    fun snapshotChildren(sscc: String): List<SnapshotRow>
    fun localClaim(codeHash: String): LocalClaim?
}

sealed interface SourceDate {
    val kind: String

    data object None : SourceDate {
        override val kind get() = "none"
    }

    data class Single(val scanKind: String, val productionDate: String) : SourceDate {
        override val kind get() = "single"
    }

    data object Mixed : SourceDate {
        override val kind get() = "mixed"
    }
}

/** Port of packages/domain/src/inventory/scan.ts; verified by InventoryClassifierFixturesTest. */
object InventoryClassifier {
    fun origin(row: SnapshotRow): Origin = when {
        row.sourceState == "MOVING_BY_UD" || row.protected -> Origin.PROTECTED
        row.expected -> Origin.EXPECTED
        else -> Origin.KNOWN_INELIGIBLE
    }

    private fun firstClaim(claims: List<LocalClaim>): LocalClaim =
        claims.sortedWith(compareBy({ it.scannedAt }, { it.deviceId }, { it.eventId })).first()

    fun classify(raw: String, ctx: ClassifierContext): InventoryClassification = when (val input = ScanClassifier.classify(raw)) {
        is ScanInput.Km -> classifyItem(input, ctx)
        is ScanInput.Sscc -> classifyBox(input.sscc, ctx)
        is ScanInput.Gtin -> InventoryClassification.Invalid("unsupported")
        is ScanInput.Unknown -> InventoryClassification.Invalid("malformed")
    }

    private fun classifyItem(input: ScanInput.Km, ctx: ClassifierContext): InventoryClassification {
        val km = input.km
        if (km.gtin14 != ctx.taskGtin14) return InventoryClassification.Invalid("wrong_gtin")
        val codeHash = KmCodec.hash(km)
        val identity = Identity.Item(codeHash, km.canonicalRaw, km.gtin14, km.serial)
        ctx.localClaim(codeHash)?.let { return InventoryClassification.Duplicate(identity, it) }
        val snapshot = ctx.snapshotCode(codeHash) ?: return InventoryClassification.Unknown(identity)
        return when (origin(snapshot)) {
            Origin.PROTECTED -> InventoryClassification.Protected(identity, snapshot.sourceStatus)
            Origin.KNOWN_INELIGIBLE -> InventoryClassification.KnownIneligible(identity, snapshot.sourceStatus)
            Origin.EXPECTED -> InventoryClassification.Expected(identity)
        }
    }

    private fun classifyBox(sscc: String, ctx: ClassifierContext): InventoryClassification {
        val rows = ctx.snapshotChildren(sscc)
        if (rows.isEmpty()) return InventoryClassification.Unknown(Identity.OldBox(sscc))
        val children = rows.map { BoxChild(it.codeHash, origin(it), ctx.localClaim(it.codeHash)) }
        val identity = Identity.KnownBox(sscc, children)
        val unclaimed = children.filter { it.firstWinning == null }
        if (unclaimed.isEmpty()) return InventoryClassification.Duplicate(identity, firstClaim(children.mapNotNull { it.firstWinning }))
        return when {
            unclaimed.any { it.origin == Origin.EXPECTED } -> InventoryClassification.Expected(identity)
            unclaimed.any { it.origin == Origin.PROTECTED } -> InventoryClassification.Protected(identity, null)
            else -> InventoryClassification.KnownIneligible(identity, null)
        }
    }

    /** Only an `expected` scan has a date of its own; a box takes the single date of its unclaimed expected children. */
    fun sourceDate(classification: InventoryClassification, ctx: ClassifierContext): SourceDate {
        if (classification !is InventoryClassification.Expected) return SourceDate.None
        return when (val identity = classification.identity) {
            is Identity.Item ->
                ctx.snapshotCode(identity.codeHash)?.sourceProductionDate?.let { SourceDate.Single("item", it) } ?: SourceDate.None
            is Identity.KnownBox -> {
                val unclaimed = identity.children.filter { it.firstWinning == null && it.origin == Origin.EXPECTED }.map { it.codeHash }.toSet()
                var date: String? = null
                for (row in ctx.snapshotChildren(identity.sscc)) {
                    val rowDate = row.sourceProductionDate
                    if (row.codeHash !in unclaimed || rowDate == null) continue
                    if (date != null && date != rowDate) return SourceDate.Mixed
                    date = rowDate
                }
                date?.let { SourceDate.Single("known_box", it) } ?: SourceDate.None
            }
            is Identity.OldBox -> SourceDate.None
        }
    }
}
