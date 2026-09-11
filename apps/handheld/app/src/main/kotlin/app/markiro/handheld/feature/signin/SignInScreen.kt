package app.markiro.handheld.feature.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PinDots
import app.markiro.handheld.core.design.ScreenColumn

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
    ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(
            Modifier.fillMaxWidth().weight(1f).heightIn(min = 96.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.lineStrong, RoundedCornerShape(MarkiroSizes.radius)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg1, modifier = Modifier.size(36.dp))
            Text(stringResource(R.string.signin_scan_badge), style = t.strong, color = c.fg1)
            Text(
                stringResource(R.string.signin_scan_hint),
                style = t.caption,
                color = c.fg3,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
            if (state.error == SignInError.BADGE_UNKNOWN) Text(stringResource(R.string.signin_badge_unknown), style = t.caption, color = c.errFg)
            if (state.error == SignInError.ROSTER_EMPTY) Text(stringResource(R.string.signin_roster_empty), style = t.caption, color = c.warnFg)
        }
        Field(label = stringResource(R.string.signin_login_field), value = state.login)
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.login.isNotEmpty())
        MarkiroTextButton(stringResource(R.string.signin_find_by_name), cb.onOpenSearch)
    }
}

@Composable
private fun PinStep(state: SignInUi.Pin, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(
            Modifier.fillMaxWidth().weight(1f).heightIn(min = 96.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            val initials = (state.operatorName ?: "?").split(' ').take(2).mapNotNull { it.firstOrNull() }.joinToString("")
            Box(Modifier.size(44.dp).clip(CircleShape).background(c.surfacePanel), contentAlignment = Alignment.Center) {
                Text(initials, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
            }
            Text(state.operatorName ?: stringResource(R.string.signin_login_title, state.login), style = t.strong, color = c.fg1)
            Text(
                if (state.lockMode) stringResource(R.string.signin_lock_hint) else stringResource(R.string.signin_login_caption, state.login),
                style = t.caption,
                color = c.fg3,
            )
            if (state.error == SignInError.WRONG_PIN) Text(stringResource(R.string.signin_wrong_pin), style = t.caption, color = c.errFg)
            if (state.error == SignInError.BADGE_UNKNOWN) Text(stringResource(R.string.signin_badge_unknown), style = t.caption, color = c.errFg)
        }
        Row(
            Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.signin_pin), style = t.body.copy(fontSize = 15.sp), color = c.fg3)
            PinDots(total = maxOf(4, state.pin.length), filled = state.pin.length)
        }
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.pin.length >= 4)
        MarkiroTextButton(
            if (state.lockMode) stringResource(R.string.signin_switch_operator) else stringResource(R.string.signin_not_me),
            if (state.lockMode) cb.onSwitchOperator else cb.onBack,
        )
    }
}

@Composable
private fun SearchStep(state: SignInUi.Search, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize()) {
        AppBar(stringResource(R.string.signin_find_by_name), onBack = cb.onBack)
        // The roster of a real line runs to dozens of names; the bar stays put and the matches scroll.
        ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            OutlinedTextField(
                value = state.query,
                onValueChange = cb.onSearchQuery,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.signin_search_field)) },
            )
            Text(stringResource(R.string.signin_search_hint), style = t.caption, color = c.fg3)
            state.results.forEach { operator ->
                Row(
                    Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable { cb.onPickOperator(operator) },
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(operator.name, style = t.body.copy(fontWeight = FontWeight.SemiBold), color = c.fg1)
                    Text(stringResource(R.string.signin_number_short, operator.login), style = t.caption, color = c.fg3)
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
