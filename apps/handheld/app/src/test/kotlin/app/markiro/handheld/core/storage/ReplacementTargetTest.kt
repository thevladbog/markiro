package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.ReplacementTargetFence
import app.markiro.handheld.core.replacement.ReplacementDenied
import app.markiro.handheld.core.replacement.ReplacementReadiness
import app.markiro.handheld.core.replacement.ReplacementTarget
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ReplacementTargetTest {
    private val fence = ReplacementTargetFence(1, UUID.randomUUID().toString(), 2, 5000, 1000)
    private val response = PairResponse(
        DeviceDto(UUID.randomUUID().toString(), "Target", "handheld", "tenant", "Factory"),
        CredentialDto("candidate", "https://example.invalid"), emptyList(), fence,
    )

    @Test fun fenceCommitsBeforeKeyAndReopensBeforeHubAdmission() = runTest {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "replacement-target-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .allowMainThreadQueries().build()
        var db = open()
        val secrets = InMemoryCredentialStore()
        var fail = true
        val credential = object : CredentialStore by secrets {
            override fun write(apiKey: String) { check(!fail); secrets.write(apiKey) }
        }
        var recovery = DeviceRecovery(db, credential)
        try {
            recovery.initialize()
            assertTrue(runCatching { recovery.restore(response, "https://example.invalid") }.isFailure)
            assertNull(secrets.read())
            assertTrue(ReplacementReadiness(db).blocked())
            db.close()
            db = open()
            fail = false
            recovery = DeviceRecovery(db, credential)
            recovery.initialize()
            assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
            assertEquals("candidate", secrets.read())
            assertTrue(ReplacementReadiness(db).blocked())
            assertTrue(runCatching {
                ReplacementReadiness(db).requireAdmission("shift", "new-task")
            }.exceptionOrNull() is ReplacementDenied)
            val token = recovery.token()
            ReplacementTarget(db).applyConfiguration(token, null)
            assertTrue(ReplacementReadiness(db).blocked())
            ReplacementTarget(db).applyConfiguration(token, fence.copy(serverTime = 5000))
            assertFalse(ReplacementReadiness(db).blocked())
            ReplacementTarget(db).applyConfiguration(token, fence)
            assertFalse(ReplacementReadiness(db).blocked())
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun delayedResponseFromPriorCredentialCannotReleaseNewPublication() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        val recovery = DeviceRecovery(db, InMemoryCredentialStore())
        try {
            recovery.initialize()
            recovery.restore(response, "https://example.invalid")
            val old = recovery.token()
            recovery.reject(old)
            val nextFence = fence.copy(credentialEpoch = 3, serverTime = 2000)
            recovery.restore(response.copy(credential = CredentialDto("new-candidate", "https://example.invalid"), replacement = nextFence), "https://example.invalid")
            assertTrue(runCatching { ReplacementTarget(db).applyConfiguration(old, fence.copy(serverTime = 6000)) }.isFailure)
            assertTrue(ReplacementReadiness(db).blocked())
            assertTrue(runCatching { ReplacementTarget(db).applyConfiguration(recovery.token(), fence.copy(serverTime = 6000)) }.isFailure)
            assertTrue(ReplacementReadiness(db).blocked())
            ReplacementTarget(db).applyConfiguration(recovery.token(), nextFence.copy(serverTime = 5000))
            assertFalse(ReplacementReadiness(db).blocked())
        } finally { db.close() }
    }

    @Test fun failedOrIneffectiveFenceCannotPublishKey() = runTest {
        for (failure in listOf("ABORT,'simulated'", "IGNORE")) {
            val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
                .allowMainThreadQueries().build()
            val secrets = InMemoryCredentialStore()
            val recovery = DeviceRecovery(db, secrets)
            try {
                recovery.initialize()
                db.openHelper.writableDatabase.execSQL("CREATE TRIGGER reject_fence BEFORE INSERT ON meta WHEN NEW.key='device_replacement_target_v1' BEGIN SELECT RAISE($failure); END")
                assertTrue(runCatching { recovery.restore(response, "https://example.invalid") }.isFailure)
                assertNull(secrets.read())
                assertNotEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
            } finally { db.close() }
        }
    }
}
