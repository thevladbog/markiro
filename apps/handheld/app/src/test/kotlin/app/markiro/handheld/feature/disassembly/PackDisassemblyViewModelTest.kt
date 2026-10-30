package app.markiro.handheld.feature.disassembly

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.host.*
import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.scan.*
import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PackDisassemblyViewModelTest {
    @get:Rule val main=MainDispatcherRule()
    private val operator="22222222-2222-4222-8222-222222222222"
    private val session=SessionHolder().apply { signIn(OperatorRecord(operator,"Сергей","1001","operator","x",null,true)) }
    private val scans=MutableSharedFlow<ScanEvent>(extraBufferCapacity=4)
    private val card=PackInspectionDto("146012345600000006","pallet","Вода",2,24,"ok","a".repeat(64),listOf(PackReasonDto("reason","Повреждена упаковка")))
    private val result=PackDisassembledDto("doc","DSG-26-0001",card.sscc,"pallet",0,0,"2026-10-30T15:00:00Z")
    private fun intent()=PendingPackDisassembly(DeviceOwner("https://host","host","dev","handheld","a".repeat(64)),1,null,Json.encodeToString(PackDisassembleDto.serializer(),PackDisassembleDto("request",card.sscc,operator,"reason",card.token)),card)
    private inner class Gateway:PackDisassemblyGateway {
        var saved:PendingPackDisassembly?=null;var current=true;var lookups=0;var prepares=0;val sent=mutableListOf<String>()
        var answer=CompletableDeferred<PackDisassembledDto>()
        override suspend fun pending()=saved
        override suspend fun canResume(pending:PendingPackDisassembly,operatorId:String)=current&&operatorId==operator
        override suspend fun lookup(sscc:String,operatorId:String):InspectedPack { lookups++;val p=intent();return InspectedPack(card,p.owner,p.generation,p.datasetEpoch,operatorId) }
        override suspend fun prepare(inspection:InspectedPack,reason:PackReasonDto,operatorId:String):PendingPackDisassembly { prepares++;return intent().also { saved=it } }
        override suspend fun submit(pending:PendingPackDisassembly):PackDisassembledDto { sent+=pending.body;return answer.await().also { saved=null } }
        override suspend fun archive(pending:PendingPackDisassembly) { saved=null }
    }
    private fun model(g:Gateway)=main.track(PackDisassemblyViewModel(g,session,ScanRouterAdapter(scans)))
    private suspend fun scan()=scans.emit(ScanEvent(card.sscc,null,"test",0))
    @Test fun laterScansNeverRetargetTheConfirmedPackAndDoubleTapSubmitsOnce()=runTest {
        val g=Gateway();val vm=model(g);runCurrent();scan();runCurrent();assertTrue(vm.step.value is PackDisassemblyStep.Reason)
        vm.chooseReason(card.reasons.single());scans.emit(ScanEvent("046012345600000016",null,"test",1));runCurrent();assertEquals(1,g.lookups)
        vm.confirm();vm.confirm();runCurrent();assertEquals(1,g.prepares);assertEquals(1,g.sent.size)
        g.answer.complete(result);runCurrent();assertEquals(PackDisassemblyStep.Done(result),vm.step.value)
    }
    @Test fun aRestartShowsTheSavedIntentWithoutAutomaticallyResendingIt()=runTest {
        val g=Gateway().apply { saved=intent() };val vm=model(g);runCurrent();assertTrue(vm.step.value is PackDisassemblyStep.Pending);assertTrue(g.sent.isEmpty())
        vm.retry();vm.retry();runCurrent();assertEquals(listOf(intent().body),g.sent);g.answer.complete(result);runCurrent();assertEquals(PackDisassemblyStep.Done(result),vm.step.value)
    }
    @Test fun anOperatorChangeBeforeConfirmationAppliesNothing()=runTest {
        val g=Gateway();val vm=model(g);runCurrent();scan();runCurrent();vm.chooseReason(card.reasons.single());session.signIn(OperatorRecord("other","Анна","1002","operator","x",null,true));vm.confirm();runCurrent()
        assertEquals(0,g.prepares);assertTrue(g.sent.isEmpty());assertTrue(vm.step.value is PackDisassemblyStep.Failed)
    }
    @Test fun oldOwnerEvidenceCannotBeRetriedAndMustBeArchivedExplicitly()=runTest {
        val g=Gateway().apply { saved=intent();current=false };val vm=model(g);runCurrent();val state=vm.step.value as PackDisassemblyStep.Pending;assertTrue(state.sealed)
        vm.retry();runCurrent();assertTrue(g.sent.isEmpty());vm.archive();runCurrent();assertEquals(PackDisassemblyStep.Scan,vm.step.value)
    }
}
