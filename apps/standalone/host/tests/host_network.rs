//! The host's address as the office sees it, and the mark that it stays (plan ТСД-П, task П4): the
//! addresses come from the system, the mark is the administrator's and is also taken from the wizard.

mod support;

use axum::http::StatusCode;
use markiro_proto::{AddressMode, HostAddress};
use serde_json::json;
use support::app::{
    admin, audit_trail, bootstrap_body, json as json_request, pair_device, request, with_device,
    TestApp,
};

fn dhcp() -> Vec<HostAddress> {
    vec![HostAddress {
        address: "192.168.1.10".into(),
        mode: AddressMode::Dhcp,
        mac: Some("AA-BB-CC-DD-EE-FF".into()),
        alias: Some("Беспроводная сеть".into()),
    }]
}

#[tokio::test]
async fn the_office_reads_the_addresses_and_an_administrator_confirms_them() {
    let mut admin = admin().await;
    admin.app.state = admin.app.state.clone().with_address_details(dhcp);
    let (status, network) = admin.call("GET", "/v1/office/host-network", None).await;
    assert_eq!(status, StatusCode::OK, "{network}");
    assert_eq!(
        network,
        json!({
            "addresses": [{ "address": "192.168.1.10", "mode": "dhcp", "mac": "AA-BB-CC-DD-EE-FF", "alias": "Беспроводная сеть" }],
            "port": 45710,
            "confirmedAt": null
        })
    );
    let (status, confirmed) = admin
        .call(
            "PUT",
            "/v1/office/host-network",
            Some(json!({ "confirmed": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["confirmedAt"], json!(admin.app.state.timestamp()));
    assert_eq!(
        audit_trail(&admin.app, "host_network.confirm").await,
        vec![admin.row(
            "host_network.confirm",
            "site",
            "1",
            json!({ "confirmed": true })
        )]
    );
    // Taken back, it is `null` again.
    let (_, cleared) = admin
        .call(
            "PUT",
            "/v1/office/host-network",
            Some(json!({ "confirmed": false })),
        )
        .await;
    assert_eq!(cleared["confirmedAt"], json!(null));
}

#[tokio::test]
async fn a_technologist_reads_but_does_not_confirm() {
    let admin = admin().await;
    let token = admin.technologist().await;
    let (status, _) = admin
        .call_as(&token, "GET", "/v1/office/host-network", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = admin
        .call_as(
            &token,
            "PUT",
            "/v1/office/host-network",
            Some(json!({ "confirmed": true })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

async fn wizard(app: &TestApp, body: serde_json::Value) -> serde_json::Value {
    let (_, key) = pair_device(app, "station").await;
    let (status, answer) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    answer
}

#[tokio::test]
async fn the_wizard_may_confirm_the_address_and_says_so_in_its_audit_row_only_then() {
    let app = TestApp::new().await;
    let mut body = bootstrap_body();
    body["addressConfirmed"] = json!(true);
    wizard(&app, body).await;
    let confirmed: Option<String> =
        sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(confirmed, Some(app.state.timestamp()));
    let trail = audit_trail(&app, "host.bootstrap").await;
    assert_eq!(trail[0].6["addressConfirmed"], json!(true));

    let plain = TestApp::new().await;
    wizard(&plain, bootstrap_body()).await;
    let none: Option<String> =
        sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
            .fetch_one(&plain.state.pool)
            .await
            .unwrap();
    assert_eq!(none, None);
    assert!(audit_trail(&plain, "host.bootstrap").await[0]
        .6
        .get("addressConfirmed")
        .is_none());
}
