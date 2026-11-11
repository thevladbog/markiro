use axum::{extract::State, Json};
use markiro_proto::{
    WarehousePalletCloseIssue, WarehousePalletCloseIssues, WarehousePalletCloseResolution,
};

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AskingDevice, OfficeContext};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::pallet_close_issues;
use crate::server::AppState;
use crate::validate;

pub async fn device_get(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<WarehousePalletCloseIssue>, ApiError> {
    validate::client_uuid("id", &id)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let issue = pallet_close_issues::get(&mut tx, &id)
        .await?
        .filter(|issue| issue.device_id == device.id)
        .ok_or_else(|| ApiError::not_found("no such pallet close issue"))?;
    let response = issue.wire(&mut tx).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(response))
}

pub async fn office_list(
    State(state): State<AppState>,
    _office: OfficeContext,
) -> Result<Json<WarehousePalletCloseIssues>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let mut issues = Vec::new();
    for issue in pallet_close_issues::list(&mut tx).await? {
        issues.push(issue.wire(&mut tx).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(WarehousePalletCloseIssues { issues }))
}

pub async fn office_resolve(
    State(state): State<AppState>,
    office: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(resolution): ApiJson<WarehousePalletCloseResolution>,
) -> Result<Json<WarehousePalletCloseIssue>, ApiError> {
    validate::client_uuid("id", &id)?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    match resolution {
        WarehousePalletCloseResolution::ApproveReclose { .. } => {
            office.require_conflict_review_in(&mut tx).await?
        }
        WarehousePalletCloseResolution::Cancel { .. } => office.require_admin_in(&mut tx).await?,
    }
    crate::cloud_history::require_ready(&mut tx).await?;
    let held: bool =
        sqlx::query_scalar("SELECT facts_held_since IS NOT NULL FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if held {
        return Err(ApiError::conflict(
            "restore_hold",
            "resume device facts before pallet reconciliation",
        ));
    }
    let issue = pallet_close_issues::get(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such pallet close issue"))?;
    let at = state.timestamp();
    let (changed, action) = match resolution {
        WarehousePalletCloseResolution::ApproveReclose { expected_box_ssccs } => (
            issue.approve(&mut tx, expected_box_ssccs).await?,
            "approve_reclose",
        ),
        WarehousePalletCloseResolution::Cancel {
            label_removed: true,
        } => (issue.cancel(&mut tx, &at).await?, "cancel"),
        WarehousePalletCloseResolution::Cancel {
            label_removed: false,
        } => {
            return Err(ApiError::validation(
                "labelRemoved",
                "confirm withdrawal of the printed label",
            ));
        }
    };
    let response = pallet_close_issues::get(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("the resolved pallet issue is missing"))?
        .wire(&mut tx)
        .await?;
    if changed {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: Actor::OfficeUser(&office.user.id),
                action: actions::WAREHOUSE_PALLET_CLOSE_ISSUE_RESOLVE,
                target_type: Some("warehouse_pallet_close_issue"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details: pallet_close_issues::audit_details(&response, action, &issue.device_id),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
        commit_with_revision(tx, &state.revisions, rev)
            .await
            .map_err(ApiError::internal)?;
    } else {
        tx.rollback().await.map_err(ApiError::internal)?;
    }
    Ok(Json(response))
}
