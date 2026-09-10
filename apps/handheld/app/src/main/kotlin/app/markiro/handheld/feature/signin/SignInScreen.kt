package app.markiro.handheld.feature.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PinDots

data class SignInCallbacks(
    val onDigit: (Char) -> Unit = {},
    val onBackspace: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onOpenSearch: () -> Unit = {},
    val onSearchQuery: (String) -> Unit = {},
    val onPickOperator: (OperatorRecord) -> Unit = {},
    val onBack: () -> Unit = {},
    val onSwitchOperator: () -> Unit = {},
)

@Composable
fun SignInScreen(state: SignInUi, callbacks: SignInCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is SignInUi.Login -> LoginStep(state, callbacks)
            is SignInUi.Pin -> PinStep(state, callbacks)
            is SignInUi.Search -> SearchStep(state, callbacks)
        }
    }
}

@Composable
private fun LoginStep(state: SignInUi.Login, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(
            Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.lineStrong, RoundedCornerShape(MarkiroSizes.radius)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg1, modifier = Modifier.size(36.dp))
            Text("Сканируйте бейдж", style = t.strong, color = c.fg1)
            Text(
                "нажмите триггер · или введите табельный номер ниже",
                style = t.caption,
                color = c.fg3,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
            if (state.error == SignInError.BADGE_UNKNOWN) Text("Бейдж не найден", style = t.caption, color = c.errFg)
            if (state.error == SignInError.ROSTER_EMPTY) Text("Список операторов ещё не загружен", style = t.caption, color = c.warnFg)
        }
        Field(label = "Табельный №", value = state.login)
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.login.isNotEmpty())
        MarkiroTextButton("Найти по имени", cb.onOpenSearch)
    }
}

@Composable
private fun PinStep(state: SignInUi.Pin, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(Modifier.fillMaxWidth().weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            val initials = (state.operatorName ?: "?").split(' ').take(2).mapNotNull { it.firstOrNull() }.joinToString("")
            Box(Modifier.size(44.dp).clip(CircleShape).background(c.surfacePanel), contentAlignment = Alignment.Center) {
                Text(initials, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
            }
            Text(state.operatorName ?: "Табельный ${state.login}", style = t.strong, color = c.fg1)
            Text(if (state.lockMode) "Введите PIN или сканируйте бейдж" else "табельный ${state.login}", style = t.caption, color = c.fg3)
            if (state.error == SignInError.WRONG_PIN) Text("Неверный PIN", style = t.caption, color = c.errFg)
            if (state.error == SignInError.BADGE_UNKNOWN) Text("Бейдж не найден", style = t.caption, color = c.errFg)
        }
        Row(
            Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("PIN", style = t.body.copy(fontSize = 15.sp), color = c.fg3)
            PinDots(total = maxOf(4, state.pin.length), filled = state.pin.length)
        }
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.pin.length >= 4)
        MarkiroTextButton(
            if (state.lockMode) "Сменить оператора" else "Не тот сотрудник",
            if (state.lockMode) cb.onSwitchOperator else cb.onBack,
        )
    }
}

@Composable
private fun SearchStep(state: SignInUi.Search, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize()) {
        AppBar("Найти по имени", onBack = cb.onBack)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            OutlinedTextField(
                value = state.query,
                onValueChange = cb.onSearchQuery,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Фамилия или имя") },
            )
            Text("Показаны первые 5 совпадений. Уточните запрос, если нужного нет.", style = t.caption, color = c.fg3)
            state.results.forEach { operator ->
                Row(
                    Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable { cb.onPickOperator(operator) },
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(operator.name, style = t.body.copy(fontWeight = FontWeight.SemiBold), color = c.fg1)
                    Text("№ ${operator.login}", style = t.caption, color = c.fg3)
                }
            }
        }
    }
}

@Composable
private fun Field(label: String, value: String) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Row(
        Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
            .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.body.copy(fontSize = 15.sp), color = c.fg3)
        Text(value, style = t.code.copy(fontSize = 22.sp), color = c.fg1)
    }
}
