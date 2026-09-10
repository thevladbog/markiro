package app.markiro.handheld.feature.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.PairingError

data class PairingCallbacks(
    val onDigit: (Char) -> Unit = {},
    val onBackspace: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onServerUrl: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onDone: () -> Unit = {},
)

@Composable
fun PairingScreen(state: PairingUi, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is PairingUi.Enter -> EnterCode(state, callbacks)
            PairingUi.Binding -> FullScreenState(
                Icons.Outlined.Sync,
                "Привязываем устройство…",
                "Загружаем настройки, операторов и товары. Обычно это занимает меньше минуты.",
                tone = Tone.Info,
            )
            is PairingUi.Failed -> Failed(state.error, callbacks.onRetry)
            is PairingUi.Success -> FullScreenState(
                Icons.Outlined.CheckCircle,
                "ТСД привязан",
                listOfNotNull(state.organizationName, state.lineName).joinToString(" · "),
                primary = StateAction("Перейти ко входу", callbacks.onDone),
                tone = Tone.Ok,
            )
        }
    }
}

@Composable
private fun EnterCode(state: PairingUi.Enter, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
        Text("МАРКИРО", style = t.label, color = c.fg3)
        Text("Привязать устройство", style = t.title, color = c.fg1)
        Text(
            "Введите код из кабинета или нажмите триггер и наведите на штрих-код рядом с кодом.",
            style = t.body.copy(fontSize = 15.sp),
            color = c.fg2,
        )
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            val typed = state.code.toList().joinToString(" ")
            val rest = List(8 - state.code.length) { "_" }.joinToString(" ")
            Text(typed, style = t.key, color = c.fg1)
            if (rest.isNotEmpty()) Text((if (typed.isEmpty()) "" else " ") + rest, style = t.key, color = c.fgDisabled)
        }
        Keypad(callbacks.onDigit, callbacks.onBackspace, callbacks.onConfirm, confirmEnabled = state.code.length == 8)
        if (state.serverEditable) {
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = callbacks.onServerUrl,
                label = { Text("Адрес сервера") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun Failed(error: PairingError, onRetry: () -> Unit) {
    when (error) {
        PairingError.INVALID, PairingError.EXPIRED, PairingError.INVALID_RESPONSE -> FullScreenState(
            Icons.Outlined.Key,
            "Код не подошёл",
            "Код недействителен или истёк. Обновите код в кабинете и введите новый.",
            primary = StateAction("Ввести новый код", onRetry),
            tone = Tone.Err,
        )
        PairingError.LOCKED, PairingError.RATE_LIMITED -> FullScreenState(
            Icons.Outlined.Lock,
            "Слишком много попыток",
            "Устройство заблокировано на 15 минут. Подождите или сгенерируйте новый код в кабинете.",
            primary = StateAction("Понятно", onRetry),
            tone = Tone.Warn,
            primaryIsAccent = false,
        )
        PairingError.UNAVAILABLE -> FullScreenState(
            Icons.Outlined.WifiOff,
            "Сервер недоступен",
            "Проверьте Wi-Fi и адрес сервера. Код пока не использован.",
            primary = StateAction("Повторить", onRetry),
            tone = Tone.Err,
        )
        PairingError.KIND_MISMATCH -> FullScreenState(
            Icons.Outlined.Key,
            "Этот код выпущен для станции",
            "Добавьте в кабинете устройство типа «ТСД» и выпустите код для него. Этот код остаётся действующим для станции.",
            primary = StateAction("Ввести другой код", onRetry),
            tone = Tone.Warn,
        )
    }
}
