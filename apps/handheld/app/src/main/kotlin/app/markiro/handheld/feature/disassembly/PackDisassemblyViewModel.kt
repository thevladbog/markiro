package app.markiro.handheld.feature.disassembly

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.host.*
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.inventory.ScanInput
import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface PackDisassemblyStep {
    data object Loading:PackDisassemblyStep
    data object Scan:PackDisassemblyStep
    data class Reason(val pack:PackInspectionDto,val operatorId:String):PackDisassemblyStep
    data class Confirm(val pack:PackInspectionDto,val reason:PackReasonDto,val operatorId:String):PackDisassemblyStep
    data class Pending(val operation:PendingPackDisassembly,val sealed:Boolean,val problem:String?=null):PackDisassemblyStep
    data class Done(val result:PackDisassembledDto):PackDisassemblyStep
    data class Failed(val problem:String):PackDisassemblyStep
}
@HiltViewModel
class PackDisassemblyViewModel @Inject constructor(
    private val gateway:PackDisassemblyGateway,
    private val session:SessionHolder,
    scans:ScanEvents,
):ViewModel(){
    private val mutable=MutableStateFlow<PackDisassemblyStep>(PackDisassemblyStep.Loading)
    val step:StateFlow<PackDisassemblyStep> = mutable
    private var initialized=false
    private var inspection:InspectedPack?=null
    init {
        reset()
        viewModelScope.launch { scans.events.collect { event -> if(mutable.value==PackDisassemblyStep.Scan) scan(event.raw) } }
    }
    private fun operator()=session.state.value.takeUnless { it.locked }?.operator?.operatorId
    fun reset(){
        if(mutable.value==PackDisassemblyStep.Loading && initialized) return
        initialized=true;inspection=null;mutable.value=PackDisassemblyStep.Loading
        viewModelScope.launch {
            try { showPendingOrScan() }
            catch(blocked:RecoveryBlocked){mutable.value=PackDisassemblyStep.Failed("recovery")}
            catch(cancelled:CancellationException){throw cancelled}
            catch(_:Exception){mutable.value=PackDisassemblyStep.Failed("saved_unreadable")}
        }
    }
    private suspend fun showPendingOrScan(problem:String?=null){
        val pending=try { gateway.pending() }
        catch(cancelled:CancellationException){throw cancelled}
        catch(_:Exception){mutable.value=PackDisassemblyStep.Failed("saved_unreadable");return}
        mutable.value=if(pending==null) {
            if(problem==null) PackDisassemblyStep.Scan else PackDisassemblyStep.Failed(problem)
        } else PackDisassemblyStep.Pending(pending,operator()?.let { !gateway.canResume(pending,it) }?:true,problem)
    }
    private fun scan(raw:String){
        val sscc=(ScanClassifier.classify(raw) as? ScanInput.Sscc)?.sscc
        if(sscc==null){mutable.value=PackDisassemblyStep.Failed("invalid_sscc");return}
        val op=operator()?:run{mutable.value=PackDisassemblyStep.Failed("forbidden");return}
        mutable.value=PackDisassemblyStep.Loading
        viewModelScope.launch {
            try {
                val looked=gateway.lookup(sscc,op)
                inspection=looked
                val pack=looked.data
                mutable.value=if(pack.status=="ok") PackDisassemblyStep.Reason(pack,op) else PackDisassemblyStep.Failed(pack.status)
            } catch(blocked:RecoveryBlocked){mutable.value=PackDisassemblyStep.Failed("recovery")}
            catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){mutable.value=PackDisassemblyStep.Failed((error as? PackDisassemblyFailure)?.code?:"unavailable")}
        }
    }
    fun chooseReason(reason:PackReasonDto){
        val at=mutable.value as? PackDisassemblyStep.Reason?:return
        if(reason !in at.pack.reasons)return
        mutable.value=PackDisassemblyStep.Confirm(at.pack,reason,at.operatorId)
    }
    fun confirm(){
        val at=mutable.value as? PackDisassemblyStep.Confirm?:return
        if(operator()!=at.operatorId){mutable.value=PackDisassemblyStep.Failed("forbidden");return}
        val looked=inspection
        if(looked==null || looked.data!=at.pack || looked.operatorId!=at.operatorId) {mutable.value=PackDisassemblyStep.Failed("recovery");return}
        // Synchronous state change excludes both a second tap and a scanner retarget.
        mutable.value=PackDisassemblyStep.Loading
        viewModelScope.launch {
            try { submit(gateway.prepare(looked,at.reason,at.operatorId)) }
            catch(blocked:RecoveryBlocked){showPendingOrScan("recovery")}
            catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){showPendingOrScan((error as? PackDisassemblyFailure)?.code?:"unavailable")}
        }
    }
    private suspend fun submit(pending:PendingPackDisassembly){
        val op=operator()
        if(op==null || !gateway.canResume(pending,op)) { mutable.value=PackDisassemblyStep.Pending(pending,true);return }
        mutable.value=PackDisassemblyStep.Done(gateway.submit(pending))
    }
    fun retry(){
        val at=mutable.value as? PackDisassemblyStep.Pending?:return
        if(at.sealed)return
        mutable.value=PackDisassemblyStep.Loading
        viewModelScope.launch {
            try { submit(at.operation) }
            catch(blocked:RecoveryBlocked){showPendingOrScan("recovery")}
            catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){showPendingOrScan((error as? PackDisassemblyFailure)?.code?:"unavailable")}
        }
    }
    fun archive(){
        val at=mutable.value as? PackDisassemblyStep.Pending?:return
        if(!at.sealed)return
        mutable.value=PackDisassemblyStep.Loading
        viewModelScope.launch {
            try { gateway.archive(at.operation);showPendingOrScan() }
            catch(blocked:RecoveryBlocked){mutable.value=at}
            catch(cancelled:CancellationException){throw cancelled}
            catch(_:Exception){mutable.value=at.copy(problem="unavailable")}
        }
    }
}
