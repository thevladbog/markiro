package app.markiro.handheld

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * Installs a [TestDispatcher] as `Dispatchers.Main` and tears down the models that ran on it.
 *
 * Nothing calls `onCleared` in a unit test, so a `viewModelScope` built here stays active after its
 * test ends and keeps collecting on `Dispatchers.Main`. The class that runs next replaces Main while
 * that leaked collector is still dispatching, and `TestMainDispatcher` fails whichever test happens
 * to hold the dispatcher at that moment — never the one that leaked. Pass every model through
 * [track] so its scope dies with the test that made it.
 *
 * Cancelling happens before `resetMain`, which is why tracking lives in this rule rather than a
 * second `@Rule`: JUnit does not order independent rules.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(val dispatcher: TestDispatcher = StandardTestDispatcher()) : TestWatcher() {
    private val models = mutableListOf<ViewModel>()

    /** Registers [model] for cancellation and returns it, so it can wrap a constructor call. */
    fun <T : ViewModel> track(model: T): T = model.also { models += it }

    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)

    override fun finished(description: Description) {
        models.forEach { it.viewModelScope.cancel() }
        models.clear()
        Dispatchers.resetMain()
    }
}
