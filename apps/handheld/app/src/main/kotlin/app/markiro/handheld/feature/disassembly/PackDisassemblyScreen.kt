package app.markiro.handheld.feature.disassembly

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.feature.exceptions.ActionRow
import app.markiro.handheld.R
import app.markiro.handheld.core.design.*
import app.markiro.handheld.core.network.host.PackInspectionDto
import app.markiro.handheld.core.network.host.PackReasonDto

@Composable
fun PackDisassemblyScreen(
    step:PackDisassemblyStep,
    onBack:()->Unit,
    onReason:(PackReasonDto)->Unit,
    onConfirm:()->Unit,
    onRetry:()->Unit,
    onReset:()->Unit,
    onArchive:()->Unit,
){
    var confirmArchive by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(MarkiroTheme.colors.surfacePage)) {
        AppBar(stringResource(R.string.pack_disassembly_title),onBack=onBack)
        when(step){
            PackDisassemblyStep.Loading -> FullScreenState(Icons.Outlined.Sync,stringResource(R.string.pack_disassembly_working),stringResource(R.string.pack_disassembly_wait))
            PackDisassemblyStep.Scan -> FullScreenState(Icons.Outlined.QrCodeScanner,stringResource(R.string.pack_disassembly_scan),stringResource(R.string.pack_disassembly_scan_body))
            is PackDisassemblyStep.Reason -> ScreenColumn(padding=PaddingValues(MarkiroSizes.sp4),verticalArrangement=Arrangement.spacedBy(MarkiroSizes.sp3)) {
                PackSummary(step.pack)
                Text(stringResource(R.string.pack_disassembly_reason),style=MarkiroTheme.type.title,color=MarkiroTheme.colors.fg1)
                if(step.pack.reasons.isEmpty()) Text(stringResource(R.string.pack_disassembly_no_reasons),color=MarkiroTheme.colors.fg2)
                step.pack.reasons.forEach { reason -> ActionRow(Icons.Outlined.Inventory2,reason.name,true,"",{onReason(reason)}) }
                SecondaryButton(stringResource(R.string.common_cancel),onReset)
            }
            is PackDisassemblyStep.Confirm -> ScreenColumn(padding=PaddingValues(MarkiroSizes.sp4),verticalArrangement=Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(R.string.pack_disassembly_confirm),style=MarkiroTheme.type.title,color=MarkiroTheme.colors.fg1)
                PackSummary(step.pack)
                Text(step.reason.name,style=MarkiroTheme.type.body,color=MarkiroTheme.colors.fg1)
                Text(stringResource(if(step.pack.kind=="box") R.string.pack_disassembly_box_effect else R.string.pack_disassembly_pallet_effect),color=MarkiroTheme.colors.fg2)
                PrimaryButton(stringResource(R.string.pack_disassembly_apply),onConfirm)
                SecondaryButton(stringResource(R.string.common_cancel),onReset)
            }
            is PackDisassemblyStep.Done -> FullScreenState(Icons.Outlined.CheckCircle,stringResource(R.string.pack_disassembly_done),stringResource(R.string.pack_disassembly_document,step.result.docNo),primary=StateAction(stringResource(R.string.pack_disassembly_next),onReset),tone=Tone.Ok)
            is PackDisassemblyStep.Failed -> FullScreenState(Icons.Outlined.Warning,stringResource(R.string.pack_disassembly_refused),stringResource(problemText(step.problem)),primary=StateAction(stringResource(R.string.common_retry),onReset),tone=Tone.Warn)
            is PackDisassemblyStep.Pending -> ScreenColumn(padding=PaddingValues(MarkiroSizes.sp4),verticalArrangement=Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(if(step.sealed) R.string.pack_disassembly_sealed else R.string.pack_disassembly_unknown),style=MarkiroTheme.type.title,color=MarkiroTheme.colors.fg1)
                PackSummary(step.operation.inspection)
                Text(stringResource(if(step.sealed) R.string.pack_disassembly_sealed_body else R.string.pack_disassembly_unknown_body),color=MarkiroTheme.colors.fg2)
                Text(stringResource(R.string.pack_disassembly_request,step.operation.request().requestId),style=MarkiroTheme.type.caption,color=MarkiroTheme.colors.fg3)
                step.problem?.let { Text(stringResource(problemText(it)),color=MarkiroTheme.colors.fg2) }
                if(step.sealed) SecondaryButton(stringResource(R.string.pack_disassembly_archive),{confirmArchive=true})
                else PrimaryButton(stringResource(R.string.pack_disassembly_check_result),onRetry)
                SecondaryButton(stringResource(R.string.pack_disassembly_to_hub),onBack)
            }
        }
    }
    if(confirmArchive && step is PackDisassemblyStep.Pending && step.sealed) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest={confirmArchive=false},
            title={Text(stringResource(R.string.pack_disassembly_archive_confirm))},
            text={Text(stringResource(R.string.pack_disassembly_archive_body))},
            confirmButton={androidx.compose.material3.TextButton(onClick={confirmArchive=false;onArchive()}) {Text(stringResource(R.string.pack_disassembly_archive))}},
            dismissButton={androidx.compose.material3.TextButton(onClick={confirmArchive=false}) {Text(stringResource(R.string.common_cancel))}},
            containerColor=MarkiroTheme.colors.surfacePanel,
        )
    }
}
@Composable private fun PackSummary(pack:PackInspectionDto){
    Text(stringResource(if(pack.kind=="box") R.string.pack_disassembly_box else R.string.pack_disassembly_pallet),style=MarkiroTheme.type.caption,color=MarkiroTheme.colors.fg3)
    Text("(00)${pack.sscc}",style=MarkiroTheme.type.title,color=MarkiroTheme.colors.fg1)
    Text(pack.productName,style=MarkiroTheme.type.body,color=MarkiroTheme.colors.fg1)
    Text(stringResource(R.string.pack_disassembly_counts,pack.boxes,pack.units),color=MarkiroTheme.colors.fg2)
}
private fun problemText(code:String):Int=when(code){
    "invalid_sscc" -> R.string.pack_disassembly_invalid
    "pack_not_found" -> R.string.pack_disassembly_not_found
    "pack_changed" -> R.string.pack_disassembly_changed
    "shift_open" -> R.string.pack_disassembly_shift_open
    "not_closed" -> R.string.pack_disassembly_not_closed
    "already_disassembled" -> R.string.pack_disassembly_already
    "forbidden" -> R.string.pack_disassembly_forbidden
    "restore_hold" -> R.string.pack_disassembly_restore
    "host_update" -> R.string.pack_disassembly_host_update
    "demo_box","cloud_history" -> R.string.pack_disassembly_office_only
    "reason_required" -> R.string.pack_disassembly_no_reasons
    "recovery","certificate","host_only" -> R.string.pack_disassembly_recovery
    "saved_unreadable" -> R.string.pack_disassembly_unreadable
    else -> R.string.pack_disassembly_unavailable
}
