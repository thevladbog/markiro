package app.markiro.handheld

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.Description
import org.junit.runners.model.Statement

class MainDispatcherRuleTest {
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun mainRemainsInstalledUntilTrackedCollectorsFinishCancellation() {
        val rule = MainDispatcherRule()
        lateinit var collector: Job
        var cleanedUp = false
        val body = object : Statement() {
            override fun evaluate() {
                val model = rule.track(object : ViewModel() {})
                collector = model.viewModelScope.launch {
                    try {
                        awaitCancellation()
                    } finally {
                        // Room collectors may return from a worker during cancellation and still
                        // need Main to finish. Cancelling alone only queues that continuation.
                        withContext(NonCancellable) {
                            withContext(Dispatchers.Default) { Unit }
                            withContext(Dispatchers.Main) { cleanedUp = true }
                        }
                    }
                }
                rule.dispatcher.scheduler.runCurrent()
                assertTrue(collector.isActive)
            }
        }

        try {
            rule.apply(body, Description.createTestDescription(javaClass, "cancellation")).evaluate()
            assertTrue("cancellation must finish before Main is reset", collector.isCompleted)
            assertTrue("the collector must finish its Main-bound cleanup", cleanedUp)
        } finally {
            // Keep the failing regression probe isolated as well as the passing version.
            Dispatchers.setMain(rule.dispatcher)
            try {
                runTest(rule.dispatcher) { collector.cancelAndJoin() }
            } finally {
                Dispatchers.resetMain()
            }
        }
    }

    @Test
    fun aTrackedModelsScopeDiesWithTheTestThatBuiltIt() {
        val rule = MainDispatcherRule()
        var model: ViewModel? = null
        val body = object : Statement() {
            override fun evaluate() {
                model = rule.track(object : ViewModel() {})
                assertTrue("the scope is the test's to use", model!!.viewModelScope.isActive)
            }
        }

        rule.apply(body, Description.createTestDescription(javaClass, "probe")).evaluate()

        // Untracked, this scope would still be collecting on a Dispatchers.Main that the next test
        // class is about to replace — which is the whole shape of the flake this rule closes.
        assertFalse("the scope outlived its test", model!!.viewModelScope.isActive)
    }
}
