package app.markiro.handheld.feature.shift

import android.app.DatePickerDialog
import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.markiroFieldColors
import app.markiro.handheld.core.network.host.ShiftCreateProductDto
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

private enum class CreatePage { PRODUCT, FORM, MODE, PLAN, BOX, PALLET, SHEET }

data class CreateShiftCallbacks(
    val onBack: () -> Unit = {},
    val onReload: () -> Unit = {},
    val onSubmit: () -> Unit = {},
    val onSelect: (ShiftCreateProductDto) -> Unit = {},
    val onEdit: ((CreateShiftDraft) -> CreateShiftDraft) -> Unit = {},
    val onProductScanning: (Boolean) -> Unit = {},
)

@Composable
fun CreateShiftScreen(state: CreateShiftUi, cb: CreateShiftCallbacks) {
    val colors = MarkiroTheme.colors
    val type = MarkiroTheme.type
    val options = state.options
    val draft = state.draft
    val product = options?.let(draft::product)
    var pageOverride by rememberSaveable { mutableStateOf<CreatePage?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var selectedMode by rememberSaveable { mutableStateOf(CreateShiftMode.BOXES) }
    var planInput by rememberSaveable { mutableStateOf("") }
    val page = pageOverride ?: if (product == null) CreatePage.PRODUCT else CreatePage.FORM
    val editable = !state.pending && state.created == null && options != null
    val canEdit = editable && !state.busy
    val focus = LocalFocusManager.current

    fun back() {
        if (state.busy) return
        if (editable && page != CreatePage.FORM && page != CreatePage.PRODUCT) {
            pageOverride = null
        } else if (editable && pageOverride == CreatePage.PRODUCT && product != null) {
            pageOverride = null
        } else {
            cb.onBack()
        }
    }

    BackHandler { back() }
    DisposableEffect(editable, page) {
        cb.onProductScanning(editable && page == CreatePage.PRODUCT)
        onDispose { cb.onProductScanning(false) }
    }
    // Product scanner selects via the same draft path as tapping a result.
    LaunchedEffect(product?.id) {
        if (product != null) {
            focus.clearFocus()
            pageOverride = null
        }
    }

    val title = when (page) {
        CreatePage.PRODUCT -> if (product == null) R.string.shift_create_title else R.string.shift_create_product
        CreatePage.MODE -> R.string.shift_create_mode
        CreatePage.PLAN -> if (product?.setItems.isNullOrEmpty()) R.string.shift_create_plan else R.string.set_plan
        CreatePage.BOX -> R.string.shift_create_box_template
        CreatePage.PALLET -> R.string.shift_create_pallet_template
        CreatePage.SHEET -> R.string.shift_create_sheet
        CreatePage.FORM -> R.string.shift_create_title
    }
    Column(Modifier.fillMaxSize().background(colors.surfacePage).imePadding()) {
        AppBar(stringResource(if (editable) title else R.string.shift_create_title), ::back)
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            state.issue?.let { issue ->
                item { Text(stringResource(issue.message()), color = colors.warnFg, style = type.body) }
            }
            if (state.busy) item { Text(stringResource(R.string.shift_create_wait), style = type.caption, color = colors.fg2) }
            val created = state.created
            when {
                created != null -> item {
                    Text(stringResource(R.string.shift_create_saved, created.number), style = type.title, color = colors.fg1)
                    Text(stringResource(R.string.shift_create_saved_hint), style = type.body, color = colors.fg2)
                }
                state.pending -> item { Text(stringResource(R.string.shift_create_pending), style = type.body, color = colors.fg1) }
                options == null -> Unit
                page == CreatePage.PRODUCT -> {
                    item {
                        Text(options.lineName, style = type.title, color = colors.fg1)
                        Text(stringResource(R.string.shift_create_scan), style = type.body, color = colors.fg2)
                    }
                    item {
                        CreateField(stringResource(R.string.shift_create_product_search), query, { query = it }, enabled = canEdit)
                    }
                    val input = query.trim()
                    val found = options.products.filter { it.name.contains(input, ignoreCase = true) || it.gtin14.contains(input) }
                    if (found.isEmpty() && options.products.isNotEmpty()) {
                        item { Text(stringResource(R.string.shift_create_no_match), style = type.body, color = colors.fg2) }
                    }
                    items(found, key = { it.id }) { row ->
                        ChoiceField(row.name, row.gtin14, enabled = canEdit) {
                            cb.onSelect(row)
                            focus.clearFocus()
                            pageOverride = null
                        }
                    }
                }
                product != null && page == CreatePage.MODE -> item {
                    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        Text(product.name, style = type.title, color = colors.fg1)
                        Text(options.lineName, style = type.caption, color = colors.fg2)
                        CreateShiftMode.entries.forEach { mode ->
                            val enabled = canEdit && (mode != CreateShiftMode.PALLETS || options.palletsAllowed)
                            ChoiceField(
                                stringResource(mode.title()),
                                stringResource(if (enabled || mode != CreateShiftMode.PALLETS) mode.description() else R.string.shift_create_pallet_disabled),
                                selected = selectedMode == mode,
                                enabled = enabled,
                            ) { selectedMode = mode }
                        }
                    }
                }
                page == CreatePage.PLAN -> item {
                    val planLabel = if (product?.setItems.isNullOrEmpty()) R.string.shift_create_plan else R.string.set_plan
                    CreateField(stringResource(planLabel), planInput, { planInput = it }, numeric = true,
                        enabled = canEdit, error = planInput.isNotBlank() && count(planInput, MAX_SHIFT_PLAN) == null)
                    Text(stringResource(R.string.shift_create_plan_hint), style = type.caption, color = colors.fg2, modifier = Modifier.padding(vertical = 8.dp))
                    SecondaryButton(stringResource(R.string.shift_create_no_plan), {
                        cb.onEdit { it.copy(plan = "") }
                        focus.clearFocus()
                        pageOverride = null
                    }, enabled = canEdit)
                }
                page in setOf(CreatePage.BOX, CreatePage.PALLET, CreatePage.SHEET) -> {
                    val purpose = when (page) {
                        CreatePage.BOX -> "box"
                        CreatePage.PALLET -> "pallet"
                        else -> "sheet"
                    }
                    val selected = draft.template(options, purpose)?.id
                    if (purpose == "sheet") item {
                        ChoiceField(stringResource(R.string.shift_create_sheet_default), selected = selected == null, enabled = canEdit) {
                            cb.onEdit { it.copy(sheetId = null) }
                            pageOverride = null
                        }
                    }
                    val templates = draft.templates(options, purpose)
                    if (templates.isEmpty() && purpose != "sheet") item {
                        Text(stringResource(R.string.shift_create_no_template), style = type.body, color = colors.warnFg)
                    }
                    items(templates, key = { it.id }) { template ->
                        ChoiceField(template.name, selected = selected == template.id, enabled = canEdit) {
                            cb.onEdit {
                                when (page) {
                                    CreatePage.BOX -> it.copy(boxTemplateId = template.id)
                                    CreatePage.PALLET -> it.copy(palletTemplateId = template.id)
                                    else -> it.copy(sheetId = template.id)
                                }
                            }
                            pageOverride = null
                        }
                    }
                }
                product != null -> {
                    item {
                        ChoiceField(product.name, options.lineName, enabled = canEdit) {
                            query = ""
                            pageOverride = CreatePage.PRODUCT
                        }
                    }
                    if (product.setItems.isEmpty()) item {
                        ChoiceField(stringResource(R.string.shift_create_mode), stringResource(draft.mode.title()), enabled = canEdit) {
                            selectedMode = draft.mode
                            pageOverride = CreatePage.MODE
                        }
                    }
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                            DateField(R.string.shift_create_date, draft.plannedDate, Modifier.weight(1f), canEdit) { date ->
                                cb.onEdit { it.copy(plannedDate = date) }
                            }
                            DateField(R.string.shift_create_production_date, draft.productionDate, Modifier.weight(1f), canEdit) { date ->
                                cb.onEdit { it.copy(productionDate = date) }
                            }
                        }
                    }
                    if (options.useLotNumbers && product.setItems.isEmpty()) item {
                        val invalid = !draft.isLotNumberValid()
                        CreateField(
                            stringResource(R.string.shift_create_lot_number), draft.lotNumber,
                            { value -> cb.onEdit { it.copy(lotNumber = value) } },
                            enabled = canEdit, error = invalid,
                            supportingText = if (invalid) stringResource(R.string.shift_create_lot_number_invalid) else null,
                        )
                    }
                    item {
                        val planLabel = if (product.setItems.isEmpty()) R.string.shift_create_plan else R.string.set_plan
                        ChoiceField(stringResource(planLabel), draft.plan.ifBlank { stringResource(R.string.shift_create_no_plan) }, enabled = canEdit) {
                            planInput = draft.plan
                            pageOverride = CreatePage.PLAN
                        }
                    }
                    if (product.setItems.isNotEmpty()) {
                        item {
                            Text(stringResource(R.string.set_title), style = type.title, color = colors.fg1)
                            Text(stringResource(R.string.set_contents), style = type.caption, color = colors.fg2, modifier = Modifier.padding(top = 8.dp))
                        }
                        items(product.setItems, key = { it.gtin14 }) { component ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                                Text(component.productName, Modifier.weight(1f), style = type.body, color = colors.fg1)
                                Text(stringResource(R.string.set_quantity, component.quantity), style = type.body, color = colors.fg2)
                            }
                        }
                    } else if (draft.mode == CreateShiftMode.VALIDATION) {
                        item { Text(stringResource(R.string.shift_create_validation_hint), style = type.body, color = colors.fg2) }
                        if (draft.template(options, "box") == null) item {
                            Text(stringResource(R.string.shift_create_no_template), style = type.caption, color = colors.warnFg)
                        }
                    } else {
                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                                CreateField(stringResource(R.string.shift_create_box_qty), draft.boxCapacity,
                                    { v -> cb.onEdit { it.copy(boxCapacity = v) } }, Modifier.weight(1f),
                                    true, canEdit, count(draft.boxCapacity, MAX_SHIFT_BOX_CAPACITY) == null)
                                if (draft.mode == CreateShiftMode.PALLETS) {
                                    CreateField(stringResource(R.string.shift_create_pallet_qty), draft.palletCapacity,
                                        { v -> cb.onEdit { it.copy(palletCapacity = v) } }, Modifier.weight(1f),
                                        true, canEdit, count(draft.palletCapacity, MAX_SHIFT_PALLET_CAPACITY) == null)
                                }
                            }
                        }
                        item {
                            ChoiceField(stringResource(R.string.shift_create_box_template),
                                draft.template(options, "box")?.name ?: stringResource(R.string.shift_create_no_template),
                                enabled = canEdit) { pageOverride = CreatePage.BOX }
                        }
                        if (draft.mode == CreateShiftMode.PALLETS) {
                            item {
                                ChoiceField(stringResource(R.string.shift_create_pallet_template),
                                    draft.template(options, "pallet")?.name ?: stringResource(R.string.shift_create_no_template),
                                    enabled = canEdit) { pageOverride = CreatePage.PALLET }
                            }
                            item {
                                ChoiceField(stringResource(R.string.shift_create_sheet),
                                    draft.template(options, "sheet")?.name ?: stringResource(R.string.shift_create_sheet_default),
                                    enabled = canEdit) { pageOverride = CreatePage.SHEET }
                            }
                        }
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2)) {
            when {
                state.created != null -> PrimaryButton(stringResource(R.string.shift_create_open), cb.onSubmit, !state.busy)
                state.pending -> PrimaryButton(stringResource(R.string.shift_create_retry), cb.onSubmit, !state.busy)
                options == null -> PrimaryButton(stringResource(R.string.shift_create_retry), cb.onReload, !state.busy)
                page == CreatePage.MODE -> PrimaryButton(stringResource(R.string.shift_create_mode_choose), {
                    cb.onEdit { it.copy(mode = selectedMode) }
                    pageOverride = null
                }, canEdit && (selectedMode != CreateShiftMode.PALLETS || options.palletsAllowed))
                page == CreatePage.PLAN -> PrimaryButton(stringResource(R.string.shift_create_plan_save), {
                    cb.onEdit { it.copy(plan = planInput) }
                    focus.clearFocus()
                    pageOverride = null
                }, canEdit && (planInput.isBlank() || count(planInput, MAX_SHIFT_PLAN) != null))
                page == CreatePage.FORM && product != null -> {
                    if (state.issue in setOf(CreateShiftIssue.CATALOG, CreateShiftIssue.LICENSE, CreateShiftIssue.OFFLINE)) {
                        SecondaryButton(stringResource(R.string.common_refresh), cb.onReload, !state.busy)
                    }
                    PrimaryButton(stringResource(R.string.shift_create_submit), {
                        focus.clearFocus()
                        cb.onSubmit()
                    }, canEdit && draft.request(options, "") != null)
                }
                page == CreatePage.PRODUCT && state.issue in setOf(CreateShiftIssue.NO_PRODUCTS, CreateShiftIssue.LICENSE, CreateShiftIssue.OFFLINE) ->
                    SecondaryButton(stringResource(R.string.common_refresh), cb.onReload, !state.busy)
            }
        }
    }
}

