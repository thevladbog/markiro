//! Office auth runs before bounded native request bodies are parsed. Secrets
//! never appear in response/error/audit DTOs; every durable change rechecks role.
use crate::{
    auth::OfficeContext,
    db::begin_write,
    error::{ApiError, ApiPath},
    server::AppState,
    yandex::{
        audit_outbox::write_events_in,
        connection::{error_code, AttemptOwner, YandexService},
        state::SourceContext,
    },
};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header::CONTENT_TYPE, StatusCode},
    Json,
};
use markiro_backup_cloud::{model::Secret, Error};
use markiro_proto::yandex_backups::{
    AuthBeginReply, ConnectionState, ErrorCode, YandexBackupStatus,
};
use serde::{de::DeserializeOwned, Deserialize};
use std::sync::Arc;
use uuid::Uuid;

fn service(state: &AppState) -> Result<Arc<YandexService>, ApiError> {
    state
        .yandex
        .clone()
        .ok_or_else(|| ApiError::not_found("Yandex backups are unavailable"))
}
fn owner(context: &OfficeContext) -> AttemptOwner {
    AttemptOwner {
        user_id: context.user.id.clone(),
        device_id: context.device_id.clone(),
        session_id: context.session_id.clone(),
        source: Default::default(),
    }
}
fn cloud_error(error: Error) -> ApiError {
    let reason = match error {
        Error::InvalidAttempt => serde_json::json!("connection_changed"),
        error => serde_json::json!(error_code(&error)),
    };
    ApiError::conflict("yandex_backup", "Yandex backup operation failed")
        .with_details(serde_json::json!({"constraint":"yandex_backup","reason":reason}))
}
fn internal_error() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "Yandex backup operation failed",
    )
}
async fn body<T: DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    if request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        != Some("application/json")
    {
        return Err(ApiError::validation(
            "request",
            "a JSON request is required",
        ));
    }
    let bytes = to_bytes(request.into_body(), 8192)
        .await
        .map_err(|_| ApiError::validation("request", "request is too large"))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::validation("request", "invalid request"))
}
struct NativeSecret(Secret);
impl<'de> Deserialize<'de> for NativeSecret {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Secret::client_secret(String::deserialize(d)?)
            .map(Self)
            .map_err(|_| serde::de::Error::custom("invalid secret"))
    }
}
struct NativeOpaque(Secret);
impl<'de> Deserialize<'de> for NativeOpaque {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Secret::new(String::deserialize(d)?)
            .map(Self)
            .map_err(|_| serde::de::Error::custom("invalid authorization value"))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginBody {
    client_id: String,
    client_secret: NativeSecret,
    expected_generation: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteBody {
    attempt_id: Uuid,
    state: NativeOpaque,
    code: NativeOpaque,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationBody {
    expected_generation: Uuid,
}

pub async fn get(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<YandexBackupStatus>, ApiError> {
    let status = match &state.yandex {
        Some(service) => service
            .status(state.now().unix_timestamp())
            .await
            .map_err(cloud_error)?,
        None => YandexBackupStatus {
            state: if state.yandex_init_failed {
                ConnectionState::ReauthRequired
            } else {
                ConnectionState::Disconnected
            },
            error_code: state
                .yandex_init_failed
                .then_some(ErrorCode::SecretUnavailable),
            ..Default::default()
        },
    };
    Ok(Json(status))
}
pub async fn begin(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Request,
) -> Result<Json<AuthBeginReply>, ApiError> {
    context.require_admin()?;
    let input: BeginBody = body(request).await?;
    let service = service(&state)?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let mut owner = owner(&context);
    owner.source = SourceContext::read(&mut tx).await?;
    markiro_backup_cloud::model::ClientProfile::new(&input.client_id)
        .map_err(|_| ApiError::validation("clientId", "invalid client id"))?;
    let reply = service
        .begin(
            &owner,
            &input.client_id,
            input.client_secret.0,
            input.expected_generation,
            state.now().unix_timestamp(),
        )
        .await
        .map_err(cloud_error)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(reply))
}
pub async fn complete(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Request,
) -> Result<Json<YandexBackupStatus>, ApiError> {
    context.require_admin()?;
    let input: CompleteBody = body(request).await?;
    let service = service(&state)?;
    if input.code.0.expose().len() > 4096 {
        return Err(ApiError::validation("request", "invalid request"));
    }
    let mut asking_owner = owner(&context);
    asking_owner.source = {
        let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
        SourceContext::read(&mut conn).await?
    };
    let prepared = service
        .prepare_complete(
            &asking_owner,
            input.attempt_id,
            input.state.0.expose(),
            input.code.0.expose(),
            state.now().unix_timestamp(),
        )
        .await
        .map_err(cloud_error)?;
    // The owner task keeps the role transaction alive through DPAPI/journal
    // commit even if the requesting shell closes its HTTP connection.
    tokio::spawn(async move {
        let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
        context.require_admin_in(&mut tx).await?;
        if SourceContext::read(&mut tx).await? != asking_owner.source {
            return Err(ApiError::conflict(
                "dataset_changed",
                "the source database changed during authorization",
            ));
        }
        service
            .commit(prepared, &state.timestamp())
            .await
            .map_err(cloud_error)?;
        let ids = write_events_in(
            &mut tx,
            &service.journal.events().await.map_err(cloud_error)?,
        )
        .await
        .map_err(cloud_error)?;
        tx.commit().await.map_err(ApiError::internal)?;
        for id in ids {
            service.journal.ack_event(id).await.map_err(cloud_error)?;
        }
        service
            .status(state.now().unix_timestamp())
            .await
            .map(Json)
            .map_err(cloud_error)
    })
    .await
    .map_err(|_| internal_error())?
}
pub async fn cancel(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<YandexBackupStatus>, ApiError> {
    context.require_admin()?;
    let id =
        Uuid::parse_str(&id).map_err(|_| ApiError::validation("attemptId", "invalid attempt"))?;
    let service = service(&state)?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    service
        .cancel(&owner(&context), id)
        .await
        .map_err(cloud_error)?;
    tx.commit().await.map_err(ApiError::internal)?;
    service
        .status(state.now().unix_timestamp())
        .await
        .map(Json)
        .map_err(cloud_error)
}
pub async fn disconnect(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Request,
) -> Result<Json<YandexBackupStatus>, ApiError> {
    context.require_admin()?;
    let input: GenerationBody = body(request).await?;
    let service = service(&state)?;
    tokio::spawn(async move {
        let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
        context.require_admin_in(&mut tx).await?;
        service
            .disconnect(
                &owner(&context),
                input.expected_generation,
                &state.timestamp(),
            )
            .await
            .map_err(cloud_error)?;
        let ids = write_events_in(
            &mut tx,
            &service.journal.events().await.map_err(cloud_error)?,
        )
        .await
        .map_err(cloud_error)?;
        tx.commit().await.map_err(ApiError::internal)?;
        for id in ids {
            service.journal.ack_event(id).await.map_err(cloud_error)?;
        }
        service
            .status(state.now().unix_timestamp())
            .await
            .map(Json)
            .map_err(cloud_error)
    })
    .await
    .map_err(|_| internal_error())?
}
pub async fn retry(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Request,
) -> Result<(StatusCode, Json<YandexBackupStatus>), ApiError> {
    context.require_admin()?;
    let input: GenerationBody = body(request).await?;
    let service = service(&state)?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    service
        .journal
        .retry(input.expected_generation)
        .await
        .map_err(cloud_error)?;
    tx.commit().await.map_err(ApiError::internal)?;
    service.wake_workers();
    let status = service
        .status(state.now().unix_timestamp())
        .await
        .map_err(cloud_error)?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

#[cfg(test)]
mod error_response_tests {
    use super::*;
    use axum::response::IntoResponse;

    async fn assert_reason(error: Error, reason: &str) {
        let response = cloud_error(error).into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "error": {
                    "code": "conflict",
                    "message": "Yandex backup operation failed",
                    "details": {"constraint": "yandex_backup", "reason": reason}
                }
            })
        );
    }

    #[tokio::test]
    async fn invalid_attempt_reports_connection_changed() {
        assert_reason(Error::InvalidAttempt, "connection_changed").await;
    }

    #[tokio::test]
    async fn canonical_cloud_reasons_survive_http_serialization() {
        for (error, reason) in [
            (
                Error::Provider("client_credentials_invalid"),
                "client_credentials_invalid",
            ),
            (Error::SecretUnavailable, "secret_unavailable"),
            (Error::Provider("quota"), "quota_exceeded"),
            (Error::Provider("remote_conflict"), "remote_conflict"),
            (Error::Provider("cancelled"), "cancelled"),
        ] {
            assert_reason(error, reason).await;
        }
    }

    #[tokio::test]
    async fn raw_error_text_and_secrets_are_not_serialized() {
        assert_reason(Error::Provider("access_token=private-token"), "network").await;
        assert_reason(
            Error::Io(std::io::Error::other("client_secret=private-secret")),
            "local_space",
        )
        .await;
    }
}
