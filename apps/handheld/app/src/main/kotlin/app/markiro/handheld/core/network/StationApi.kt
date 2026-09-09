package app.markiro.handheld.core.network

import retrofit2.http.GET
import retrofit2.http.Query

/** Station-only endpoints; the handheld authenticates exactly like a station (`x-api-key`). */
interface StationApi {
    @GET("station/identity")
    suspend fun identity(): IdentityResponse

    @GET("station/operators")
    suspend fun operators(): RosterResponse

    @GET("shifts")
    suspend fun shifts(@Query("status") status: String? = null): ShiftListResponse

    @GET("station/inventory-tasks")
    suspend fun inventoryTasks(): InventoryTaskListResponse
}
