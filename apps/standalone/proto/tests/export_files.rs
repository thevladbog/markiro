use markiro_proto::export_files::{
    ExportFile, ExportFileBegin, ExportFileChunk, ExportFileChunkPut, ExportFileKind,
    ExportFileList, ExportFileOpened, ExportFileProgress, ExportSettings, ExportSettingsUpdate,
    ExportTargetType, EXPORT_FILE_CHUNK_BYTES, EXPORT_FILE_MAX_BYTES, EXPORT_STORE_MAX_BYTES,
    FORM_FORMATS,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        serde_json::to_value(&typed).unwrap(),
        original,
        "{name} changed on round trip"
    );
    typed
}

#[test]
fn the_files_records_and_requests_round_trip() {
    let file: ExportFile = round_trip("export-file.json");
    assert_eq!(file.kind, ExportFileKind::ShiftExport);
    assert_eq!(file.target_type, ExportTargetType::Shift);
    let begin: ExportFileBegin = round_trip("export-file-begin.json");
    assert_eq!(begin.content_base64.as_deref(), Some("aGVsbG8="));
    let _: ExportFileChunkPut = round_trip("export-file-chunk-put.json");
    let progress: ExportFileProgress = round_trip("export-file-progress.json");
    assert!(!progress.ready && progress.received_chunks < progress.chunk_count);
    let list: ExportFileList = round_trip("export-file-list.json");
    assert_eq!(list.items.len(), 2);
    let opened: ExportFileOpened = round_trip("export-file-opened.json");
    assert_eq!(opened.chunk_count, 1);
    let _: ExportFileChunk = round_trip("export-file-chunk.json");
    let settings: ExportSettings = round_trip("export-settings.json");
    assert_eq!(settings.retention_days, None);
    let update: ExportSettingsUpdate = round_trip("export-settings-update.json");
    assert_eq!(update.retention_days, Some(365));
}

#[test]
fn a_request_with_a_field_the_host_does_not_know_is_refused() {
    let mut begin = fixture("export-file-begin.json");
    begin["extra"] = Value::from(1);
    assert!(serde_json::from_value::<ExportFileBegin>(begin).is_err());
    let mut put = fixture("export-file-chunk-put.json");
    put["extra"] = Value::from(1);
    assert!(serde_json::from_value::<ExportFileChunkPut>(put).is_err());
    let mut update = fixture("export-settings-update.json");
    update["extra"] = Value::from(1);
    assert!(serde_json::from_value::<ExportSettingsUpdate>(update).is_err());
}

#[test]
fn the_bounds_are_the_ones_the_office_reads() {
    assert_eq!(EXPORT_FILE_CHUNK_BYTES, 1_048_576);
    assert_eq!(EXPORT_FILE_MAX_BYTES / EXPORT_FILE_CHUNK_BYTES, 256);
    assert_eq!(EXPORT_STORE_MAX_BYTES, 2 * 1024 * 1024 * 1024);
    assert_eq!(FORM_FORMATS.len(), 6);
    assert_eq!(
        ExportFileKind::DisaggregationXml.as_str(),
        "disaggregation_xml"
    );
    assert_eq!(
        ExportTargetType::DisaggregationDocument.as_str(),
        "disaggregation_document"
    );
}
