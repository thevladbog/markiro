package app.markiro.handheld.feature.printer

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.MenuRow
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterRouting
import app.markiro.handheld.core.print.printableTemplate

@Composable
fun PrinterProfileScreen(
    printer: PrinterEntity,
    routing: PrinterRouting,
    templates: PrinterTemplatesUi,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onTest: () -> Unit,
    onTemplates: (PrintPurpose) -> Unit,
) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(printer.name, onBack)
        ScreenColumn(padding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(printer.address, style = MarkiroTheme.type.body, color = c.fg1)
            Text("${printer.language.uppercase()} · ${printer.dpi} dpi", style = MarkiroTheme.type.caption, color = c.fg2)
            if (templates.saved) Text(stringResource(R.string.template_saved), style = MarkiroTheme.type.body, color = c.okFg)
            PrintPurpose.entries.forEach { purpose ->
                val chosen = templates.chosen(printer.id, purpose)
                val name = templates.catalog.firstOrNull { it.id == chosen }?.name
                if (purpose == PrintPurpose.DUPLICATE) {
                    if (routing.resolve(purpose)?.id == printer.id) {
                        Text(stringResource(purposeLabel(purpose)), style = MarkiroTheme.type.strong, color = c.fg1)
                        Text(stringResource(R.string.template_duplicate_fixed), style = MarkiroTheme.type.caption, color = c.fg2)
                    }
                } else {
                    MenuRow(null, stringResource(purposeLabel(purpose)),
                        if (routing.resolve(purpose)?.id != printer.id) stringResource(R.string.printer_unassigned)
                        else name ?: stringResource(if (chosen == null) R.string.template_from_source else R.string.print_reason_template_incompatible),
                        { onTemplates(purpose) })
                }
            }
            MenuRow(null, stringResource(R.string.printer_edit), printer.address, onEdit)
            SecondaryButton(stringResource(R.string.printer_test_short), onTest)
        }
    }
}

@Composable
fun PrinterTemplateChooserScreen(
    printer: PrinterEntity,
    purpose: PrintPurpose,
    ui: PrinterTemplatesUi,
    onBack: () -> Unit,
    onSave: (String?, String?) -> Unit,
    onRefresh: () -> Unit,
) {
    val c = MarkiroTheme.colors
    if (ui.loading) {
        Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            AppBar(stringResource(R.string.template_choose), onBack)
            Text(stringResource(R.string.template_loading), style = MarkiroTheme.type.body, color = c.fg2, modifier = Modifier.padding(16.dp))
        }
        return
    }
    var selected by rememberSaveable(printer.id, purpose) { mutableStateOf(ui.chosen(printer.id, purpose)) }
    var preview by rememberSaveable(printer.id, purpose) { mutableStateOf(false) }
    var reviewedSpec by rememberSaveable(printer.id, purpose) { mutableStateOf<String?>(null) }
    val options = ui.catalog.filter { it.purpose == purpose.wire && printableTemplate(it.specJson) != null }
    val chosen = options.firstOrNull { it.id == selected }
    BackHandler(enabled = preview) { preview = false }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(if (preview) R.string.template_preview else R.string.template_choose), { if (preview) preview = false else onBack() })
        ScreenColumn(modifier = Modifier.weight(1f), padding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(printer.name + " · " + stringResource(purposeLabel(purpose)), style = MarkiroTheme.type.strong, color = c.fg1)
            Text(stringResource(R.string.template_assign_printer), style = MarkiroTheme.type.caption, color = c.fg2)
            if (preview && chosen != null) {
                val spec = printableTemplate(chosen.specJson)
                Text(chosen.name, style = MarkiroTheme.type.strong, color = c.fg1)
                if (spec != null) {
                    // The same supported spec is passed to print rendering; samples never become job data.
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        LabelPreview(spec, mapOf(
                            LabelField.PRODUCT_NAME to "Сидр яблочный 0,5 л",
                            LabelField.PRODUCT_PRINT_NAME to "Сидр 0,5 л",
                            LabelField.SSCC to "046800899000000018",
                            LabelField.QTY to "12", LabelField.QTY_BOXES to "4",
                            LabelField.DATE to "01.11.2026", LabelField.EXPIRY to "30.11.2026",
                            LabelField.SHIFT_NO to "14",
                        ), Modifier.widthIn(max = 220.dp))
                    }
                    Text(stringResource(R.string.template_size, spec.widthMm.toString(), spec.heightMm.toString()), style = MarkiroTheme.type.body, color = c.fg2)
                }
                Text(stringResource(R.string.template_preview_hint), style = MarkiroTheme.type.caption, color = c.fg2)
                Text(stringResource(R.string.template_new_jobs), style = MarkiroTheme.type.body, color = c.fg2)
            } else {
                TemplateOption(stringResource(R.string.template_from_source), stringResource(R.string.template_source_hint), selected == null) { selected = null }
                options.forEach { template ->
                    val spec = printableTemplate(template.specJson)
                    val size = spec?.let { stringResource(R.string.template_size, it.widthMm.toString(), it.heightMm.toString()) }.orEmpty()
                    TemplateOption(template.name, size, selected == template.id) { selected = template.id }
                    if (template.productId != null || template.groupCodes != null) Text(stringResource(R.string.template_scoped), style = MarkiroTheme.type.caption, color = c.fg2)
                }
                if (options.isEmpty()) Text(stringResource(R.string.template_empty), style = MarkiroTheme.type.strong, color = c.fg1)
                Text(stringResource(R.string.template_cached), style = MarkiroTheme.type.caption, color = c.fg2)
                if (ui.refreshFailed) Text(stringResource(R.string.template_refresh_failed), style = MarkiroTheme.type.body, color = c.warnFg)
                if (ui.refreshing) Text(stringResource(R.string.template_loading), style = MarkiroTheme.type.body, color = c.fg2)
                else if (ui.hostMode) MarkiroTextButton(stringResource(R.string.template_refresh), onRefresh)
            }
            if (ui.saveFailed || (preview && selected != null && chosen?.specJson != reviewedSpec)) Text(stringResource(R.string.template_save_failed), style = MarkiroTheme.type.body, color = c.errFg)
            // Inside the scroll area so keyboard/system font insets never cover this action.
            PrimaryButton(stringResource(if (preview || selected == null) R.string.template_save else R.string.template_next), {
                if (preview || selected == null) onSave(selected, reviewedSpec) else { reviewedSpec = chosen?.specJson; preview = true }
            }, enabled = purpose != PrintPurpose.DUPLICATE && (selected == null || (chosen != null && (!preview || chosen.specJson == reviewedSpec))))
        }
    }
}

@Composable
private fun TemplateOption(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).clip(RoundedCornerShape(8.dp)).background(c.surfaceCard)
        .selectable(selected = selected, role = Role.RadioButton, onClick = onClick).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onClick = null)
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(title, style = MarkiroTheme.type.strong, color = c.fg1)
            Text(subtitle, style = MarkiroTheme.type.caption, color = c.fg2)
        }
    }
}
