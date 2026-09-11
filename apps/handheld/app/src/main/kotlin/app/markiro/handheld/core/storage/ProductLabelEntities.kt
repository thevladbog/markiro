package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One accepted unit's duplicate label.
 *
 * `bytesBase64` is the prepared document, replayed on every attempt and never
 * re-rendered: a reprint must reproduce the same symbol, and the digest the
 * server holds is over these bytes. This is the opposite of the box label, which
 * re-renders precisely because «Другой принтер» may speak a different language.
 *
 * The bytes are dropped at shift close -- a reprint into a closed shift is not a
 * thing, and a shift's worth of labels would grow without bound on a fixed disk.
 * `bytesDigest` survives that, so an event already queued still describes what
 * was printed.
 */
@Entity(tableName = "product_label_jobs", indices = [Index(value = ["shiftId", "status"])])
data class ProductLabelJobEntity(
    @PrimaryKey val jobId: String,
    val shiftId: String,
    val codeHash: String,
    /** The canonical marking code: the source of both the symbol and the verification comparison. */
    val canonicalRaw: String,
    val acceptedAt: String,
    val operatorId: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val bytesBase64: String?,
    val bytesDigest: String,
    val language: String,
    val dpi: Int,
    val latestSequence: Int,
    val attemptId: String,
    val attemptNo: Int,
    val attemptState: String,
    val verification: String,
    val verificationOutcome: String,
    val status: String,
    /**
     * Why the last attempt did not leave the device, in the printer's own terms.
     *
     * DEVICE-LOCAL and deliberately not an event: the protocol's
     * `failed_before_send` admits only `printer_unconfigured` and
     * `printer_changed`, because an event describes what happened to the LABEL.
     * «Нет бумаги» is a fact about the printer, and sending it made the server
     * reject the whole batch -- wedging the queue for scans and shift closures
     * too.
     */
    val lastFailure: String?,
)

/**
 * The job's event log and its outbox at once.
 *
 * An event's payload is fixed and small, so a second table would hold the same
 * JSON under the same key; `boxes` already sets this precedent with its own
 * `ackedAt`. A quarantined event leaves the queue without being acknowledged as
 * delivered, because the server answers per event and quarantine is not
 * delivery.
 */
@Entity(
    tableName = "product_label_events",
    indices = [
        Index(value = ["jobId", "sequence"], unique = true),
        Index(value = ["ackedAt"]),
    ],
)
data class ProductLabelEventEntity(
    @PrimaryKey val eventId: String,
    val jobId: String,
    val sequence: Int,
    val kind: String,
    /** The exact wire object, so a retry resends byte-identical JSON. */
    val payloadJson: String,
    val occurredAt: String,
    val ackedAt: String?,
    val quarantineCode: String?,
)
