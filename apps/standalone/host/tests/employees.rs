//! Employees (migration `0017`): the site's register of people, as the
//! cloud's `employees`, and the optional link of an employee to one operator.
//! Office data for administrators only, never in the station feed.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, audit_trail, empty, host_revision, request, tombstones,
    with_device, Admin,
};

const EMPLOYEES: &str = "/v1/office/employees";

fn field(body: &Value) -> Value {
    body["error"]["details"]["field"].clone()
}

fn code(body: &Value) -> Value {
    body["error"]["code"].clone()
}

/// A new employee «Анна Кузнецова», linked to `operator_id` when given.
async fn create(admin: &Admin, operator_id: Option<&str>) -> Value {
    let (status, created) = admin
        .call(
            "POST",
            EMPLOYEES,
            Some(
                json!({ "name": "Анна Кузнецова", "role": "Упаковщик", "operatorId": operator_id }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

/// `PUT` the whole employee with `changes` on top of `current`.
async fn put(admin: &Admin, current: &Value, changes: Value) -> (StatusCode, Value) {
    let mut body = json!({
        "name": current["name"], "role": current["role"], "operatorId": current["operatorId"],
        "archived": current["archived"], "expectedRev": current["rev"],
    });
    for (key, value) in changes.as_object().unwrap() {
        body[key] = value.clone();
    }
    let id = current["id"].as_str().unwrap();
    admin
        .call("PUT", &format!("{EMPLOYEES}/{id}"), Some(body))
        .await
}

#[tokio::test]
async fn an_administrator_creates_an_employee_that_never_reaches_a_station() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let (status, created) = admin
        .call(
            "POST",
            EMPLOYEES,
            Some(json!({ "name": " Анна Кузнецова ", "role": "  " })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({
            "id": id, "name": "Анна Кузнецова", "role": null, "operatorId": null,
            "archived": false, "rev": before + 1
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "employee.create").await,
        vec![admin.row(
            "employee.create",
            "employee",
            &id,
            json!({ "role": null, "operatorId": null })
        )]
    );
    let (status, list) = admin.call("GET", EMPLOYEES, None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created])));
    // The revision moved, and the station's feed carries no employee.
    assert_eq!(admin.feed(before).await, json!([]));
}

#[tokio::test]
async fn employee_fields_are_checked_and_a_refusal_writes_nothing() {
    let admin = admin().await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (body, expected) in [
        (json!({ "name": " " }), json!("name")),
        (json!({ "name": "м".repeat(101) }), json!("name")),
        (json!({ "name": "Анна\u{0}" }), json!("name")),
        (
            json!({ "name": "Анна", "role": "м".repeat(121) }),
            json!("role"),
        ),
        (
            json!({ "name": "Анна", "operatorId": "9b2e4a6c-0000-4000-8000-000000000000" }),
            json!("operatorId"),
        ),
    ] {
        let (status, error) = admin.call("POST", EMPLOYEES, Some(body.clone())).await;
        assert_eq!(
            (status, field(&error)),
            (StatusCode::BAD_REQUEST, expected),
            "{body}"
        );
    }
    // No PIN, badge or personnel number rides an employee.
    let (status, error) = admin
        .call(
            "POST",
            EMPLOYEES,
            Some(json!({ "name": "Анна", "login": "0042" })),
        )
        .await;
    assert_eq!(
        (status, code(&error), field(&error)),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            Value::Null
        )
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_employee_is_linked_to_one_operator_and_an_operator_to_one_employee() {
    let admin = admin().await;
    let (operator, operator_rev) = add_operator(&admin, "0042").await;
    let anna = create(&admin, Some(&operator)).await;
    let anna_id = anna["id"].as_str().unwrap();
    assert_eq!(anna["operatorId"], json!(operator));
    assert_eq!(
        audit_trail(&admin.app, "employee.create").await,
        vec![admin.row(
            "employee.create",
            "employee",
            anna_id,
            json!({ "role": "Упаковщик", "operatorId": operator })
        )]
    );

    // A second employee cannot take the same operator, on create or on update.
    let revision = host_revision(&admin.app).await;
    let (status, error) = admin
        .call(
            "POST",
            EMPLOYEES,
            Some(json!({ "name": "Пётр Иванов", "operatorId": operator })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"],
        json!({ "constraint": "operator", "employeeId": anna_id })
    );
    let petr = create(&admin, None).await;
    let (status, error) = put(&admin, &petr, json!({ "operatorId": operator })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"],
        json!({ "constraint": "operator", "employeeId": anna_id })
    );
    assert_eq!(
        host_revision(&admin.app).await,
        revision + 1,
        "only Пётр's create"
    );

    // Unlinking and linking again are updates of `operatorId`.
    let (status, unlinked) = put(&admin, &anna, json!({ "operatorId": null })).await;
    assert_eq!(
        (status, unlinked["operatorId"].clone()),
        (StatusCode::OK, Value::Null)
    );
    let (status, linked) = put(&admin, &petr, json!({ "operatorId": operator })).await;
    assert_eq!(
        (status, linked["operatorId"].clone()),
        (StatusCode::OK, json!(operator))
    );
    assert_eq!(
        audit_trail(&admin.app, "employee.update").await,
        vec![
            admin.row(
                "employee.update",
                "employee",
                anna_id,
                json!({ "changed": ["operatorId"], "operatorId": { "from": operator, "to": null } })
            ),
            admin.row(
                "employee.update",
                "employee",
                petr["id"].as_str().unwrap(),
                json!({ "changed": ["operatorId"], "operatorId": { "from": null, "to": operator } })
            ),
        ]
    );

    // The operator itself did not change: same record, same revision, the
    // station's copy untouched.
    let (_, operators) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(operators[0]["rev"], json!(operator_rev));
    let feed = admin.feed(0).await;
    let items: Vec<&Value> = feed
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "operators")
        .collect();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["rev"], json!(operator_rev));
    assert_eq!(tombstones(&admin.app).await, vec![]);
}

#[tokio::test]
async fn a_turned_off_operator_can_be_linked_and_stays_linked() {
    let admin = admin().await;
    let (operator, rev) = add_operator(&admin, "0042").await;
    let (status, off) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{operator}"),
            Some(json!({ "active": false, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    let anna = create(&admin, Some(&operator)).await;
    assert_eq!(anna["operatorId"], json!(operator));
}

#[tokio::test]
async fn an_archived_employee_is_linked_to_no_operator() {
    let admin = admin().await;
    let (operator, _) = add_operator(&admin, "0042").await;
    let anna = create(&admin, Some(&operator)).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, error) = put(&admin, &anna, json!({ "archived": true })).await;
    assert_eq!(
        (status, field(&error)),
        (StatusCode::BAD_REQUEST, json!("operatorId")),
        "{error}"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // Archiving with the unlink in the same request is one change.
    let (status, archived) = put(
        &admin,
        &anna,
        json!({ "archived": true, "operatorId": null }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(
        (archived["archived"].clone(), archived["operatorId"].clone()),
        (json!(true), Value::Null)
    );
    assert_eq!(
        audit_trail(&admin.app, "employee.update").await,
        vec![admin.row(
            "employee.update",
            "employee",
            anna["id"].as_str().unwrap(),
            json!({
                "changed": ["operatorId", "archived"],
                "operatorId": { "from": operator, "to": null },
                "archived": { "from": false, "to": true }
            })
        )]
    );
    // An archived employee is not linked again either.
    let (status, error) = put(&admin, &archived, json!({ "operatorId": operator })).await;
    assert_eq!(
        (status, field(&error)),
        (StatusCode::BAD_REQUEST, json!("operatorId"))
    );
    // The database keeps the rule too.
    let error = sqlx::query("UPDATE employees SET operator_id = ? WHERE id = ?")
        .bind(&operator)
        .bind(anna["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("CHECK"), "{error}");
}

#[tokio::test]
async fn an_update_names_its_changes_and_a_no_op_or_a_stale_one_writes_nothing() {
    let admin = admin().await;
    let anna = create(&admin, None).await;
    let id = anna["id"].as_str().unwrap();
    let (status, renamed) = put(
        &admin,
        &anna,
        json!({ "name": " Анна Смирнова ", "role": null }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (renamed["name"].clone(), renamed["role"].clone()),
        (json!("Анна Смирнова"), Value::Null)
    );
    assert_eq!(
        audit_trail(&admin.app, "employee.update").await,
        vec![admin.row(
            "employee.update",
            "employee",
            id,
            json!({
                "changed": ["name", "role"],
                "name": { "from": "Анна Кузнецова", "to": "Анна Смирнова" },
                "role": { "from": "Упаковщик", "to": null }
            })
        )]
    );
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    // The same record again changes nothing.
    let (status, same) = put(&admin, &renamed, json!({})).await;
    assert_eq!((status, same), (StatusCode::OK, renamed.clone()));
    // A write over the old revision is stale.
    let (status, error) = put(&admin, &anna, json!({ "name": "Другая" })).await;
    assert_eq!(
        (status, code(&error)),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );
    // An unknown employee is not found.
    let (status, error) = admin
        .call(
            "PUT",
            &format!("{EMPLOYEES}/9b2e4a6c-0000-4000-8000-000000000000"),
            Some(json!({ "name": "Анна", "role": null, "operatorId": null, "archived": false, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, code(&error)),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn technologists_and_a_device_key_alone_reach_no_employee_route() {
    let admin = admin().await;
    let anna = create(&admin, None).await;
    let path = format!("{EMPLOYEES}/{}", anna["id"].as_str().unwrap());
    let update = json!({ "name": "Анна", "role": null, "operatorId": null, "archived": false, "expectedRev": anna["rev"] });
    let tech = admin.technologist().await;
    // After the technologist's sign-in, which writes its own row.
    let rows = audit_rows(&admin.app).await;
    let requests = [
        ("GET", EMPLOYEES.to_owned(), None),
        (
            "POST",
            EMPLOYEES.to_owned(),
            Some(json!({ "name": "Пётр" })),
        ),
        ("PUT", path, Some(update)),
    ];
    for (method, path, body) in requests.clone() {
        let (status, error) = admin.call_as(&tech, method, &path, body).await;
        assert_eq!(
            (status, code(&error)),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
    // A station's key opens no office route: operators sign in on the
    // station itself and never hold a host session.
    for (method, path, body) in requests {
        let builder = with_device(request(method, &path), &admin.key);
        let (status, error) = match body {
            Some(body) => admin.app.send(support::app::json(builder, body)).await,
            None => admin.app.send(empty(builder)).await,
        };
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {error}");
        assert_eq!(error["error"]["details"]["credential"], "session");
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}