@Composable
private fun ChoiceField(
    title: String,
    value: String? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    selected: Boolean? = null,
    onClick: () -> Unit,
) {
    val c = MarkiroTheme.colors
    val type = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radiusCard)
    val action = if (selected == null) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
    else Modifier.selectable(selected, enabled, role = Role.RadioButton, onClick = onClick)
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(shape)
            .background(c.surfaceCard).border(1.dp, if (selected == true) c.accent else c.line, shape)
            .then(action).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = if (value == null || selected != null) type.body else type.caption, color = c.fg1)
            if (value != null) Text(value, style = type.body, color = c.fg2)
        }
        if (selected != null) RadioButton(selected, onClick = null, enabled = enabled)
        else Text("›", style = type.body, color = c.fg2)
    }
}

@Composable
private fun CreateField(
    label: String, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier,
    numeric: Boolean = false, enabled: Boolean = true, error: Boolean = false,
    supportingText: String? = null,
) {
    OutlinedTextField(value, onChange, modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true,
        colors = markiroFieldColors(), enabled = enabled, isError = error,
        supportingText = supportingText?.let { message -> { Text(message) } },
        keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Number else KeyboardType.Text))
}

@Composable
private fun DateField(@StringRes label: Int, value: String, modifier: Modifier, enabled: Boolean, onSelect: (String) -> Unit) {
    val context = LocalContext.current
    val date = LocalDate.parse(value)
    val text = date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(Locale.getDefault()))
    ChoiceField(stringResource(label), text, modifier.heightIn(min = 70.dp), enabled = enabled) {
        DatePickerDialog(context, { _, year, month, day ->
            onSelect(LocalDate.of(year, month + 1, day).toString())
        }, date.year, date.monthValue - 1, date.dayOfMonth).show()
    }
}

