package app.markiro.handheld

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.isActive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.Description
import org.junit.runners.model.Statement

class MainDispatcherRuleTest {
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
