package app.markiro.handheld

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubUi
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.inventory.RecordOutcome
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.feature.inventory.InventoryLastScan
import app.markiro.handheld.feature.inventory.InventoryLeaveScreen
import app.markiro.handheld.feature.inventory.InventoryListCallbacks
import app.markiro.handheld.feature.inventory.InventoryListScreen
import app.markiro.handheld.feature.inventory.InventoryListUi
import app.markiro.handheld.feature.inventory.InventoryProgress
import app.markiro.handheld.feature.inventory.InventoryWorkCallbacks
import app.markiro.handheld.feature.inventory.InventoryWorkScreen
import app.markiro.handheld.feature.inventory.InventoryWorkUi
import app.markiro.handheld.feature.inventory.LeaveStep
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.feature.printer.AddPrinterCallbacks
import app.markiro.handheld.feature.printer.AddPrinterForm
import app.markiro.handheld.feature.printer.AddPrinterScreen
import app.markiro.handheld.feature.printer.PrinterListCallbacks
import app.markiro.handheld.feature.printer.PrinterListScreen
import app.markiro.handheld.feature.printer.PrinterUi
import app.markiro.handheld.feature.printer.TestPrintCallbacks
import app.markiro.handheld.feature.printer.TestPrintScreen
import app.markiro.handheld.feature.printer.TestPrintStep
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingUi
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInUi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

private val cyrillic = Regex("[А-Яа-яЁё]")
private val hasCyrillic = SemanticsMatcher("has Cyrillic text") { node ->
    val texts = node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
        listOfNotNull(node.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString())
    texts.any { cyrillic.containsMatchIn(it) }
}

/** Under an English locale no screen may leak a Russian literal. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "en-rUS-w360dp-h640dp")
class EnglishRenderTest {
    @get:Rule
    val compose = createComposeRule()

    private fun assertNoCyrillic() = assertEquals(0, compose.onAllNodes(hasCyrillic).fetchSemanticsNodes().size)

    @Test
    fun hubRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi("Test Plant", "Anna Ivanova", "Line 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false, scannerLabel = "Zebra"),
                    onTile = {},
                    onSignOut = {},
                )
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun pairingRendersInEnglish() {
        compose.setContent { MarkiroTheme { PairingScreen(PairingUi.Enter("", "https://x", true), PairingCallbacks()) } }
        assertNoCyrillic()
    }

    @Test
    fun signInRendersInEnglish() {
        compose.setContent { MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Anna Ivanova", lockMode = true), SignInCallbacks()) } }
        assertNoCyrillic()
    }

    @Test
    fun inventoryListRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(
                        loading = false,
                        active = InventoryFixtures.task("i1").copy(productPrintName = "Water"),
                        mine = listOf(InventoryTaskDto("i2", "INV-0008", "Juice", null, "repack", "l1", "Line 2", "2026-08-01", "2026-08-31")),
                        others = emptyMap(), othersExpanded = false, othersLoading = false, reachable = false, ownLineName = "Line 2",
                        listFetchedAt = 0L, dialog = null,
                    ),
                    InventoryListCallbacks(),
                )
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun inventoryWorkRendersInEnglish() {
        val ui = InventoryWorkUi(
            task = InventoryFixtures.task("i1").copy(productPrintName = "Water"), expectedCount = 100, activeDate = "2026-08-20",
            last = InventoryLastScan(InventoryVerdict.PROTECTED, "…1234", null, false, null, null, null, null),
            progress = InventoryProgress(1, 2, 3, 4, 5), feed = emptyList(), sync = InventorySyncState(pending = 2), reachable = false,
            held = RecordOutcome.DateMismatch("2026-08-20", "2026-08-22", false, "raw"), closed = false,
        )
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui, InventoryWorkCallbacks()) } }
        assertNoCyrillic()
    }

    @Test
    fun inventoryLeaveRendersInEnglish() {
        compose.setContent { MarkiroTheme { InventoryLeaveScreen(LeaveStep.Offline(3), onDone = {}, onBack = {}) } }
        assertNoCyrillic()
    }

    @Test
    fun printerListRendersInEnglish() {
        val printer = PrinterEntity(
            "p1", "Zebra ZD421", "wifi", "192.168.1.40:9100", "zpl", 203,
            selected = true, lastStatus = "ready", lastSeenAt = 1L,
        )
        compose.setContent {
            MarkiroTheme {
                PrinterListScreen(PrinterUi(printers = listOf(printer), selected = printer), PrinterListCallbacks())
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun addPrinterRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                AddPrinterScreen(
                    AddPrinterForm(host = "192.168.1.40", error = NotReadyReason.NO_PAPER),
                    AddPrinterCallbacks(),
                )
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun anUnknownPrintResultRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(TestPrintStep.Unknown("link lost"), PrinterLanguage.ZPL, 203, TestPrintCallbacks())
            }
        }
        assertNoCyrillic()
    }
}
