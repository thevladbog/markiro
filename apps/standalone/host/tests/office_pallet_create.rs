mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, shift_setup, with_device, Admin};
use support::handheld::{box_sscc, closed_boxes};

const CREATE: &str = "/v1/office/warehouse-pallets";
const VALIDATE: &str = "/v1/office/warehouse-pallets/validate";

fn checked(body: &str) -> String {
    let sum: u32 = body
        .bytes()
        .enumerate()
        .map(|(i, b)| u32::from(b - b'0') * if i % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

async fn fixture(count: u32) -> (Admin, Vec<String>) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, count).await;
    let mut codes = vec![];
    for i in 0..count {
        let old = box_sscc(1500 + i);
        let code = checked(&old[..17]);
        sqlx::query("UPDATE boxes SET sscc = ? WHERE sscc = ?")
            .bind(&code)
            .bind(&old)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        codes.push(code);
    }
    (admin, codes)
}

async fn create(admin: &Admin, id: &str, codes: &[String]) -> (StatusCode, Value) {
    admin
        .call("POST", CREATE, Some(json!({"requestId":id,"codes":codes})))
        .await
}

#[tokio::test]
async fn creates_one_closed_pallet_atomically_and_retries_before_membership_validation() {
    let (admin, codes) = fixture(2).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (status, check) = admin
        .call("POST", VALIDATE, Some(json!({"codes":codes})))
        .await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(
        (
            check["valid"].clone(),
            check["boxes"].clone(),
            check["units"].clone()
        ),
        (json!(true), json!(2), json!(2))
    );
    let (status, created) = create(&admin, &id, &codes).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let number = created["sscc"].as_str().unwrap();
    assert_eq!(number.len(), 18);
    assert!(number.starts_with('1'));
    assert_eq!(checked(&number[..17]), number);
    let before: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, repeated) = create(
        &admin,
        &id,
        &[format!("(00){}", codes[1]), format!("00{}", codes[0])],
    )
    .await;
    assert_eq!(repeated, created);
    let after: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    let (source,author,boxes,consumed):(String,String,i64,i64)=sqlx::query_as("SELECT wp.source,wp.created_by_user_id,(SELECT count(*) FROM warehouse_pallet_boxes wb WHERE wb.pallet_id=wp.id),(SELECT consumed_through FROM sscc_blocks sb WHERE sb.id=wp.block_id) FROM warehouse_pallets wp WHERE wp.id=?").bind(created["id"].as_str().unwrap()).fetch_one(&admin.app.state.pool).await.unwrap();
    assert_eq!(
        (source, author, boxes),
        ("cabinet".into(), admin.id.clone(), 2)
    );
    assert!(consumed >= 0);
    let audits:Vec<(String,String,String,String,String)>=sqlx::query_as("SELECT actor_kind,actor_id,target_type,target_id,details FROM audit_log WHERE action='pallet.create'").fetch_all(&admin.app.state.pool).await.unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(
        (&*audits[0].0, &*audits[0].1, &*audits[0].2, &*audits[0].3),
        (
            "office_user",
            admin.id.as_str(),
            "warehouse_pallet",
            created["id"].as_str().unwrap()
        )
    );
    let details: Value = serde_json::from_str(&audits[0].4).unwrap();
    assert_eq!(details["sscc"], created["sscc"]);
    assert_eq!(details["boxes"], json!(2));
    let (status, mismatch) = create(&admin, &id, &codes[..1]).await;
    assert_eq!(
        (status, mismatch["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("request_id"))
    );
}

#[tokio::test]
async fn invalid_or_duplicate_lines_never_create_a_partial_pallet_or_spend_a_number() {
    let (admin, codes) = fixture(1).await;
    let before: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let list = vec![
        codes[0].clone(),
        "".into(),
        format!("00{}", codes[0]),
        "123".into(),
        checked("04600682009999999"),
    ];
    let (status, validation) = admin
        .call("POST", VALIDATE, Some(json!({"codes":list})))
        .await;
    assert_eq!(status, StatusCode::OK, "{validation}");
    assert_eq!(validation["valid"], json!(false));
    let errors = validation["errors"].as_array().unwrap();
    assert!(errors
        .iter()
        .any(|e| e["line"] == 1 && e["code"] == "duplicate"));
    assert!(errors
        .iter()
        .any(|e| e["line"] == 3 && e["code"] == "duplicate"));
    assert!(errors
        .iter()
        .any(|e| e["line"] == 4 && e["code"] == "invalid_sscc"));
    assert!(errors
        .iter()
        .any(|e| e["line"] == 5 && e["code"] == "not_found"));
    let (status, refused) = create(&admin, &uuid::Uuid::new_v4().to_string(), &list).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["validation"], validation);
    let after: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM warehouse_pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn concurrent_intents_have_one_winner_and_revalidation_preserves_the_losing_list() {
    let (admin, codes) = fixture(2).await;
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    let (x, y) = tokio::join!(create(&admin, &a, &codes), create(&admin, &b, &codes));
    assert!(
        matches!(
            (x.0, y.0),
            (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
        ),
        "{x:?} {y:?}"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM warehouse_pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let losing = if x.0 == StatusCode::CONFLICT {
        x.1
    } else {
        y.1
    };
    assert!(losing["error"]["details"]["validation"]["errors"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["code"] == "already_on_pallet"));
}

#[tokio::test]
async fn device_key_without_office_session_is_refused_and_oversized_input_is_bounded() {
    let (admin, codes) = fixture(1).await;
    let (status, _) = admin
        .app
        .send(empty(with_device(request("POST", CREATE), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = admin
        .call(
            "POST",
            VALIDATE,
            Some(json!({"codes":vec![codes[0].clone();1001]})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = admin
        .call("POST", VALIDATE, Some(json!({"codes":[],"extra":true})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn feature_limits_refuse_new_intents_but_keep_an_already_committed_answer() {
    use support::license::{file, load_ok};
    let (admin, codes) = fixture(2).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (status, created) = create(&admin, &id, &codes[..1]).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    load_ok(
        &admin,
        &file(&admin.app.state.host_id, |t| {
            t["features"]["pallets"] = json!(false)
        }),
    )
    .await;
    let (status, refused) = create(&admin, &uuid::Uuid::new_v4().to_string(), &codes[1..]).await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("feature_disabled"))
    );
    let (status, retry) = create(&admin, &id, &codes[..1]).await;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert_eq!(retry, created);
}

#[tokio::test]
async fn exhausted_numbers_and_a_restore_hold_leave_the_whole_composition_untouched() {
    let (admin, codes) = fixture(1).await;
    sqlx::query("UPDATE site SET facts_held_since=? WHERE id=1")
        .bind(admin.app.state.timestamp())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, refused) = create(&admin, &uuid::Uuid::new_v4().to_string(), &codes).await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("restore_hold"))
    );
    sqlx::query("UPDATE site SET facts_held_since=NULL WHERE id=1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE sscc_counters SET next_serial=10000000 WHERE extension=1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, refused) = create(&admin, &uuid::Uuid::new_v4().to_string(), &codes).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("sscc_exhausted"))
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM warehouse_pallet_boxes")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn technologists_can_create_but_a_deactivated_session_cannot_repeat_or_create() {
    let (admin, codes) = fixture(2).await;
    let (token, user) = admin.technologist_session().await;
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"requestId":id,"codes":[codes[0]]});
    let (status, created) = admin
        .call_as(&token, "POST", CREATE, Some(input.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let author: String =
        sqlx::query_scalar("SELECT created_by_user_id FROM warehouse_pallets WHERE id=?")
            .bind(created["id"].as_str().unwrap())
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(author, user);
    sqlx::query("UPDATE office_users SET active=0 WHERE id=?")
        .bind(&user)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = admin.call_as(&token, "POST", CREATE, Some(input)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn allocated_office_number_cannot_be_reseeded_or_reissued_and_registry_membership_is_visible()
{
    let (admin, codes) = fixture(1).await;
    let (status, created) = create(&admin, &uuid::Uuid::new_v4().to_string(), &codes).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (prefix, next, rev): (String, i64, i64) =
        sqlx::query_as("SELECT issuer_prefix,next_serial,rev FROM sscc_counters WHERE extension=1")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let (status, refused) = admin
        .call(
            "PUT",
            &format!("/v1/office/sscc/counters/{prefix}/1"),
            Some(json!({"expectedRev":rev,"nextSerial":next-1})),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("sscc_below_floor"))
    );
    let key = support::app::pair_handheld(&admin).await;
    let (status, registry) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/box-registry"),
            &key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{registry}");
    let text = registry.to_string();
    assert!(text.contains(created["id"].as_str().unwrap()), "{registry}");
    let result: String =
        sqlx::query_scalar("SELECT result FROM audit_log WHERE action='pallet.create'")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(result, "ok");
}

#[tokio::test]
async fn demo_boxes_never_create_a_real_pallet_or_spend_real_serials() {
    let (admin, codes) = fixture(1).await;
    sqlx::query("UPDATE products SET demo=1 WHERE id=(SELECT product_id FROM shifts WHERE id=(SELECT shift_id FROM boxes WHERE sscc=?))")
        .bind(&codes[0]).execute(&admin.app.state.pool).await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, validation) = admin
        .call("POST", VALIDATE, Some(json!({"codes":codes})))
        .await;
    assert_eq!(status, StatusCode::OK, "{validation}");
    assert_eq!(validation["valid"], json!(false));
    assert_eq!(validation["errors"][0]["code"], json!("demo_box"));
    let (status, refused) = create(&admin, &uuid::Uuid::new_v4().to_string(), &codes).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    let after: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_counters WHERE extension=1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM warehouse_pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn blank_lines_do_not_count_towards_the_box_limit() {
    let (admin, codes) = fixture(1).await;
    let mut input = vec![String::new(); 15_000];
    input.push(codes[0].clone());
    let (status, validation) = admin
        .call("POST", VALIDATE, Some(json!({"codes":input})))
        .await;
    assert_eq!(status, StatusCode::OK, "{validation}");
    assert_eq!(
        (validation["valid"].clone(), validation["boxes"].clone()),
        (json!(true), json!(1))
    );
}
