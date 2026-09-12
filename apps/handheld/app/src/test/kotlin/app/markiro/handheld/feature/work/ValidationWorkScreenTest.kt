package app.markiro.handheld.feature.work

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.scan.ValidationRefusal
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers="ru-w320dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ValidationWorkScreenTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
    private fun verify(english:Boolean) {
        val ui=WorkUi(ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm"),
            LastScan(Verdict.DUPLICATE,"…repeat",null,"2026-09-12T08:00:00Z",refusal=ValidationRefusal.CLOSURE_UNKNOWN),
            1,100,1,0,1,emptyList(),SyncState(pending=1),true,null,
            duplicate=DuplicateUi(false,false),validation=ValidationUi(1,1,"2026-09-12T08:00:00Z"))
        compose.setContent { MarkiroTheme { WorkScreen(ui,WorkCallbacks()) } }
        for(text in if(english) listOf("Awaiting confirmation: 1","Acceptance conflict: 1. Print history retained.","Source shift closure is not confirmed")
            else listOf("Ожидают подтверждения: 1","Конфликт приёмки: 1. История печати сохранена.","Закрытие исходной смены не подтверждено")) {
            val node=compose.onNodeWithText(text).assertIsDisplayed()
            val layouts=mutableListOf<TextLayoutResult>()
            node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertTrue(layouts.isNotEmpty()); for (layout in layouts) {
                assertEquals(text,layout.layoutInput.text.length,layout.getLineEnd(layout.lineCount-1,visibleEnd=true))
                assertTrue("$text size=${layout.size} bottom=${layout.getLineBottom(layout.lineCount-1)} paragraph=${layout.multiParagraph.height}",layout.getLineBottom(layout.lineCount-1)<=layout.size.height)
            }
        }
        val total=compose.onNodeWithText(compose.activity.getString(app.markiro.handheld.R.string.work_plan_of,"1","100")).fetchSemanticsNode().boundsInRoot
        // Both the terminal and duplicate counters legitimately show one. Resolve
        // the terminal value by the total row while retaining the geometry assertion.
        val ones=compose.onAllNodesWithText("1").assertCountEquals(2).fetchSemanticsNodes()
        val mine=ones.single { it.boundsInRoot.top == total.top }.boundsInRoot
        assertTrue("Counters need a visible gap",mine.left-total.right>=16)
        compose.onNodeWithText(if(english) "Errors" else "Ошибки").assertIsDisplayed()
        compose.onNodeWithText(if(english) "Duplicates" else "Дубли").assertIsDisplayed()
        val errors=compose.onNodeWithText("0").fetchSemanticsNode().boundsInRoot
        val duplicates=ones.single { it.boundsInRoot.top > total.top }.boundsInRoot
        assertTrue("Errors should have their own line",errors.top>=total.bottom)
        assertEquals("Error and duplicate values share a row", errors.top, duplicates.top)
        assertTrue("Counters need a visible gap",duplicates.left-errors.right>=16)
        compose.onNodeWithText("Вода 0,5").assertIsDisplayed()
        compose.onNodeWithText("SEP26-001").assertIsDisplayed()
        compose.onNodeWithContentDescription(if(english) "More" else "Ещё").assertIsDisplayed()
        compose.waitForIdle()
        // Opt-in evidence export; ordinary CI/test runs write no fixed external files.
        System.getenv("MARKIRO_HANDHELD_EVIDENCE_DIR")?.let { output ->
            compose.runOnIdle {
                val view=compose.activity.window.decorView
                val bitmap=android.graphics.Bitmap.createBitmap(view.width,view.height,android.graphics.Bitmap.Config.ARGB_8888)
                // Prime and redraw the native display lists after all UI assertions have settled.
                view.invalidate()
                view.draw(android.graphics.Canvas(bitmap))
                view.invalidate()
                view.draw(android.graphics.Canvas(bitmap))
                File(output).mkdirs()
                File(output,"validation-work-${if(english) "en" else "ru"}.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)
                }
                bitmap.recycle()
            }
        }
        compose.onNodeWithContentDescription(if(english) "More" else "Ещё").performClick()
        compose.onNodeWithText(if(english) "Close the shift" else "Закрыть смену").assertIsDisplayed()
    }
    @Test fun russianPendingConflictAndRefusalFitAndActionsRemainReachable()=verify(false)
    @Test @Config(qualifiers="en-w320dp-h640dp-mdpi") fun englishPendingConflictAndRefusalFitAndActionsRemainReachable()=verify(true)
}
