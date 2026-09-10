package app.markiro.handheld.feature.hub

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.IdentityResponse
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.InventoryTaskListResponse
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import java.io.IOException

class HubViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val configFlow = MutableStateFlow<DeviceConfigEntity?>(
        DeviceConfigEntity(
            deviceId = "dev-1",
            deviceName = "ТСД 1",
            tenantId = "t-1",
            organizationName = "ООО «Родник»",
            lineId = "line-2",
            lineName = "Линия 2",
            kind = "handheld",
            serverUrl = "https://x",
            pairedAt = 1L,
        ),
    )
    private val config = object : DeviceConfigDao {
        override fun observe(): Flow<DeviceConfigEntity?> = configFlow
        override suspend fun get() = configFlow.value
        override suspend fun count() = if (configFlow.value == null) 0 else 1
        override suspend fun upsert(config: DeviceConfigEntity) {
            configFlow.value = config
        }
        override suspend fun clear() {
            configFlow.value = null
        }
    }
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private var clock = 1_000_000L
    private val reachability = ReachabilityTracker { clock }

    private fun api(fail: Boolean = false) = object : StationApi {
        override suspend fun identity(): IdentityResponse = throw UnsupportedOperationException()
        override suspend fun operators() = RosterResponse(emptyList())
        override suspend fun shifts(status: String?): ShiftListResponse {
            if (fail) throw IOException("offline")
            return ShiftListResponse(
                listOf(ShiftDto("s1", "SEP26-001", "active"), ShiftDto("s2", "SEP26-002", "planned"), ShiftDto("s3", "SEP26-003", "closed")),
            )
        }
        override suspend fun inventoryTasks(): InventoryTaskListResponse {
            if (fail) throw IOException("offline")
            return InventoryTaskListResponse(listOf(InventoryTaskDto("i1", "7", "Вода 0,5 л")))
        }
    }

    @Test
    fun refreshCountsOpenShiftsAndTasksAndStoresThem() = runTest {
        val vm = HubViewModel(api(), config, session, reachability, scannerLabel = { "встроенный" }, now = { clock }, tick = flowOf(Unit))
        vm.refresh()
        advanceUntilIdle()
        val ui = vm.state.value
        assertEquals(2, ui.shifts)
        assertEquals(1, ui.inventories)
        assertEquals("Иванова Анна", ui.operatorName)
        assertEquals("Линия 2", ui.lineName)
        assertEquals(2, configFlow.value?.shiftsCount)
    }

    @Test
    fun offlineKeepsCachedCountsAndReportsUnreachable() = runTest {
        configFlow.value = configFlow.value!!.copy(shiftsCount = 3, inventoryCount = 0, countsAt = 900_000L)
        val vm = HubViewModel(api(fail = true), config, session, reachability, scannerLabel = { "встроенный" }, now = { clock }, tick = flowOf(Unit))
        vm.refresh()
        advanceUntilIdle()
        val ui = vm.state.value
        assertEquals(3, ui.shifts)
        assertEquals(900_000L, ui.countsAt)
        assertEquals(false, ui.reachable)
    }

    @Test
    fun signOutClearsTheSession() = runTest {
        val vm = HubViewModel(api(), config, session, reachability, scannerLabel = { "встроенный" }, now = { clock }, tick = flowOf(Unit))
        vm.signOut()
        assertNull(session.state.value.operator)
    }
}
