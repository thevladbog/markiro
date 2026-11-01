package app.markiro.handheld.core.reprint

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.Index
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import androidx.sqlite.db.SupportSQLiteDatabase
import app.markiro.handheld.core.print.PrinterEntity
import kotlinx.serialization.Serializable

@Serializable
data class ReprintPrinter(val id: String, val name: String, val transport: String, val address: String, val language: String, val dpi: Int) {
    fun entity() = PrinterEntity(id, name, transport, address, language, dpi, false, null, null)
    companion object { fun of(p: PrinterEntity) = ReprintPrinter(p.id, p.name, p.transport, p.address, p.language, p.dpi) }
}

/** Complete replayable job. Neither source, destination, layout nor bytes can be edited after preparation. */
@Entity(tableName = "site_reprint_jobs")
data class SiteReprintJob(
    @PrimaryKey val jobId: String,
    val sessionId: String,
    val ownerJson: String,
    val generation: Long,
    val operatorId: String,
    val backend: String,
    val sourceJson: String,
    val templateJson: String,
    val printerJson: String,
    val bytesBase64: String,
    val reason: String,
    val state: String,
    val error: String?,
    val attemptId: String,
    val attempt: Int,
    val sequence: Long,
    val createdAt: String,
    val updatedAt: String,
)

@Entity(tableName = "site_reprint_audit", indices = [Index(value = ["jobId"]), Index(value = ["ownerJson", "generation", "state"])])
data class SiteReprintAudit(
    @PrimaryKey val recordId: String,
    val jobId: String,
    val ownerJson: String,
    val generation: Long,
    val backend: String,
    val sequence: Long,
    val occurredAt: String,
    val payload: String,
    val state: String = "pending",
    val rejection: String? = null,
)

data class ReprintAuditCounts(val pending: Int, val rejected: Int)

@Dao
interface SiteReprintDao {
    @Query("SELECT COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END),0) AS rejected FROM site_reprint_audit WHERE ownerJson = :owner AND generation = :generation")
    fun observeCounts(owner: String, generation: Long): kotlinx.coroutines.flow.Flow<ReprintAuditCounts>
    @Query("SELECT COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END),0) AS rejected FROM site_reprint_audit WHERE ownerJson = :owner AND generation = :generation")
    suspend fun counts(owner: String, generation: Long): ReprintAuditCounts
    @Query("SELECT * FROM site_reprint_jobs WHERE jobId = :id") suspend fun job(id: String): SiteReprintJob?
    @Query("SELECT * FROM site_reprint_jobs WHERE ownerJson = :owner AND generation = :generation AND state IN ('prepared','sending','failed','unknown') ORDER BY createdAt, jobId")
    suspend fun unresolved(owner: String, generation: Long): List<SiteReprintJob>
    @Query("SELECT * FROM site_reprint_audit WHERE ownerJson = :owner AND generation = :generation AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM site_reprint_audit rejected WHERE rejected.jobId = site_reprint_audit.jobId AND rejected.state = 'rejected') ORDER BY jobId, sequence, recordId LIMIT 100")
    suspend fun owed(owner: String, generation: Long): List<SiteReprintAudit>
    @Query("SELECT * FROM site_reprint_audit WHERE recordId = :id") suspend fun audit(id: String): SiteReprintAudit?
    @Query("SELECT * FROM site_reprint_audit WHERE jobId = :jobId ORDER BY sequence") suspend fun history(jobId: String): List<SiteReprintAudit>
    @Upsert suspend fun save(job: SiteReprintJob)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun append(event: SiteReprintAudit)
    @Query("UPDATE site_reprint_audit SET state = :state, rejection = :rejection WHERE recordId = :id AND payload = :payload AND state = 'pending'")
    suspend fun acknowledge(id: String, payload: String, state: String, rejection: String?)
}

object SiteReprintSchema {
    fun create(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS site_reprint_jobs (jobId TEXT NOT NULL PRIMARY KEY, sessionId TEXT NOT NULL, ownerJson TEXT NOT NULL, generation INTEGER NOT NULL, operatorId TEXT NOT NULL, backend TEXT NOT NULL, sourceJson TEXT NOT NULL, templateJson TEXT NOT NULL, printerJson TEXT NOT NULL, bytesBase64 TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, error TEXT, attemptId TEXT NOT NULL, attempt INTEGER NOT NULL, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS site_reprint_audit (recordId TEXT NOT NULL PRIMARY KEY, jobId TEXT NOT NULL, ownerJson TEXT NOT NULL, generation INTEGER NOT NULL, backend TEXT NOT NULL, sequence INTEGER NOT NULL, occurredAt TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, rejection TEXT)")
        createIndexes(db)
    }

    fun createIndexes(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE INDEX IF NOT EXISTS index_site_reprint_audit_jobId ON site_reprint_audit(jobId)")
        db.execSQL("CREATE INDEX IF NOT EXISTS index_site_reprint_audit_ownerJson_generation_state ON site_reprint_audit(ownerJson,generation,state)")
    }
}

/** Opaque reconciliation evidence survives dataset replacement, never rebound as a printable job. */
internal fun archiveSiteReprintEvidence(db: SupportSQLiteDatabase) {
    fun rows(sql: String): kotlinx.serialization.json.JsonArray = db.query(sql).use { cursor ->
        kotlinx.serialization.json.JsonArray(buildList {
            while (cursor.moveToNext()) add(kotlinx.serialization.json.buildJsonObject {
                for (i in 0 until cursor.columnCount) put(cursor.getColumnName(i),
                    if (cursor.isNull(i)) kotlinx.serialization.json.JsonNull else kotlinx.serialization.json.JsonPrimitive(cursor.getString(i)))
            })
        })
    }
    val jobs = rows("SELECT * FROM site_reprint_jobs WHERE state IN ('prepared','sending','failed','unknown') OR EXISTS (SELECT 1 FROM site_reprint_audit a WHERE a.jobId = site_reprint_jobs.jobId AND a.state <> 'accepted')")
    val events = rows("SELECT * FROM site_reprint_audit WHERE state <> 'accepted'")
    if (jobs.isNotEmpty() || events.isNotEmpty()) {
        val value = kotlinx.serialization.json.buildJsonObject { put("jobs", jobs); put("audit", events) }.toString()
        db.execSQL("INSERT INTO meta(`key`, value) VALUES(?,?)", arrayOf("site_reprint_evidence:" + java.util.UUID.randomUUID(), value))
    }
}
