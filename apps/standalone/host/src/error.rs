//! Error responses: an HTTP status plus the protocol's `ErrorBody`, and the
//! extractors whose rejections must use that body too.

use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{codes, ErrorBody, MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody::new(code, message),
        }
    }

    /// Attach structured detail. Only a JSON object is kept: the protocol's
    /// `details` is always an object.
    pub fn with_details(mut self, details: Value) -> Self {
        if let Value::Object(map) = details {
            self.body.error.details = Some(map);
        }
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &str {
        &self.body.error.code
    }

    /// The diagnostic text; never shown to a person.
    pub fn message(&self) -> &str {
        &self.body.error.message
    }

    /// The structured detail, if any (`field`, `constraint`, `currentRev`, …).
    pub fn details(&self) -> Option<&serde_json::Map<String, Value>> {
        self.body.error.details.as_ref()
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, codes::NOT_FOUND, message)
    }

    pub fn method_not_allowed(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            codes::METHOD_NOT_ALLOWED,
            message,
        )
    }

    /// `received` is the version the client sent, if any could be read.
    pub fn protocol_unsupported(received: Option<u32>) -> Self {
        let message = match received {
            Some(version) => {
                format!("protocol {version} is outside {MIN_PROTOCOL_VERSION}..={PROTOCOL_VERSION}")
            }
            None => format!("header {PROTOCOL_HEADER} with a protocol version is required"),
        };
        Self::new(
            StatusCode::BAD_REQUEST,
            codes::PROTOCOL_UNSUPPORTED,
            message,
        )
        .with_details(json!({
            "protocol": received,
            "minProtocol": MIN_PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
        }))
    }

    /// A field-level input error; `field` uses the request's JSON path
    /// (`org.gln`, `admin.password`).
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
            .with_details(json!({ "field": field }))
    }

    /// A request that could not be read at all (bad JSON, wrong types, unknown fields).
    pub fn malformed(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
    }

    /// `credential` is one of [`markiro_proto::credentials`]: which credential
    /// failed, so the client can tell "re-pair this device" from "sign in
    /// again" from "wrong password" apart (spec §4.6).
    pub fn unauthorized(credential: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, codes::UNAUTHORIZED, message)
            .with_details(json!({ "credential": credential }))
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, codes::FORBIDDEN, message)
    }

    /// A uniqueness conflict; `constraint` names it (`login`, `gtin`, …).
    pub fn conflict(constraint: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, codes::CONFLICT, message)
            .with_details(json!({ "constraint": constraint }))
    }

    /// A write that failed on a table with a unique index: a unique violation
    /// is the client's `conflict` on `constraint`, and any other error is
    /// `internal` (logged with its cause). One place decides which sqlx
    /// errors are the client's doing.
    pub fn conflict_on_unique_violation(
        error: sqlx::Error,
        constraint: &str,
        message: impl Into<String>,
    ) -> Self {
        match error.as_database_error() {
            Some(database) if database.is_unique_violation() => Self::conflict(constraint, message),
            _ => Self::internal(error),
        }
    }

    /// The row changed since the client read it.
    pub fn stale_revision(current_rev: i64) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            codes::STALE_REVISION,
            "the record changed since it was read",
        )
        .with_details(json!({ "currentRev": current_rev }))
    }

    /// Logs the cause on the host; the client only learns that it failed.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::INTERNAL,
            "internal error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// `Json<T>` whose rejections become `validation_failed`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// An optional JSON body: without a `Content-Type` header there is none
/// (`None`); with one, the body must parse, and its rejections become
/// `validation_failed` like `ApiJson`'s.
impl<S, T> axum::extract::OptionalFromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Option<Self>, Self::Rejection> {
        match <Json<T> as axum::extract::OptionalFromRequest<S>>::from_request(request, state).await
        {
            Ok(value) => Ok(value.map(|Json(value)| Self(value))),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// `Path<T>` whose rejections become `validation_failed`.
pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// `Query<T>` whose rejections become `validation_failed`.
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real failures from SQLite: only a unique violation is the client's
    /// `conflict`; another constraint or a failure that is not the database's
    /// at all is `internal`, and its cause stays out of the response.
    #[tokio::test]
    async fn only_a_unique_violation_is_the_clients_conflict() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE names (name TEXT NOT NULL UNIQUE)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO names (name) VALUES ('a')")
            .execute(&pool)
            .await
            .unwrap();

        let duplicate = sqlx::query("INSERT INTO names (name) VALUES ('a')")
            .execute(&pool)
            .await
            .unwrap_err();
        let conflict = ApiError::conflict_on_unique_violation(duplicate, "name", "taken");
        assert_eq!(
            (conflict.status(), conflict.code(), conflict.message()),
            (StatusCode::CONFLICT, "conflict", "taken")
        );
        assert_eq!(conflict.details().unwrap()["constraint"], "name");

        let not_null = sqlx::query("INSERT INTO names (name) VALUES (NULL)")
            .execute(&pool)
            .await
            .unwrap_err();
        for error in [not_null, sqlx::Error::RowNotFound] {
            let internal = ApiError::conflict_on_unique_violation(error, "name", "taken");
            assert_eq!(
                (internal.status(), internal.code(), internal.message()),
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal error"
                )
            );
            assert!(internal.details().is_none());
        }
    }
}
