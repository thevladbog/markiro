package app.markiro.handheld.core.grants

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class GrantMigrationTest {
    @Test fun realVersionThirteenUpgradePreservesQueuedBytesAndHasNoImplicitStrictConfig() = runTest {
        val context=ApplicationProvider.getApplicationContext<Context>(); val name="grant-upgrade-${UUID.randomUUID()}.db"
        fun database()=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().addMigrations(MIGRATION_13_14,MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17).build()
        try {
            val old=database()
            val raw="exact\u001dqueued-code"
            old.outboxDao().insert(OutboxEntity(shiftId="s",raw=raw,verdict="invalid",scannedAt="2026-09-13T00:00:00Z",operatorId="op",codeHash=null,gtin14=null,serial=null))
            old.metaDao().put(MetaEntity("saved-print-evidence","exact prepared bytes"))
            val sql=old.openHelper.writableDatabase
            listOf("grant_state","grant_tokens","grant_counters","grant_evidence","grant_task_bindings","grant_task_provenance","grant_readiness_outbox").forEach { sql.execSQL("DROP TABLE $it") }
            sql.version=13; old.close()
            val upgraded=database()
            try {
                assertEquals(app.markiro.handheld.core.storage.HANDHELD_DATABASE_VERSION,upgraded.openHelper.readableDatabase.version)
                assertEquals(raw,upgraded.outboxDao().head(1).single().raw)
                assertNull(upgraded.grantDao().state())
                assertTrue(upgraded.grantDao().evidence().isEmpty())
                upgraded.openHelper.readableDatabase.query("SELECT value FROM meta WHERE `key`='saved-print-evidence'").use { assertTrue(it.moveToFirst()); assertEquals("exact prepared bytes",it.getString(0)) }
            } finally { upgraded.close() }
        } finally { context.deleteDatabase(name) }
    }

    @Test fun versionFourteenUpgradeKeepsReadinessIntentAcrossReopen() = runTest {
        val context=ApplicationProvider.getApplicationContext<Context>(); val name="grant-readiness-${UUID.randomUUID()}.db"
        fun database()=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().addMigrations(MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17).build()
        try {
            database().let { current -> try {
                current.openHelper.writableDatabase.execSQL("DROP TABLE grant_readiness_outbox")
                current.openHelper.writableDatabase.version=14
            } finally { current.close() } }
            database().let { upgraded -> try {
                upgraded.grantDao().readiness(
                    GrantReadinessOutboxEntity("11111111-1111-4111-8111-111111111111","owner",2,"{\"requestId\":\"11111111-1111-4111-8111-111111111111\"}")
                )
            } finally { upgraded.close() } }
            database().let { reopened -> try {
                assertEquals("11111111-1111-4111-8111-111111111111",reopened.grantDao().pendingReadiness("owner",2).single().requestId)
            } finally { reopened.close() } }
        } finally { context.deleteDatabase(name) }
    }
}
