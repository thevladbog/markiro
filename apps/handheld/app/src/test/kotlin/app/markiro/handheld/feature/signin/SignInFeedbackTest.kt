package app.markiro.handheld.feature.signin

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.MutableSharedFlow
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

/**
 * What the sign-in screen must always say (owner report after a host pairing: «пользователя не находит, а при сканировании бейджа ничего не
 * говорит»): every scan and every personnel number ends in a visible outcome, an empty or stale roster is refreshed from the host first and
 * named when it is the reason, and the roster's state (count, time) is visible with a retry.
 */
@RunWith(AndroidJUnit4::class)
class SignInFeedbackTest {
    private lateinit var db: HandheldDatabase
    private lateinit var recovery: DeviceRecovery

    @Before fun setup() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        recovery = db.initializeRecoveryForTest()
    }

    @After fun close() { main.cancelAndJoinModels(); db.close() }

    @get:Rule val main = MainDispatcherRule()

    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "PIN:1234", null, true, listOf("BADGE:735519"))
    private val blocked = OperatorRecord("op-9", "Уволенный Иван", "9001", "operator", "PIN:1234", "BADGE:BLOCKED1", false)
    private var records: List<OperatorRecord> = emptyList()
    private val verified = mutableListOf<String>()
    private val auth = OperatorAuth(object : OperatorRoster { override suspend fun operators() = records }, main.dispatcher) { secret, phc ->
        verified += secret
        phc == "PIN:$secret" || phc == "BADGE:$secret"
    }
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder()
    private var now = 1_000_000L

    private class FakeSource(val onRefresh: () -> Boolean) : RosterSource {
        var calls = 0
        var at: Long? = null
        override suspend fun refreshRoster(): Boolean { calls++; return onRefresh().also { if (it) at = 77L } }
        override suspend fun rosterFetchedAt() = at
    }

    private fun vm(source: RosterSource? = null) = main.track(SignInViewModel(recovery, auth, session, scans, source) { now })

    private fun scan(raw: String) { scans.tryEmit(ScanEvent(raw, null, "debug", now)) }

    @Test
    fun aBadgeScanWithAnEmptyRosterSaysTheRosterIsNotLoadedInsteadOfNothing() = runTest {
        val vm = vm(FakeSource { false })
        advanceUntilIdle()
        scan("735519")
        advanceUntilIdle()
        assertEquals(SignInError.ROSTER_EMPTY, (vm.state.value as SignInUi.Login).error)
        assertNull(session.state.value.operator)
    }

    @Test
    fun anEmptyRosterIsReadFromTheHostFirstAndTheBadgeThenSignsIn() = runTest {
        val source = FakeSource { records = listOf(anna); true }
        vm(source)
        advanceUntilIdle()
        // The sign-in's own first read already filled it; empty the mirror again to model a host that got the operator later.
        records = emptyList()
        now += 10_000
        scan("735519")
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
        assertTrue("the roster was read again on the miss", source.calls >= 2)
    }

    @Test
    fun anUnknownBadgeWithARosterThatIsStaleIsRefreshedOnceThenReportedUnknown() = runTest {
        records = listOf(anna)
        val source = FakeSource { true }
        val vm = vm(source)
        advanceUntilIdle()
        val before = source.calls
        now += 10_000
        scan("000000")
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_UNKNOWN, (vm.state.value as SignInUi.Login).error)
        assertEquals(before + 1, source.calls)
    }

    @Test
    fun repeatedMissesDoNotHammerTheHost() = runTest {
        records = listOf(anna)
        val source = FakeSource { true }
        vm(source)
        advanceUntilIdle()
        now += 10_000
        scan("111111"); advanceUntilIdle()
        val afterFirst = source.calls
        now += 100
        scan("222222"); advanceUntilIdle()
        assertEquals("a second miss within the gap does not read the host again", afterFirst, source.calls)
    }

    @Test
    fun theBadgeOfABlockedOperatorSaysAccessDenied() = runTest {
        records = listOf(anna, blocked)
        val vm = vm()
        advanceUntilIdle()
        scan("BLOCKED1")
        advanceUntilIdle()
        assertEquals(SignInError.ACCESS_DENIED, (vm.state.value as SignInUi.Login).error)
        assertNull(session.state.value.operator)
    }

    @Test
    fun aProductCodeAndAForeignLayoutAreNamedAndNeverHashed() = runTest {
        records = listOf(anna)
        val vm = vm()
        advanceUntilIdle()
        verified.clear()
        scan("0104600682000013\u001d2150")
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_PRODUCT_CODE, (vm.state.value as SignInUi.Login).error)
        scan("БЕЙДЖ1")
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_LAYOUT, (vm.state.value as SignInUi.Login).error)
        assertEquals(emptyList<String>(), verified)
    }

    @Test
    fun aBadgeWithTrailingWhitespaceIsReadAsTheStationReadsIt() = runTest {
        records = listOf(anna)
        vm()
        advanceUntilIdle()
        scan("735519 \t")
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
    }

    @Test
    fun anUnknownPersonnelNumberIsReportedOnTheLoginStep() = runTest {
        records = listOf(anna)
        val vm = vm(FakeSource { true })
        advanceUntilIdle()
        "7777".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        val login = vm.state.value as SignInUi.Login
        assertEquals(SignInError.NOT_FOUND, login.error)
        assertEquals("7777", login.login)
    }

    @Test
    fun aPersonnelNumberWithAnEmptyRosterSaysTheRosterIsNotLoaded() = runTest {
        val vm = vm(FakeSource { false })
        advanceUntilIdle()
        "4127".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(SignInError.ROSTER_EMPTY, (vm.state.value as SignInUi.Login).error)
    }

    @Test
    fun aBlockedOperatorsNumberSaysAccessDenied() = runTest {
        records = listOf(anna, blocked)
        val vm = vm()
        advanceUntilIdle()
        "9001".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(SignInError.ACCESS_DENIED, (vm.state.value as SignInUi.Login).error)
    }

    @Test
    fun aScanOnTheSearchStepIsNotSilentEither() = runTest {
        records = listOf(anna)
        val vm = vm()
        advanceUntilIdle()
        vm.openSearch()
        scan("000000")
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_UNKNOWN, (vm.state.value as SignInUi.Search).error)
    }

    @Test
    fun theRosterStateShowsTheCountTheTimeAndAFailedRead() = runTest {
        records = listOf(anna, blocked)
        var up = true
        val source = FakeSource { up }
        val vm = vm(source)
        advanceUntilIdle()
        assertEquals(RosterInfo(count = 2, fetchedAt = 77L, refreshing = false, failed = false), vm.roster.value)
        up = false
        records = listOf(anna)
        vm.refreshRosterNow()
        advanceUntilIdle()
        assertEquals(RosterInfo(count = 1, fetchedAt = 77L, refreshing = false, failed = true), vm.roster.value)
    }

    @Test
    fun withoutASourceTheRosterStateIsTheLocalCopy() = runTest {
        records = listOf(anna)
        val vm = vm()
        advanceUntilIdle()
        assertEquals(RosterInfo(count = 1, fetchedAt = null, refreshing = false, failed = false), vm.roster.value)
    }
}
