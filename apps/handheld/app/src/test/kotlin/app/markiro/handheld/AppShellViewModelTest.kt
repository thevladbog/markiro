package app.markiro.handheld

import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.DeviceWipe
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.OperatorDao
import app.markiro.handheld.core.storage.OperatorEntity
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AppShellViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val configFlow = MutableStateFlow<DeviceConfigEntity?>(null)
    private val config = object : DeviceConfigDao {
        override fun observe(): Flow<DeviceConfigEntity?> = configFlow
        override suspend fun get() = configFlow.value
        override suspend fun count() = if (configFlow.value == null) 0 else 1
        override suspend fun upsert(config: DeviceConfigEntity) {
            configFlow.value = config
        }
        override suspend fun clear() {
            configFlow.value = null
        }
    }
    private val operators = object : OperatorDao {
        val rows = mutableListOf<OperatorEntity>()
        override suspend fun all() = rows.toList()
        override suspend fun insertAll(rows: List<OperatorEntity>) {
            this.rows += rows
        }
        override suspend fun clear() = rows.clear()
    }
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

    private fun vm() = AppShellViewModel(config, session, revocation, DeviceWipe(config, operators, credential), idleMs = 5 * 60 * 1000L)

    @Test
    fun startsOnPairingWithoutConfigAndOnSignInWithIt() = runTest {
        val a = vm()
        advanceUntilIdle()
        assertEquals(StartDestination.PAIRING, a.start.value)
        configFlow.value = paired
        val b = vm()
        advanceUntilIdle()
        assertEquals(StartDestination.SIGN_IN, b.start.value)
    }

    @Test
    fun revocationWipesEverythingAndEmitsAnEvent() = runTest {
        configFlow.value = paired
        credential.write("mk_live_abc")
        session.signIn(anna)
        val shell = vm()
        advanceUntilIdle()
        shell.events.test {
            revocation.raise()
            assertEquals(ShellEvent.Revoked, awaitItem())
        }
        assertNull(configFlow.value)
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
