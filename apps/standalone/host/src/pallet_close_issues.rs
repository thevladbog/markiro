//! Reconciliation of a station's locally closed and possibly printed warehouse pallet.

use markiro_proto::{
    receipt_codes, WarehousePalletCloseIssue, WarehousePalletCloseIssueStatus as Status,
    WarehousePalletClosedData,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::facts::{blocks, registry_touch, Failure, Reject};
use crate::pallet_events::validate_close_serial;

const SELECT_ISSUE: &str = "SELECT issue.id, issue.device_id, device.name AS device_name, \
    issue.pallet_id, issue.sscc, issue.block_id, issue.serial, issue.reported_boxes, issue.code, \
    issue.created_at, issue.status, issue.approved_boxes \
    FROM warehouse_pallet_close_issues issue JOIN devices device ON device.id = issue.device_id";
const MAX_BOXES: usize = 10_000;

#[derive(sqlx::FromRow)]
pub(crate) struct Issue {
    pub id: String,
    pub device_id: String,
    device_name: String,
    pub pallet_id: String,
    sscc: String,
    block_id: String,
    serial: i64,
    reported_boxes: u32,
    code: String,
    created_at: String,
    status: String,
    approved_boxes: Option<String>,
}

impl Issue {
    pub fn status(&self) -> Result<Status, ApiError> {
        self.status.parse().map_err(ApiError::internal)
    }

    fn approved_box_ssccs(&self) -> Result<Option<Vec<String>>, ApiError> {
        self.approved_boxes
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(ApiError::internal)
    }

    fn same_serial(&self, data: &WarehousePalletClosedData) -> bool {
        self.pallet_id == data.pallet_id
            && self.sscc == data.sscc
            && self.block_id == data.block_id
            && u64::try_from(self.serial) == Ok(data.serial)
    }

    pub async fn wire(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<WarehousePalletCloseIssue, ApiError> {
        let current_box_ssccs = self.current_box_ssccs(conn).await?;
        let approved_box_ssccs = self.approved_box_ssccs()?;
        Ok(WarehousePalletCloseIssue {
            id: self.id.clone(),
            pallet_id: self.pallet_id.clone(),
            sscc: self.sscc.clone(),
            code: self.code.clone(),
            status: self.status()?,
            reported_boxes: self.reported_boxes,
            current_boxes: current_box_ssccs.len() as u32,
            approved_boxes: approved_box_ssccs.as_ref().map(|boxes| boxes.len() as u32),
            current_box_ssccs,
            approved_box_ssccs,
            created_at: self.created_at.clone(),
            device_name: self.device_name.clone(),
        })
    }

    async fn current_box_ssccs(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<Vec<String>, ApiError> {
        let boxes: Vec<String> = sqlx::query_scalar(
            "SELECT box.sscc FROM warehouse_pallet_boxes member \
             JOIN warehouse_pallets pallet ON pallet.id = member.pallet_id \
             JOIN boxes box ON box.sscc = member.box_sscc \
             WHERE pallet.id = ? AND pallet.device_id = ? AND pallet.source = 'device' \
             AND pallet.assembly_cancelled_at IS NULL AND member.removed_at IS NULL \
             AND box.closed_at IS NOT NULL AND box.disassembled_at IS NULL \
             ORDER BY box.sscc LIMIT ?",
        )
        .bind(&self.pallet_id)
        .bind(&self.device_id)
        .bind(MAX_BOXES as i64 + 1)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
        if boxes.len() > MAX_BOXES {
            return Err(ApiError::conflict(
                "pallet_members_limit",
                "pallet composition is too large",
            ));
        }
        Ok(boxes)
    }

    async fn own_pallet(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<Option<Option<String>>, ApiError> {
        sqlx::query_scalar(
            "SELECT closed_at FROM warehouse_pallets WHERE id = ? AND device_id = ? \
             AND source = 'device' AND assembly_cancelled_at IS NULL",
        )
        .bind(&self.pallet_id)
        .bind(&self.device_id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)
    }

    async fn unused_serial(&self, conn: &mut SqliteConnection) -> Result<Option<i64>, ApiError> {
        let serial = u64::try_from(self.serial).map_err(ApiError::internal)?;
        match validate_close_serial(conn, &self.device_id, &self.block_id, &self.sscc, serial).await
        {
            Ok(serial) => Ok(Some(serial)),
            Err(Failure::Reject(_)) => Ok(None),
            Err(Failure::Internal(error)) => Err(error),
        }
    }

    pub async fn approve(
        &self,
        conn: &mut SqliteConnection,
        mut expected: Vec<String>,
    ) -> Result<bool, ApiError> {
        if expected.is_empty() || expected.len() > MAX_BOXES {
            return Err(ApiError::validation(
                "expectedBoxSsccs",
                "a nonempty bounded box set is required",
            ));
        }
        expected.sort_unstable();
        let status = self.status()?;
        if status == Status::Reclosed && self.approved_box_ssccs()?.as_ref() == Some(&expected) {
            return Ok(false);
        }
        if !matches!(status, Status::Pending | Status::Approved)
            || self.own_pallet(conn).await? != Some(None)
        {
            return Err(ApiError::conflict(
                "pallet_state",
                "an open station pallet is required",
            ));
        }
        if self.current_box_ssccs(conn).await? != expected {
            return Err(ApiError::conflict(
                "pallet_contents_changed",
                "review the current box set",
            ));
        }
        if self.unused_serial(conn).await?.is_none() {
            return Err(ApiError::conflict(
                "sscc_not_issued",
                "the printed SSCC cannot be reused",
            ));
        }
        if status == Status::Approved && self.approved_box_ssccs()?.as_ref() == Some(&expected) {
            return Ok(false);
        }
        sqlx::query("UPDATE warehouse_pallet_close_issues SET status = 'approved', approved_boxes = ? WHERE id = ?")
            .bind(json!(expected).to_string()).bind(&self.id).execute(conn).await.map_err(ApiError::internal)?;
        Ok(true)
    }

    pub async fn cancel(&self, conn: &mut SqliteConnection, at: &str) -> Result<bool, ApiError> {
        match self.status()? {
            Status::Cancelled => return Ok(false),
            Status::Reclosed => {
                return Err(ApiError::conflict(
                    "pallet_state",
                    "the pallet has already closed",
                ))
            }
            Status::Pending | Status::Approved => {}
        }
        if self.own_pallet(conn).await? == Some(None) {
            registry_touch::warehouse_pallet_boxes(conn, &self.pallet_id, at).await?;
            sqlx::query("UPDATE warehouse_pallet_boxes SET removed_at = ? WHERE pallet_id = ? AND removed_at IS NULL")
                    .bind(at).bind(&self.pallet_id).execute(&mut *conn).await.map_err(ApiError::internal)?;
            sqlx::query("UPDATE warehouse_pallets SET assembly_cancelled_at = ? WHERE id = ?")
                .bind(at)
                .bind(&self.pallet_id)
                .execute(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        }
        let serial = self.unused_serial(conn).await?;
        if let Some(serial) = serial {
            blocks::consume(conn, &self.block_id, serial).await?;
        }
        sqlx::query("UPDATE warehouse_pallet_close_issues SET status = 'cancelled', approved_boxes = NULL, retired = ? WHERE id = ?")
            .bind(serial.is_some()).bind(&self.id).execute(conn).await.map_err(ApiError::internal)?;
        Ok(true)
    }

    /// A repeated close can change only the count, and only after approval of the still-current set.
    pub async fn admit_reclose(
        &self,
        conn: &mut SqliteConnection,
        data: &WarehousePalletClosedData,
    ) -> Result<Option<Reject>, ApiError> {
        let Some(approved) = self.approved_box_ssccs()? else {
            return Ok(Some(with_issue(
                Reject::new(receipt_codes::PALLET_STATE),
                &self.id,
            )));
        };
        if !self.same_serial(data) || approved.len() != data.box_count as usize {
            return Ok(Some(with_issue(
                Reject::new(receipt_codes::PALLET_STATE),
                &self.id,
            )));
        }
        let current = self.current_box_ssccs(conn).await?;
        if current != approved {
            return Ok(Some(Reject {
                code: receipt_codes::PALLET_COUNT_MISMATCH,
                details: Some(json!({"counted": current.len()})),
            }));
        }
        Ok(None)
    }
}

pub(crate) fn with_issue(mut reject: Reject, id: &str) -> Reject {
    let details = reject.details.get_or_insert_with(|| json!({}));
    details["closeIssueId"] = json!(id);
    reject
}

pub(crate) async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<Issue>, ApiError> {
    sqlx::query_as(&format!("{SELECT_ISSUE} WHERE issue.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)
}

pub(crate) async fn active(
    conn: &mut SqliteConnection,
    device: &str,
) -> Result<Option<Issue>, ApiError> {
    sqlx::query_as(&format!(
        "{SELECT_ISSUE} WHERE issue.device_id = ? AND issue.status IN ('pending','approved')"
    ))
    .bind(device)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)
}

pub(crate) async fn list(conn: &mut SqliteConnection) -> Result<Vec<Issue>, ApiError> {
    sqlx::query_as(&format!("{SELECT_ISSUE} WHERE issue.status IN ('pending','approved') ORDER BY issue.created_at, issue.id"))
        .fetch_all(conn).await.map_err(ApiError::internal)
}

pub(crate) async fn cancelled(
    conn: &mut SqliteConnection,
    device: &str,
    pallet: &str,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT id FROM warehouse_pallet_close_issues WHERE device_id = ? AND pallet_id = ? AND status = 'cancelled'")
        .bind(device).bind(pallet).fetch_optional(conn).await.map_err(ApiError::internal)
}

/// Keep the first printed SSCC and case ID even when a subsequent reclose is rejected.
pub(crate) async fn record_rejection(
    conn: &mut SqliteConnection,
    device: &str,
    data: &WarehousePalletClosedData,
    reject: Reject,
    existing: Option<&Issue>,
    at: &str,
) -> Result<Reject, ApiError> {
    let id = if let Some(issue) = existing {
        sqlx::query("UPDATE warehouse_pallet_close_issues SET status = 'pending', approved_boxes = NULL, code = ? WHERE id = ?")
            .bind(reject.code).bind(&issue.id).execute(conn).await.map_err(ApiError::internal)?;
        issue.id.clone()
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let serial = i64::try_from(data.serial).map_err(ApiError::internal)?;
        sqlx::query("INSERT INTO warehouse_pallet_close_issues (id, device_id, pallet_id, sscc, block_id, serial, reported_boxes, code, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,'pending')")
            .bind(&id).bind(device).bind(&data.pallet_id).bind(&data.sscc).bind(&data.block_id)
            .bind(serial).bind(data.box_count).bind(reject.code).bind(at).execute(conn).await.map_err(ApiError::internal)?;
        id
    };
    Ok(with_issue(reject, &id))
}

pub(crate) async fn mark_reclosed(
    conn: &mut SqliteConnection,
    issue: &Issue,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE warehouse_pallet_close_issues SET status = 'reclosed' WHERE id = ?")
        .bind(&issue.id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

pub(crate) fn audit_details(
    issue: &WarehousePalletCloseIssue,
    action: &str,
    device: &str,
) -> Value {
    json!({"action":action,"palletId":issue.pallet_id,"sscc":issue.sscc,"deviceId":device,"approvedBoxes":issue.approved_boxes})
}