@StringRes
private fun CreateShiftMode.title(): Int = when (this) {
    CreateShiftMode.VALIDATION -> R.string.shifts_mode_validation
    CreateShiftMode.BOXES -> R.string.shift_create_boxes
    CreateShiftMode.PALLETS -> R.string.shift_create_pallets
}

@StringRes
private fun CreateShiftMode.description(): Int = when (this) {
    CreateShiftMode.VALIDATION -> R.string.shift_create_validation_hint
    CreateShiftMode.BOXES -> R.string.shift_create_boxes_hint
    CreateShiftMode.PALLETS -> R.string.shift_create_pallets_hint
}

@StringRes
private fun CreateShiftIssue.message(): Int = when (this) {
    CreateShiftIssue.OFFLINE -> R.string.shift_create_offline
    CreateShiftIssue.LINE -> R.string.shift_create_line
    CreateShiftIssue.LICENSE -> R.string.shift_create_license
    CreateShiftIssue.CATALOG -> R.string.shift_create_catalog
    CreateShiftIssue.REFUSED -> R.string.shift_create_refused
    CreateShiftIssue.ENTER -> R.string.shift_create_enter_failed
    CreateShiftIssue.NO_MATCH -> R.string.shift_create_scan_no_match
    CreateShiftIssue.NO_PRODUCTS -> R.string.shift_create_no_products
}
