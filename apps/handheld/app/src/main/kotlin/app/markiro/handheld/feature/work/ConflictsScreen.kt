package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.ConflictDao
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class ConflictsViewModel @Inject constructor(dao: ConflictDao) : ViewModel() {
    val rows: StateFlow<List<ConflictEntity>> = dao.observeAll().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
}

/** Informational: the code was counted elsewhere first; the cabinet resolves it. */
@Composable
fun ConflictsScreen(rows: List<ConflictEntity>, onBack: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.conflicts_title), onBack)
        if (rows.isEmpty()) {
            FullScreenState(Icons.Outlined.CheckCircle, stringResource(R.string.conflicts_empty), stringResource(R.string.conflicts_note))
            return
        }
        Text(stringResource(R.string.conflicts_note), style = t.caption, color = c.fg3, modifier = Modifier.padding(horizontal = MarkiroSizes.sp4))
        LazyColumn(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            items(rows, key = { it.codeHash }) { row ->
                Text(
                    stringResource(
                        R.string.conflicts_row,
                        row.codeHash.takeLast(8),
                        row.winningTerminalId?.takeLast(6) ?: stringResource(R.string.conflicts_unknown_terminal),
                        Iso.parse(row.winningScannedAt)?.let { TimeText.hhmm(it) } ?: row.winningScannedAt,
                    ),
                    style = t.code.copy(fontSize = 14.sp),
                    color = c.fg1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
