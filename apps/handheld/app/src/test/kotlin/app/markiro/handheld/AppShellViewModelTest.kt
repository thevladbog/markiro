package app.markiro.handheld

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.DeviceRecoveryEntity
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppShellViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var recovery: DeviceRecovery
    private lateinit var db: HandheldDatabase
    private val credential = InMemoryCredentialStore()
    private val session = SessionHolder()
    private val revocation = RevocationBus()
    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)
    private val paired = DeviceConfigEntity(
        deviceId = "dev-1",
        deviceName = "ТСД 1",
        tenantId = "t-1",
        organizationName = "ООО",
        lineId = null,
        lineName = null,
        kind = "handheld",
        serverUrl = "https://x",
        pairedAt = 1L,
    )

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        recovery = DeviceRecovery(db, credential)
    }

    @After
    fun close() {
        try {
            main.cancelAndJoinModels()
        } finally {
            db.close()
        }
    }

    private fun vm() = main.track(
        AppShellViewModel(db.deviceConfigDao(), session, revocation, recovery, idleMs = 5 * 60 * 1000L),
    )

    @Test
    fun startsOnPairingWithoutConfigAndOnSignInWithIt() = runTest {
        // Room answers observe() from its own executor, so wait for the first value instead of advancing.
        val a = vm()
        assertEquals(StartDestination.PAIRING, a.start.first { it != null })
    }

    @Test
    fun startsAtSignInOnlyAfterOwnerBootstrap() = runTest {
        db.deviceConfigDao().upsert(paired)
        credential.write("mk_live_abc")
        assertEquals(StartDestination.SIGN_IN, vm().start.first { it != null })
    }

    @Test
    fun firstPairingIsNotMistakenForARevocation() = runTest {
        // Publishing a credential walks UNPAIRED -> RESTORING -> ACTIVE. RESTORING is
        // a publication in progress, not a revoked credential: treating it as one threw
        // the operator back onto the pairing screen at the exact moment pairing
        // succeeded, and nothing short of restarting the app got past it.
        val shell = vm()
        assertEquals(StartDestination.PAIRING, shell.start.first { it != null })
        shell.events.test {
            recovery.restore(
                PairResponse(
                    DeviceDto(paired.deviceId, paired.deviceName, paired.kind, paired.tenantId, paired.organizationName),
                    CredentialDto("mk_live_abc", paired.serverUrl),
                    emptyList(),
                ),
                paired.serverUrl,
            )
            advanceUntilIdle()
            expectNoEvents()
        }
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
    }

    @Test
    fun revocationSealsConfigAndEmitsAnEvent() = runTest {
        db.deviceConfigDao().upsert(paired)
        credential.write("mk_live_abc")
        session.signIn(anna)
        val shell = vm()
        shell.start.first { it != null }
        shell.events.test {
            revocation.raise(recovery.token())
            assertEquals(ShellEvent.Revoked, awaitItem())
        }
        recovery.state.first { it.phase == app.markiro.handheld.core.storage.RecoveryPhase.SEALED }
        assertEquals(paired, db.deviceConfigDao().get())
        assertNull(credential.read())
        assertNull(session.state.value.operator)
    }

    @Test
    fun idleTimeLocksASignedInSession() = runTest {
        db.deviceConfigDao().upsert(paired)
        credential.write("mk_live_abc")
        recovery.initialize()
        session.signIn(anna)
        val shell = vm()
        shell.events.test {
            shell.onUserInteraction()
            advanceTimeBy(4 * 60 * 1000L)
            shell.onUserInteraction()
            advanceTimeBy(4 * 60 * 1000L)
            expectNoEvents()
            advanceTimeBy(2 * 60 * 1000L)
            assertEquals(ShellEvent.Locked, awaitItem())
        }
        assertTrue(session.state.value.locked)
    }
    @Test fun firstSealWriteFailureStillSignsOutAndRoutesToRecovery() = runTest {
        db.deviceConfigDao().upsert(paired)
        credential.write("synthetic-key")
        session.signIn(anna)
        val shell = vm()
        shell.start.first { it != null }
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_intent BEFORE INSERT ON device_recovery BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        shell.events.test {
            assertTrue(runCatching { recovery.reject(recovery.token()) }.isFailure)
            assertEquals(ShellEvent.Revoked, awaitItem())
            assertNull(session.state.value.operator)
            assertEquals("synthetic-key", credential.read())
            db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_intent")
            recovery.initialize()
            cancelAndIgnoreRemainingEvents()
        }
        assertNull(credential.read())
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun failedDatasetStartupDefersNavigationUntilRetryCanUseRetainedPairing() = runTest {
        val host = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
        val origin = "https://192.168.1.10:45710"
        val pin = "ab".repeat(32)
        credential.write("synthetic-key")
        db.deviceConfigDao().upsert(paired.copy(tenantId = host, serverUrl = origin, backend = "host", hostId = host, pinSha256 = pin))
        db.deviceRecoveryDao().put(DeviceRecoveryEntity(serverOrigin = origin, tenantId = host, deviceId = paired.deviceId,
            kind = paired.kind, generation = 1, phase = RecoveryPhase.DATASET_RESET_PENDING.name, pinSha256 = pin,
            datasetResetEpoch = "8b134f46-5501-4ba2-931e-fde1e7251951"))
        db.metaDao().put(MetaEntity("old", "business"))
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER refuse_dataset_purge BEFORE DELETE ON meta BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        val shell = vm()
        shell.datasetResetFailed.first { it }
        advanceUntilIdle()
        assertNull(shell.start.value)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER refuse_dataset_purge")
        shell.retryDatasetReset()
        assertEquals(StartDestination.SIGN_IN, shell.start.first { it != null })
        assertEquals("synthetic-key", credential.read())
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
    }

}
