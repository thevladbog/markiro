package app.markiro.handheld.core.replacement

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ReplacementMigrationTest {
    @Test fun upgradePreservesRecoveryAndPreparedBytesAndReportSurvivesFileReopen() = runTest {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val name="replacement-${UUID.randomUUID()}.db"
        val credential=InMemoryCredentialStore().apply { write("synthetic-key") }
        fun open()=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().addMigrations(MIGRATION_16_17).build()
        try {
            val before=open(); before.initializeRecoveryForTest(credential)
            val owner=before.deviceRecoveryDao().get()
            before.metaDao().put(MetaEntity("saved-print-bytes","raw\u001dsaved"))
            before.openHelper.writableDatabase.execSQL("DROP TABLE replacement_drain")
            before.openHelper.writableDatabase.version=16; before.close()
            val upgraded=open(); DeviceRecovery(upgraded,credential).initialize()
            assertEquals(owner,upgraded.deviceRecoveryDao().get())
            assertEquals("raw\u001dsaved",upgraded.metaDao().get("saved-print-bytes"))
            val intent=Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""").jsonObject
            ReplacementReadiness(upgraded).apply(upgraded.recovery.token(),intent)
            val body=ReplacementReadiness(upgraded).prepareReport(upgraded.recovery.token())
            upgraded.close()
            val reopened=open()
            try {
                DeviceRecovery(reopened,credential).initialize()
                assertTrue(ReplacementReadiness(reopened).blocked())
                assertEquals(body,ReplacementReadiness(reopened).prepareReport(reopened.recovery.token()))
                assertEquals("raw\u001dsaved",reopened.metaDao().get("saved-print-bytes"))
            } finally { reopened.close() }
        } finally { context.deleteDatabase(name) }
    }
}
