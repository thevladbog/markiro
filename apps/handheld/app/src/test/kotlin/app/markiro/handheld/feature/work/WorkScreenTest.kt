package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.network.ParticipantDto
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.text.NumberFormat

@RunWith(AndroidJUnit4::class)
class WorkScreenTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * The feed printed the raw tail, which on a real code is the crypto
     * signature: «…5\u001d93txKP» named no unit and did not match the serial
     * shown for the same scan two centimetres higher.
     */
    @Test
    fun theFeedShowsTheSerialNotTheCryptoTail() {
        val km = "010460068200001321ABCDEF1234\u001d93XyZw"
        assertEquals("ABCDEF1234".takeLast(8).let { "…" + it }, feedTail(km))
        // A code that does not parse keeps its raw tail: for a rejected scan the
        // raw text is the only thing there is to show.
        assertEquals("garbage", feedTail("garbage"))
    }

    @Test
    fun acceptedCodeWithScannerPaddingStillShowsItsSerial() {
        val raw = " \t]d2010460068200001321ABCDEF1234\u001d93CRYPTOtail \t"
        assertEquals("…CDEF1234", feedTail(raw))
    }

    @Test
    fun malformedCodeDoesNotExposeAnythingAfterGs() {
        assertEquals("…CDEF1234", feedTail("brokenABCDEF1234\u001d93CRYPTOtail"))
    }

    private val ui = WorkUi(
        shift = ShiftEntityFixtures.bundled("s1"),
        last = LastScan(Verdict.DUPLICATE, "…1234567", firstSeenAt = "2026-09-10T07:42:00.000Z", at = "2026-09-10T08:00:00.000Z"),
        total = 1240, plan = 3000, thisTerminal = 312, errors = 4, duplicates = 2,
        feed = listOf(ScanEventEntity(1, "s1", "raw", "ok", "2026-09-10T08:00:00.000Z", null, "h")),
        sync = SyncState(pending = 37), reachable = false,
        team = TeamState(participants = emptyList(), acceptedUnits = 1240, at = 0L),
    )

    @Test
    fun rendersVerdictCountersBannerAndOverflowActions() {
        var closed = false
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks(onClose = { closed = true })) } }
        val numbers = NumberFormat.getIntegerInstance()
        compose.onNodeWithText("ДУБЛЬ").assertIsDisplayed()
        compose.onNodeWithText("Первый скан в", substring = true).assertIsDisplayed()
        compose.onNodeWithText("${numbers.format(1240)} / ${numbers.format(3000)}").assertIsDisplayed()
        compose.onNodeWithText("312").assertIsDisplayed()
        compose.onNodeWithText("Ошибки").assertIsDisplayed()
        compose.onNodeWithText("4").assertIsDisplayed()
        compose.onNodeWithText("Дубли").assertIsDisplayed()
        compose.onNodeWithText("2").assertIsDisplayed()
        compose.onNodeWithText("Работаем офлайн · 37 сканов в очереди").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ещё").performClick()
        compose.onNodeWithText("Закрыть смену").performClick()
        assertEquals(true, closed)
    }

    @Test
    fun validationStatusKeepsSeparateErrorAndDuplicateCounters() {
        compose.setContent {
            MarkiroTheme {
                WorkScreen(ui.copy(validation = ValidationUi(pending = 9)), WorkCallbacks())
            }
        }
        compose.onNodeWithText("Ожидают подтверждения: 9").assertIsDisplayed()
        compose.onNodeWithText("Ошибки").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("4").assertIsDisplayed()
        compose.onNodeWithText("Дубли").assertIsDisplayed()
        compose.onNodeWithText("2").assertIsDisplayed()
    }

    @Test
    fun teamChipCountsParticipantsOtherThanTheSignedInOperator() {
        val ivan = ParticipantDto("op-2", "Петров Иван", null, "2026-09-10T07:00:00.000Z", "2026-09-10T07:30:00.000Z", 2, 0)
        // This operator's scans are still queued, so the summary lists only the teammate: the chip must still say +1.
        val absent = ui.copy(team = TeamState(listOf(ivan), 2, 0L), operatorId = "op-1")
        compose.setContent { MarkiroTheme { WorkScreen(absent, WorkCallbacks()) } }
        compose.onNodeWithText("+1").assertIsDisplayed()
        compose.onNodeWithText("+1").performClick()
        compose.onNodeWithText("Петров Иван").assertIsDisplayed()
    }

    /**
     * The feed renders whatever the journal holds, and the journal holds
     * `undone` as soon as the operator takes a scan back. `Verdict.fromWire`
     * threw on it and took the whole screen down on the main thread -- a crash
     * the emulator walk-through found and no unit test had reached, because
     * none of them rendered the feed after an undo.
     */
    @Test
    fun anUndoneScanRendersInTheFeed() {
        compose.setContent {
            MarkiroTheme {
                WorkScreen(
                    ui.copy(feed = listOf(ScanEventEntity(1, "s1", "raw", "undone", "2026-09-10T08:00:00.000Z", null, "h"))),
                    WorkCallbacks(),
                )
            }
        }
        compose.onNodeWithText("ОТМЕНЁН").assertIsDisplayed()
    }

    /** A row written by a newer build must not take the screen down either. */
    @Test
    fun anUnknownVerdictRendersAsItself() {
        compose.setContent {
            MarkiroTheme {
                WorkScreen(
                    ui.copy(feed = listOf(ScanEventEntity(1, "s1", "raw", "from_the_future", "2026-09-10T08:00:00.000Z", null, "h"))),
                    WorkCallbacks(),
                )
            }
        }
        compose.onNodeWithText("from_the_future").assertIsDisplayed()
    }
}
