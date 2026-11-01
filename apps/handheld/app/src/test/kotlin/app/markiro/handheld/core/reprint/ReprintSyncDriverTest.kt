package app.markiro.handheld.core.reprint

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReprintSyncDriverTest {
    private class AuditOnly(private val flush: suspend () -> Unit) : SiteReprintOperations {
        override suspend fun print(raw: String, reason: String, sessionId: String, operatorId: String): SiteReprintResult = error("must not print")
        override suspend fun retry(jobId: String, operatorId: String): SiteReprintResult = error("must not print")
        override suspend fun cancel(jobId: String, operatorId: String): SiteReprintResult = error("unused")
        override suspend fun verify(jobId: String, raw: String, operatorId: String): SiteReprintResult = error("unused")
        override suspend fun pending(): SiteReprintJob? = null
        override suspend fun refreshTemplates() = Unit
        override suspend fun flushAudit() = flush()
    }

    @Test fun sealingBetweenAuditFlushAndTheFinalTokenReturnsFalse() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val recovery = db.initializeRecoveryForTest()
            val token = recovery.token()
            val calls = mutableListOf<String>()
            val upstream = object : SyncDriver {
                override val state = MutableStateFlow(SyncState())
                override suspend fun drainAll(): Boolean { calls += "drain"; return true }
                override fun nudge() = Unit
                override fun start() = Unit
            }
            val driver = ReprintSyncDriver(upstream, db, AuditOnly { calls += "audit"; recovery.reject(token) }, backgroundScope, recovery)
            assertFalse(driver.drainAll())
            assertEquals(listOf("drain", "audit"), calls)
        } finally { db.close() }
    }

    @Test fun activeDrainStillRequiresUpstreamAndEveryAuditToSettle() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val recovery = db.initializeRecoveryForTest()
            val token = recovery.token()
            var upstreamSettled = true
            var flushes = 0
            val upstream = object : SyncDriver {
                override val state = MutableStateFlow(SyncState())
                override suspend fun drainAll() = upstreamSettled
                override fun nudge() = Unit
                override fun start() = Unit
            }
            val driver = ReprintSyncDriver(upstream, db, AuditOnly { flushes++ }, backgroundScope, recovery)
            assertTrue(driver.drainAll())
            val event = SiteReprintAudit("event", "job", Json.encodeToString(token.owner), token.generation, "cloud", 1, "now", "frozen")
            db.siteReprintDao().append(event)
            assertFalse(driver.drainAll())
            db.siteReprintDao().acknowledge(event.recordId, event.payload, "rejected", "refused")
            assertFalse(driver.drainAll())
            db.openHelper.writableDatabase.execSQL("UPDATE site_reprint_audit SET state='accepted'")
            assertTrue(driver.drainAll())
            upstreamSettled = false
            assertFalse(driver.drainAll())
            assertEquals(5, flushes)
        } finally { db.close() }
    }
}
