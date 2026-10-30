package app.markiro.handheld.feature.disassembly

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.network.host.PackInspectionDto
import app.markiro.handheld.core.network.host.PackReasonDto
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers="ru-w360dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PackDisassemblyScreenTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
    private val reason=PackReasonDto("r","Повреждена упаковка")
    private val card=PackInspectionDto("146012345600000006","pallet","Вода питьевая «Родник» негазированная 0,5 л",2,24,"ok","a".repeat(64),listOf(reason))
    private fun show(step:PackDisassemblyStep,dark:Boolean=false,onReason:(PackReasonDto)->Unit={},onConfirm:()->Unit={}) {
        compose.setContent { MarkiroTheme(dark=dark) { PackDisassemblyScreen(step,{},onReason,onConfirm,{},{},{}) } }
    }
    private fun capture(name:String){
        compose.waitForIdle()
        val bitmap=compose.runOnIdle { val view=compose.activity.window.decorView;Bitmap.createBitmap(view.width,view.height,Bitmap.Config.ARGB_8888).also {view.draw(Canvas(it))} }
        assertEquals(360,bitmap.width)
        val folder=File("build/disassembly-visuals").also {it.mkdirs()}
        File(folder,"$name.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
    }
    @Test fun scanNamesBothPackKindsAndTheHostRequirement(){
        show(PackDisassemblyStep.Scan)
        compose.onNodeWithText("Сканируйте SSCC упаковки").assertIsDisplayed()
        compose.onNodeWithText("Короб или палет, в том числе собранный в офисе или на другом ТСД. Нужна связь с хостом.").assertIsDisplayed()
        capture("ru-light-scan")
    }
    @Test fun aLongOfficeReasonIsFullyReadableAndSelectableOn360dp(){
        val long=reason.copy(name="Повреждение транспортной упаковки при перемещении готовой продукции между производственной линией и складом предприятия")
        var chosen:PackReasonDto?=null
        show(PackDisassemblyStep.Reason(card.copy(reasons=listOf(long)),"operator"),onReason={chosen=it})
        val node=compose.onNodeWithText(long.name).performScrollTo().assertIsDisplayed()
        val layouts=mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {it(layouts)}
        assertFalse("The full reason must not be clipped",layouts.single().hasVisualOverflow)
        node.performClick();assertEquals(long,chosen)
        capture("ru-light-reason")
    }
    @Test fun palletConfirmationKeepsBoxesAndNeedsItsOwnPress(){
        var presses=0
        show(PackDisassemblyStep.Confirm(card,reason,"operator"),onConfirm={presses++})
        compose.onNodeWithText("Расформировать упаковку?").assertIsDisplayed()
        compose.onNodeWithText("Короба выйдут из палета и сохранят свои коды. Их можно собрать на другой палет. Это действие нельзя отменить.").assertIsDisplayed()
        compose.onNodeWithText("Расформировать",useUnmergedTree=true).performScrollTo().performClick();assertEquals(1,presses)
        capture("ru-light-pallet-confirm")
    }
    @Test fun boxConfirmationExplainsThatUnitCodesBecomeAvailable(){
        show(PackDisassemblyStep.Confirm(card.copy(kind="box",sscc="046012345600000016",boxes=1,units=12),reason,"operator"),dark=true)
        compose.onNodeWithText("Коды выйдут из короба и станут свободными. SSCC короба больше не используется. Это действие нельзя отменить.").assertIsDisplayed()
        compose.onNodeWithText("Расформировать",useUnmergedTree=true).performScrollTo().assertIsDisplayed()
        capture("ru-dark-box-confirm")
    }
    @Test @Config(qualifiers="en-w360dp-h640dp-mdpi") fun englishConfirmationKeepsItsActionsReachable(){
        show(PackDisassemblyStep.Confirm(card,reason.copy(name="Damaged packaging"),"operator"))
        compose.onNodeWithText("Disassemble this pack?").assertIsDisplayed()
        compose.onNodeWithText("Disassemble",useUnmergedTree=true).performScrollTo().assertIsDisplayed()
        capture("en-light-pallet-confirm")
    }
}
