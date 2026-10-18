//! An invalid first row must not reserve an output slot for every unvalidated
//! row after it. Measure only `check`, not construction/parsing of the request.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use markiro_host::cloud_import;
use markiro_proto::cloud_import::CloudImportRequest;
use serde_json::{json, Value};

struct MeasuredAllocator;

thread_local! {
    // Const TLS and Cell access allocate nothing, including inside the allocator.
    // Other test threads never participate in the current thread's measurement.
    static LARGEST_ALLOCATION: Cell<Option<usize>> = const { Cell::new(None) };
}

fn record_allocation(bytes: usize) {
    let _ = LARGEST_ALLOCATION.try_with(|largest| {
        if let Some(previous) = largest.get() {
            largest.set(Some(previous.max(bytes)));
        }
    });
}

// SAFETY: Every operation delegates the unchanged pointer/layout to System;
// observation uses only a const thread-local Cell and cannot allocate or panic.
unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        // SAFETY: The caller supplies the layout required by GlobalAlloc::alloc.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        // SAFETY: The caller supplies the layout required by GlobalAlloc::alloc_zeroed.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The allocation came from System with this unchanged layout.
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation(new_size);
        // SAFETY: The caller supplies System's pointer/layout and a valid new size.
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;

struct Measurement;

impl Drop for Measurement {
    fn drop(&mut self) {
        LARGEST_ALLOCATION.with(|largest| largest.set(None));
    }
}

fn fixture_request() -> CloudImportRequest {
    let file: Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-export-file.json")).unwrap();
    serde_json::from_value(json!({
        "importId": "e12a3b40-cdef-4123-8123-123456789012",
        "dryRun": true,
        "formatVersion": file["formatVersion"],
        "exportedAt": file["exportedAt"],
        "rehearsal": file["rehearsal"],
        "source": file["source"],
        "payload": file["payload"],
    }))
    .unwrap()
}

fn assert_invalid_list_does_not_reserve(list: &str, field: &str) {
    let mut request = fixture_request();
    assert!(
        cloud_import::check(&request).is_ok(),
        "the base file is valid"
    );
    // Build all input allocations before measuring the output validation.
    const ROWS: usize = 100_000;
    let payload = &mut request.payload;
    match list {
        "lines" => {
            let mut row = payload.lines[0].clone();
            row.id.clear();
            payload.lines = vec![row; ROWS];
        }
        "counterparties" => {
            let mut row = payload.counterparties[0].clone();
            row.id.clear();
            payload.counterparties = vec![row; ROWS];
        }
        "templates" => {
            let mut row = payload.templates[0].clone();
            row.id.clear();
            payload.templates = vec![row; ROWS];
        }
        "categories" => {
            let mut row = payload.template_defaults.categories[0].clone();
            row.template_id.clear();
            payload.template_defaults.categories = vec![row; ROWS];
        }
        "products" => {
            let mut row = payload.products[0].clone();
            row.id.clear();
            payload.products = vec![row; ROWS];
        }
        "operators" => {
            let mut row = payload.operators[0].clone();
            row.id.clear();
            payload.operators = vec![row; ROWS];
        }
        "badges" => {
            let mut row = payload.badges[0].clone();
            row.id.clear();
            payload.badges = vec![row; ROWS];
        }
        "ssccCounters" => {
            let mut row = payload.sscc_counters[0].clone();
            row.issuer_prefix.clear();
            payload.sscc_counters = vec![row; ROWS];
        }
        "shiftNumberCounters" => {
            let mut row = payload.shift_number_counters[0].clone();
            row.month_key.clear();
            payload.shift_number_counters = vec![row; ROWS];
        }
        _ => panic!("unknown list"),
    }
    let measurement = Measurement;
    LARGEST_ALLOCATION.with(|largest| largest.set(Some(0)));
    let result = cloud_import::check(&request);
    let largest = LARGEST_ALLOCATION.with(|largest| largest.get().unwrap());
    drop(measurement);
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("the first row must fail validation"),
    };
    assert_eq!(error.code(), "validation_failed");
    assert_eq!(error.details().unwrap()["field"], field);
    // A small valid fixture plus the first invalid row requires no large buffer.
    // Reserving for the remaining rows costs multiple MiB for every list above.
    assert!(
        largest < 64 * 1024,
        "{list}: validation allocated {largest} bytes before rejecting its first row"
    );
}

macro_rules! allocation_regression {
    ($test:ident, $list:literal, $field:literal) => {
        #[test]
        fn $test() {
            assert_invalid_list_does_not_reserve($list, $field);
        }
    };
}

allocation_regression!(lines, "lines", "payload.lines.0.id");
allocation_regression!(
    counterparties,
    "counterparties",
    "payload.counterparties.0.id"
);
allocation_regression!(templates, "templates", "payload.templates.0.id");
allocation_regression!(
    categories,
    "categories",
    "payload.templateDefaults.categories.0.templateId"
);
allocation_regression!(products, "products", "payload.products.0.id");
allocation_regression!(operators, "operators", "payload.operators.0.id");
allocation_regression!(badges, "badges", "payload.badges.0.id");
allocation_regression!(
    sscc_counters,
    "ssccCounters",
    "payload.ssccCounters.0.issuerPrefix"
);
allocation_regression!(
    shift_number_counters,
    "shiftNumberCounters",
    "payload.shiftNumberCounters.0.monthKey"
);
