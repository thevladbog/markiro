package app.markiro.handheld

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.DeviceWipe
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InMemoryCredentialStore
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
        AppShellViewModel(db.deviceConfigDao(), session, revocation, DeviceWipe(db, credential), idleMs = 5 * 60 * 1000L),
    )

    @Test
    fun startsOnPairingWithoutConfigAndOnSignInWithIt() = runTest {
        // Room answers observe() from its own executor, so wait for the first value instead of advancing.
        val a = vm()
        assertEquals(StartDestination.PAIRING, a.start.first { it != null })
        db.deviceConfigDao().upsert(paired)
        val b = vm()
        assertEquals(StartDestination.SIGN_IN, b.start.first { it != null })
    }

    @Test
    fun revocationWipesEverythingAndEmitsAnEvent() = runTest {
        db.deviceConfigDao().upsert(paired)
        credential.write("mk_live_abc")
        session.signIn(anna)
        val shell = vm()
        advanceUntilIdle()
        shell.events.test {
            revocation.raise()
            assertEquals(ShellEvent.Revoked, awaitItem())
        }
        assertNull(db.deviceConfigDao().get())
        assertNull(credential.read())
        assertNull(session.state.value.operator)
    }

    @Test
    fun idleTimeLocksASignedInSession() = runTest {
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
}
