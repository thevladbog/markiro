//! Actual PostgreSQL -> production history.sql/JSONL -> Rust routes -> TS renderers.
//! Opt-in because ordinary host tests must never guess a database or load .env.
mod support;
use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::Path, process::Command};
use support::app::{admin, cloud_import_request, Admin, IMPORT_ID};

fn id(n: u32) -> String {
    format!("a1720000-0000-4000-8000-{n:012}")
}
async fn get(a: &Admin, path: &str) -> Value {
    let (status, body) = a.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
fn render(root: &Path, directory: &Path, label: &str) {
    let output = Command::new("corepack")
        .args([
            "pnpm",
            "--filter",
            "@markiro/standalone",
            "exec",
            "vitest",
            "run",
            "test/cloud-history-postgres-reports.test.ts",
        ])
        .current_dir(root)
        .env("STANDALONE_HISTORY_ACCEPTANCE_OUT", directory)
        .output()
        .unwrap();
    std::fs::write(
        directory.join(format!("{label}.stdout.log")),
        &output.stdout,
    )
    .unwrap();
    std::fs::write(
        directory.join(format!("{label}.stderr.log")),
        &output.stderr,
    )
    .unwrap();
    assert!(
        output.status.success(),
        "renderer: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "requires dedicated migrated STANDALONE_EXPORT_TEST_DATABASE_URL, Node/Corepack and built workspace dependencies"]
async fn postgres_final_states_activate_render_release_and_preserve_saved_bytes() {
    std::env::var("STANDALONE_EXPORT_TEST_DATABASE_URL")
        .expect("dedicated PostgreSQL test URL required");
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let directory = std::env::var_os("STANDALONE_HISTORY_ACCEPTANCE_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| temporary.path().to_owned());
    std::fs::create_dir_all(&directory).unwrap();
    let output = Command::new("node")
        .arg(root.join("tools/standalone-export/test/support/host-history-fixture.mjs"))
        .arg(directory.join("history.jsonl"))
        .current_dir(&root)
        .output()
        .unwrap();
    std::fs::write(directory.join("postgres.stdout.log"), &output.stdout).unwrap();
    std::fs::write(directory.join("postgres.stderr.log"), &output.stderr).unwrap();
    assert!(
        output.status.success(),
        "PostgreSQL fixture/export: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = std::fs::read_to_string(directory.join("history.jsonl")).unwrap();
    let mut lines = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap());
    let manifest = lines.next().unwrap();
    let parts: Vec<_> = lines.collect();
    let a = admin().await;
    assert_eq!(
        a.call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(IMPORT_ID, false))
        )
        .await
        .0,
        StatusCode::OK
    );
    for part in &parts {
        let (status, body) = a
            .call(
                "POST",
                "/v1/office/import/history",
                Some(json!({"manifest":manifest,"part":part,"dryRun":false})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "actual SQL export rejected: {body}");
    }
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({"batchId":manifest["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "actual SQL graph rejected: {body}");
    let mut shifts = Vec::new();
    let mut boxes = Vec::new();
    let mut pallets = Vec::new();
    let mut owners = Vec::new();
    for part in &parts {
        shifts.extend(
            part["payload"]["shifts"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        boxes.extend(part["payload"]["boxes"].as_array().unwrap().iter().cloned());
        pallets.extend(
            part["payload"]["pallets"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        owners.extend(
            part["payload"]["owners"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
    }
    for shift in &shifts {
        let card = get(
            &a,
            &format!("/v1/office/cloud-shifts/{}", shift["id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(
            card["shift"], *shift,
            "raw shift instants, including null open, are unchanged"
        );
    }
    for pack in &boxes {
        assert!(!pack["palletId"].is_null());
        let card = get(
            &a,
            &format!("/v1/office/cloud-boxes/{}", pack["id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(
            card["pack"], *pack,
            "original association and cross-clock instants survive"
        );
        if !pack["disassembledAt"].is_null() {
            assert_eq!(card["units"], 0);
            let (status, body) = a
                .call(
                    "GET",
                    &format!(
                        "/v1/office/cloud-boxes/{}/report-data",
                        pack["id"].as_str().unwrap()
                    ),
                    None,
                )
                .await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(
                body["error"]["details"]["constraint"],
                "history_composition_unavailable"
            );
        }
    }
    for pack in &pallets {
        let card = get(
            &a,
            &format!("/v1/office/cloud-pallets/{}", pack["id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(card["pallet"], *pack);
    }
    let shift = id(10);
    let mut dto = json!({
        "before":get(&a, &format!("/v1/office/cloud-shifts/{shift}/export-source")).await,
        "retiredPallet":get(&a, &format!("/v1/office/cloud-pallets/{}",id(21))).await,
        "livePallet":get(&a, &format!("/v1/office/cloud-pallets/{}",id(20))).await,
        "boxReport":get(&a, &format!("/v1/office/cloud-boxes/{}/report-data",id(41))).await,
    });
    assert_eq!(dto["before"]["shift"]["closedAt"], shifts[0]["closedAt"]);
    assert_eq!(dto["before"]["items"].as_array().unwrap().len(), 2);
    for part in &parts {
        for code in part["payload"]["codes"].as_array().unwrap() {
            let row = dto["before"]["codes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["codeHash"] == code["hash"])
                .unwrap();
            assert_eq!(row["canonical"], code["canonical"]);
            assert_eq!(row["scannedAt"], code["scannedAt"]);
        }
    }
    for owner in &owners {
        let mut conn = a.app.state.pool.acquire().await.unwrap();
        let current = markiro_host::cloud_history::completed_owner(
            &mut conn,
            owner["hash"].as_str().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(current.box_id.as_deref(), owner["boxId"].as_str());
    }
    std::fs::write(
        directory.join("dto.json"),
        serde_json::to_vec_pretty(&dto).unwrap(),
    )
    .unwrap();
    render(&root, &directory, "renderer-before");
    let bytes = std::fs::read(directory.join("generated.xml")).unwrap();
    let file = "70000000-0000-4000-8000-000000000091";
    let batch = "70000000-0000-4000-8000-000000000092";
    let (status, body) = a.call("POST", "/v1/office/export-files", Some(json!({"id":file,"batchId":batch,"partNo":1,"kind":"shift_export","targetType":"shift","targetId":shift,"formatId":"shift_xml_gismt_aggregation","formatVersion":1,"fileName":"history.xml","sizeBytes":bytes.len(),"sha256":markiro_host::cloud_history::validation::digest(&bytes),"generator":"PostgreSQL seam test","contentBase64":STANDARD.encode(&bytes)}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Retired pallet is refused, while its still-closed box can release its exact owner.
    let retired = pallets.iter().find(|p| p["id"] == id(21)).unwrap();
    let doc =
        support::disaggregation::create(&a, json!({"reasonId":support::disaggregation::REASON}))
            .await;
    let sscc = retired["sscc"].as_str().unwrap();
    let (status, detail) = support::disaggregation::add(
        &a,
        doc["document"]["id"].as_str().unwrap(),
        json!([support::disaggregation::line(sscc, Some(sscc))]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["lines"][0]["status"], "already_disassembled");
    let released = boxes.iter().find(|b| b["id"] == id(41)).unwrap();
    support::disaggregation::applied(&a, &[released["sscc"].as_str().unwrap().to_owned()]).await;
    for owner in &owners {
        let mut conn = a.app.state.pool.acquire().await.unwrap();
        let current = markiro_host::cloud_history::completed_owner(
            &mut conn,
            owner["hash"].as_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(current.is_none(), owner["boxId"] == id(41));
    }
    let card = get(&a, &format!("/v1/office/cloud-boxes/{}", id(41))).await;
    assert_eq!(
        card["pack"]["palletId"],
        id(21),
        "local disassembly keeps source provenance"
    );
    dto["after"] = get(
        &a,
        &format!("/v1/office/cloud-shifts/{shift}/export-source"),
    )
    .await;
    std::fs::write(
        directory.join("dto.json"),
        serde_json::to_vec_pretty(&dto).unwrap(),
    )
    .unwrap();
    render(&root, &directory, "renderer-after");
    for part in parts {
        assert_eq!(
            a.call(
                "POST",
                "/v1/office/import/history",
                Some(json!({"manifest":manifest,"part":part,"dryRun":false}))
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        get(
            &a,
            &format!("/v1/office/cloud-shifts/{shift}/export-source")
        )
        .await,
        dto["after"]
    );
    let (status, body) = a
        .call(
            "POST",
            &format!("/v1/office/export-files/{file}/download"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let chunk = get(&a, &format!("/v1/office/export-files/{file}/chunks/0")).await;
    assert_eq!(
        STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
}
