package app.markiro.handheld.feature.signin

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster
import app.markiro.handheld.core.scan.ScanEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@RunWith(AndroidJUnit4::class)
class SignInViewModelTest {
    private lateinit var db: HandheldDatabase
    private lateinit var recovery: DeviceRecovery
    @Before fun setupRecovery() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        recovery = db.initializeRecoveryForTest()
    }
    @After fun closeRecovery() { main.cancelAndJoinModels(); db.close() }

    @get:Rule
    val main = MainDispatcherRule()

    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "PIN:1234", "BADGE:735519", true)
    private val roster = object : OperatorRoster {
        override suspend fun operators() = listOf(anna)
    }
    private val auth = OperatorAuth(roster, main.dispatcher) { secret, phc -> phc == "PIN:$secret" || phc == "BADGE:$secret" }
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder()

    private fun vm() = main.track(SignInViewModel(recovery, auth, session, scans))

    @Test
    fun loginThenPinSignsTheOperatorIn() = runTest {
        val vm = vm()
        "41".forEach { vm.onDigit(it) }
        vm.onConfirm()
        assertEquals(SignInUi.Pin(login = "041", operatorName = null, pin = "", error = null, lockMode = false), vm.state.value)
        vm.back()
        "4127".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals("Иванова Анна", (vm.state.value as SignInUi.Pin).operatorName)
        "1234".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
    }

    @Test
    fun wrongPinKeepsTheOperatorOnThePinStepWithAnError() = runTest {
        val vm = vm()
        "4127".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        "0000".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        val pin = vm.state.value as SignInUi.Pin
        assertEquals(SignInError.WRONG_PIN, pin.error)
        assertEquals("", pin.pin)
        assertNull(session.state.value.operator)
    }

    @Test
    fun badgeScanSignsInFromAnyStep() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("735519", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
        session.signOut()
        val again = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("000000", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_UNKNOWN, (again.state.value as SignInUi.Login).error)
    }

    @Test
    fun searchOffersMatchesAndPrefillsTheLogin() = runTest {
        val vm = vm()
        vm.openSearch()
        vm.onSearchQuery("ив")
        advanceUntilIdle()
        assertEquals(listOf(anna), (vm.state.value as SignInUi.Search).results)
        vm.onPickOperator(anna)
        advanceUntilIdle()
        assertEquals("4127", (vm.state.value as SignInUi.Pin).login)
    }

    @Test
    fun lockModeStartsOnThePinOfTheCurrentOperator() = runTest {
        session.signIn(anna)
        session.lock()
        val vm = vm()
        advanceUntilIdle()
        val pin = vm.state.value as SignInUi.Pin
        assertTrue(pin.lockMode)
        assertEquals("4127", pin.login)
        "1234".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(SessionState(anna, locked = false), session.state.value)
        vm.switchOperator()
        assertNull(session.state.value.operator)
        assertTrue(vm.state.value is SignInUi.Login)
    }
}
