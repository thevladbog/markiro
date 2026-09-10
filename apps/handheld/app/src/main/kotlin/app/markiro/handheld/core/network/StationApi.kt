package app.markiro.handheld.core.network

import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/** Station-only endpoints; the handheld authenticates exactly like a station (`x-api-key`). */
interface StationApi {
    @GET("station/identity")
    suspend fun identity(): IdentityResponse

    @GET("station/operators")
    suspend fun operators(): RosterResponse

    /** Without `lineId` the server scopes a device to its own line plus unassigned shifts. */
    @GET("shifts")
    suspend fun shifts(@Query("status") status: String? = null, @Query("lineId") lineId: String? = null): ShiftListResponse

    @GET("station/inventory-tasks")
    suspend fun inventoryTasks(): InventoryTaskListResponse

    @POST("shifts/{id}/enter")
    suspend fun enter(@Path("id") id: String): ShiftDto

    @GET("shifts/{id}/bundle")
    suspend fun bundle(@Path("id") id: String): ShiftBundleDto

    @GET("shifts/{id}/summary")
    suspend fun summary(@Path("id") id: String): ShiftSummaryDto

    @GET("lines")
    suspend fun lines(): LineListResponse
}
