//! Printing through the Windows printer driver (plan ДРВ), ported from the
//! cloud station's `printer_windows.rs` (#696, label pages only). The webview
//! renders the label as a `mono-raster-v1` page at the printer profile's
//! resolution; this module checks the page (`super::raster::decode`), sets
//! the driver's paper to the page's size and resolution at 1:1 scale,
//! refuses a driver whose resolution, paper or printable area does not hold
//! the page (`geometry_mismatch`) and draws it with GDI. A printer language
//! never goes through here: RAW ZPL/TSPL stays in `printer.rs` and
//! `printer/spooler.rs`.
//!
//! A refusal has a code and a phase. `before_start` — nothing reached the
//! spooler, so printing again cannot double a label. `delivery_unknown` —
//! `StartDocW` was called (an RPC answer can be lost after the spooler took
//! the job) or a call after it failed: a label may come out, and only the
//! operator decides; the receipt, when there is one, names the spooler job.
//! The order of the GDI calls and the phase a failure leaves live in
//! [`submit`], generic over [`WindowsPrintApi`], so they run and are tested on
//! every OS. Only `native` (everything unsafe) is `cfg(windows)`: it uses
//! `std` and `windows-sys` only and compiles in `standalone-windows-build`.

use super::raster::{decode, Raster, MAX_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// The spooler job a driver print started: its queue, its job id and the
/// document name the webview chose (`Markiro:<uuid>`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub queue: String,
    pub job_id: u32,
    pub document_name: String,
}

/// A failed driver print: `code` is `unsupported_platform`,
/// `invalid_artifact`, `queue_unavailable`, `geometry_mismatch` or
/// `driver_failure`; `phase` is `before_start` or `delivery_unknown`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}

impl Failure {
    fn before(code: &'static str) -> Self {
        Self {
            code,
            phase: "before_start",
            receipt: None,
        }
    }
}

/// `print_windows_raster`'s answer: `{ ok: true, receipt }` or
/// `{ ok: false, error }` (`src/hardware/hardware.ts`,
/// `windowsPrintOutcomeSchema`; pinned by `tests/fixtures/hardware-shapes.json`).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Success { ok: bool, receipt: Receipt },
    Failed { ok: bool, error: Failure },
}

/// What the spooler says of a receipt's job. Diagnostic only: an absent job
/// never means a printed label.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Observation {
    Present {
        #[serde(rename = "statusFlags")]
        status_flags: u32,
    },
    Absent,
    IdentityMismatch,
    Unavailable,
}

fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0')
}

/// `Markiro:` and a UUID in its 36-character hyphenated form: the webview's
/// own document name, never a name of anybody's choosing.
fn markiro_document(name: &str) -> bool {
    let Some(id) = name.strip_prefix("Markiro:") else {
        return false;
    };
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The page's bytes, bounded before base64 is decoded.
fn artifact(payload: &str) -> Result<Vec<u8>, Failure> {
    if payload.len() > 4 * MAX_BYTES.div_ceil(3) {
        return Err(Failure::before("invalid_artifact"));
    }
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| Failure::before("invalid_artifact"))?;
    decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
    Ok(bytes)
}

/// Prints one page to `queue`, blocking. Every refusal before `StartDocW` is
/// `before_start`; from `StartDocW` on, `delivery_unknown`. Never retries.
pub fn print(queue: String, payload_base64: String, document_name: String) -> Outcome {
    let result = (|| {
        let bytes = artifact(&payload_base64)?;
        let page = decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
        if !valid_name(&queue) {
            return Err(Failure::before("queue_unavailable"));
        }
        if !markiro_document(&document_name) {
            return Err(Failure::before("invalid_artifact"));
        }
        #[cfg(windows)]
        {
            let mut device = native::Device::open(&queue, &page)?;
            submit(&mut device, &page, &queue, &document_name)
        }
        #[cfg(not(windows))]
        {
            let _ = page;
            Err(Failure::before("unsupported_platform"))
        }
    })();
    match result {
        Ok(receipt) => Outcome::Success { ok: true, receipt },
        Err(error) => Outcome::Failed { ok: false, error },
    }
}

/// The spooler's word on a receipt's job; `unavailable` off Windows.
pub fn observe(receipt: Receipt) -> Observation {
    if !valid_name(&receipt.queue) || !valid_name(&receipt.document_name) || receipt.job_id == 0 {
        return Observation::Unavailable;
    }
    #[cfg(windows)]
    {
        native::observe(&receipt)
    }
    #[cfg(not(windows))]
    {
        Observation::Unavailable
    }
}

/// The GDI calls of one page, in the order [`submit`] makes them.
#[cfg_attr(not(windows), allow(dead_code))]
trait WindowsPrintApi {
    fn begin(&mut self, name: &str) -> Result<u32, ()>;
    fn page(&mut self) -> Result<(), ()>;
    fn draw(&mut self, page: &Raster<'_>) -> Result<(), ()>;
    fn end_page(&mut self) -> Result<(), ()>;
    fn end(&mut self) -> Result<(), ()>;
    fn abort(&mut self);
}

/// One document of one page. A failed `StartDocW` is `delivery_unknown` too:
/// its RPC answer can be lost after the spooler took the job. After it, the
/// first failure aborts the document and keeps the receipt.
#[cfg_attr(not(windows), allow(dead_code))]
fn submit(
    api: &mut impl WindowsPrintApi,
    page: &Raster<'_>,
    queue: &str,
    name: &str,
) -> Result<Receipt, Failure> {
    let job_id = api.begin(name).map_err(|_| Failure {
        code: "driver_failure",
        phase: "delivery_unknown",
        receipt: None,
    })?;
    let receipt = Receipt {
        queue: queue.into(),
        job_id,
        document_name: name.into(),
    };
    if api
        .page()
        .and_then(|_| api.draw(page))
        .and_then(|_| api.end_page())
        .and_then(|_| api.end())
        .is_err()
    {
        api.abort();
        return Err(Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: Some(receipt),
        });
    }
    Ok(receipt)
}

#[cfg(windows)]
mod native {
    use super::super::raster::{check_geometry, dib_pixels, Caps};
    use super::*;
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Graphics::{Gdi::*, Printing::*},
        Storage::Xps::*,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    struct Queue(PRINTER_HANDLE);

    impl Drop for Queue {
        fn drop(&mut self) {
            unsafe {
                ClosePrinter(self.0);
            }
        }
    }

    fn queue(name: &str) -> Result<Queue, Failure> {
        let mut h = PRINTER_HANDLE::default();
        if unsafe { OpenPrinterW(wide(name).as_ptr(), &mut h, null_mut()) } == 0 {
            return Err(Failure::before("queue_unavailable"));
        }
        Ok(Queue(h))
    }

    pub(super) struct Device {
        dc: HDC,
        caps: Caps,
    }

    impl Drop for Device {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.dc);
            }
        }
    }

    impl Device {
        /// The queue's device context with the driver set to the page:
        /// user paper of the page's millimetres, portrait, one copy, 100 %,
        /// the page's resolution. The driver-private tail of DEVMODE is kept
        /// (a separate output buffer), and the driver's answer is checked.
        pub fn open(name: &str, p: &Raster<'_>) -> Result<Self, Failure> {
            unsafe {
                let q = queue(name)?;
                let name = wide(name);
                let needed =
                    DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), null_mut(), null(), 0);
                if needed < size_of::<DEVMODEW>() as i32 || needed > 1024 * 1024 {
                    return Err(Failure::before("driver_failure"));
                }
                let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
                let dm = buffer.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), dm, null(), DM_OUT_BUFFER)
                    != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                if ((*dm).dmSize as usize) < size_of::<DEVMODEW>()
                    || (*dm).dmSize as usize + (*dm).dmDriverExtra as usize > needed as usize
                {
                    return Err(Failure::before("driver_failure"));
                }
                (*dm).dmFields = ((*dm).dmFields & !DM_FORMNAME)
                    | DM_ORIENTATION
                    | DM_PAPERSIZE
                    | DM_PAPERWIDTH
                    | DM_PAPERLENGTH
                    | DM_COPIES
                    | DM_PRINTQUALITY
                    | DM_YRESOLUTION
                    | DM_SCALE;
                let v = &mut (*dm).Anonymous1.Anonymous1;
                v.dmOrientation = DMORIENT_PORTRAIT as i16;
                v.dmPaperSize = DMPAPER_USER as i16;
                v.dmPaperWidth = (p.width_mm * 10.).round() as i16;
                v.dmPaperLength = (p.height_mm * 10.).round() as i16;
                v.dmCopies = 1;
                v.dmScale = 100;
                v.dmPrintQuality = p.dpi as i16;
                (*dm).dmYResolution = p.dpi as i16;
                let mut output = buffer.clone();
                let out = output.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(
                    null_mut(),
                    q.0,
                    name.as_ptr(),
                    out,
                    dm,
                    DM_IN_BUFFER | DM_OUT_BUFFER,
                ) != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                let v = (*out).Anonymous1.Anonymous1;
                if v.dmOrientation != DMORIENT_PORTRAIT as i16
                    || v.dmCopies != 1
                    || v.dmScale != 100
                {
                    return Err(Failure::before("geometry_mismatch"));
                }
                let dc = CreateDCW(wide("WINSPOOL").as_ptr(), name.as_ptr(), null(), out);
                if dc.is_null() {
                    return Err(Failure::before("driver_failure"));
                }
                let cap = |i| GetDeviceCaps(dc, i as i32);
                let caps = Caps {
                    dpi_x: cap(LOGPIXELSX),
                    dpi_y: cap(LOGPIXELSY),
                    width: cap(PHYSICALWIDTH),
                    height: cap(PHYSICALHEIGHT),
                    offset_x: cap(PHYSICALOFFSETX),
                    offset_y: cap(PHYSICALOFFSETY),
                    printable_width: cap(HORZRES),
                    printable_height: cap(VERTRES),
                };
                let device = Self { dc, caps };
                check_geometry(p, caps).map_err(|_| Failure::before("geometry_mismatch"))?;
                Ok(device)
            }
        }
    }

    impl WindowsPrintApi for Device {
        fn begin(&mut self, name: &str) -> Result<u32, ()> {
            let name = wide(name);
            let info = DOCINFOW {
                cbSize: size_of::<DOCINFOW>() as i32,
                lpszDocName: name.as_ptr(),
                lpszOutput: null(),
                lpszDatatype: null(),
                fwType: 0,
            };
            let id = unsafe { StartDocW(self.dc, &info) };
            if id > 0 {
                Ok(id as u32)
            } else {
                Err(())
            }
        }

        fn page(&mut self) -> Result<(), ()> {
            if unsafe { StartPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn draw(&mut self, p: &Raster<'_>) -> Result<(), ()> {
            #[repr(C)]
            struct Info {
                header: BITMAPINFOHEADER,
                colors: [RGBQUAD; 2],
            }
            let info = Info {
                header: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: p.width,
                    biHeight: -p.height,
                    biPlanes: 1,
                    biBitCount: 1,
                    biCompression: BI_RGB,
                    biClrUsed: 2,
                    ..Default::default()
                },
                colors: [
                    RGBQUAD {
                        rgbBlue: 255,
                        rgbGreen: 255,
                        rgbRed: 255,
                        rgbReserved: 0,
                    },
                    RGBQUAD::default(),
                ],
            };
            let data = dib_pixels(p);
            let c = self.caps;
            let w = (p.width - c.offset_x).min(c.printable_width);
            let h = (p.height - c.offset_y).min(c.printable_height);
            let drawn = unsafe {
                StretchDIBits(
                    self.dc,
                    0,
                    0,
                    w,
                    h,
                    c.offset_x,
                    c.offset_y,
                    w,
                    h,
                    data.as_ptr().cast(),
                    (&info as *const Info).cast(),
                    DIB_RGB_COLORS,
                    SRCCOPY,
                )
            };
            if drawn == h {
                Ok(())
            } else {
                Err(())
            }
        }

        fn end_page(&mut self) -> Result<(), ()> {
            if unsafe { EndPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn end(&mut self) -> Result<(), ()> {
            if unsafe { EndDoc(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn abort(&mut self) {
            unsafe {
                AbortDoc(self.dc);
            }
        }
    }

    /// `GetJobW` level 1: absent (`ERROR_INVALID_PARAMETER`, 87, or
    /// `ERROR_NO_MORE_ITEMS`, 259), present with its status flags, or a job id
    /// the spooler has given to another document.
    pub fn observe(r: &Receipt) -> Observation {
        unsafe {
            let Ok(q) = queue(&r.queue) else {
                return Observation::Unavailable;
            };
            let mut needed = 0;
            let first = GetJobW(q.0, r.job_id, 1, null_mut(), 0, &mut needed);
            if first == 0 {
                let code = std::io::Error::last_os_error().raw_os_error();
                if matches!(code, Some(87) | Some(259)) {
                    return Observation::Absent;
                }
                if code != Some(122) {
                    return Observation::Unavailable;
                }
            }
            if needed < size_of::<JOB_INFO_1W>() as u32 || needed > 1024 * 1024 {
                return Observation::Unavailable;
            }
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let length = needed;
            if GetJobW(
                q.0,
                r.job_id,
                1,
                buffer.as_mut_ptr().cast(),
                length,
                &mut needed,
            ) == 0
            {
                return Observation::Unavailable;
            }
            let job = &*buffer.as_ptr().cast::<JOB_INFO_1W>();
            let start = job.pDocument as usize;
            let low = buffer.as_ptr() as usize;
            let high = low + length as usize;
            if start < low || start >= high || !start.is_multiple_of(2) {
                return Observation::Unavailable;
            }
            let chars = std::slice::from_raw_parts(job.pDocument, (high - start) / 2);
            let Some(end) = chars.iter().position(|c| *c == 0) else {
                return Observation::Unavailable;
            };
            if String::from_utf16_lossy(&chars[..end]) != r.document_name {
                return Observation::IdentityMismatch;
            }
            Observation::Present {
                status_flags: job.Status,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";

    #[derive(Default)]
    struct Fake {
        calls: Vec<&'static str>,
        fail: Option<&'static str>,
    }

    impl Fake {
        fn call(&mut self, n: &'static str) -> Result<(), ()> {
            self.calls.push(n);
            if self.fail == Some(n) {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    impl WindowsPrintApi for Fake {
        fn begin(&mut self, _: &str) -> Result<u32, ()> {
            self.call("begin").map(|_| 42)
        }
        fn page(&mut self) -> Result<(), ()> {
            self.call("page")
        }
        fn draw(&mut self, _: &Raster<'_>) -> Result<(), ()> {
            self.call("draw")
        }
        fn end_page(&mut self) -> Result<(), ()> {
            self.call("end_page")
        }
        fn end(&mut self) -> Result<(), ()> {
            self.call("end")
        }
        fn abort(&mut self) {
            self.calls.push("abort");
        }
    }

    fn page() -> Raster<'static> {
        Raster {
            dpi: 203,
            width: 80,
            height: 80,
            width_mm: 10.,
            height_mm: 10.,
            stride: 10,
            bounds: [0; 4],
            pixels: &[],
        }
    }

    #[test]
    fn a_whole_page_answers_its_receipt() {
        let mut f = Fake::default();
        let receipt = submit(&mut f, &page(), "Godex G500", DOCUMENT).unwrap();
        assert_eq!(
            receipt,
            Receipt {
                queue: "Godex G500".into(),
                job_id: 42,
                document_name: DOCUMENT.into(),
            }
        );
        assert_eq!(f.calls, ["begin", "page", "draw", "end_page", "end"]);
    }

    #[test]
    fn a_failure_after_begin_keeps_the_receipt_aborts_and_never_retries() {
        for step in ["page", "draw", "end_page", "end"] {
            let mut f = Fake {
                fail: Some(step),
                ..Default::default()
            };
            let e = submit(&mut f, &page(), "Queue", DOCUMENT).unwrap_err();
            assert_eq!(e.phase, "delivery_unknown", "{step}");
            assert_eq!(e.receipt.unwrap().job_id, 42);
            assert_eq!(f.calls.last(), Some(&"abort"));
            assert_eq!(f.calls.iter().filter(|s| **s == "begin").count(), 1);
        }
    }

    #[test]
    fn a_failed_start_doc_is_unknown_without_a_receipt() {
        let mut f = Fake {
            fail: Some("begin"),
            ..Default::default()
        };
        let e = submit(&mut f, &page(), "Queue", DOCUMENT).unwrap_err();
        assert_eq!((e.code, e.phase), ("driver_failure", "delivery_unknown"));
        assert!(e.receipt.is_none());
        assert_eq!(f.calls, ["begin"]);
    }

    #[test]
    fn the_payload_is_bounded_before_base64_is_decoded() {
        assert!(artifact(&"A".repeat(4 * MAX_BYTES.div_ceil(3) + 1)).is_err());
        assert!(artifact("AAAA").is_err());
        assert!(!valid_name("a\0b"));
        assert!(!valid_name("  "));
    }

    #[test]
    fn only_the_webviews_own_document_name_prints() {
        assert!(markiro_document(DOCUMENT));
        assert!(!markiro_document(
            "Markiro:7d1c2a8e3b4f4c5d9e6f0a1b2c3d4e5f"
        ));
        assert!(!markiro_document(
            "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5g"
        ));
        assert!(!markiro_document(
            "Invoice:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"
        ));
        assert!(!markiro_document(
            "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4eя"
        ));
    }

    #[test]
    fn a_page_that_is_not_mono_raster_never_reaches_a_queue() {
        let refused = print("Godex G500".into(), "AAAA".into(), DOCUMENT.into());
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({
                "ok": false,
                "error": { "code": "invalid_artifact", "phase": "before_start" }
            })
        );
    }

    #[test]
    fn a_receipt_without_a_job_reads_unavailable() {
        let observation = observe(Receipt {
            queue: "Godex G500".into(),
            job_id: 0,
            document_name: DOCUMENT.into(),
        });
        assert_eq!(
            serde_json::to_value(&observation).unwrap(),
            serde_json::json!({ "state": "unavailable" })
        );
    }

    /// The shared `mono-raster-v1` vector as the webview sends it.
    fn payload() -> String {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/domain/test/fixtures/mono-raster-v1.json"
        ))
        .unwrap();
        fixture["base64"].as_str().unwrap().to_owned()
    }

    fn refusal(queue: &str, payload: String, name: &str) -> serde_json::Value {
        serde_json::to_value(print(queue.into(), payload, name.into())).unwrap()
    }

    fn failed(code: &str) -> serde_json::Value {
        serde_json::json!({ "ok": false, "error": { "code": code, "phase": "before_start" } })
    }

    #[test]
    fn the_refusals_come_in_the_order_artifact_queue_document() {
        // The page is checked before the queue, the queue before the name.
        assert_eq!(refusal(" ", "AAAA".into(), "x"), failed("invalid_artifact"));
        assert_eq!(refusal(" ", payload(), "x"), failed("queue_unavailable"));
        assert_eq!(
            refusal("a\0b", payload(), DOCUMENT),
            failed("queue_unavailable")
        );
        assert_eq!(
            refusal(&"q".repeat(1025), payload(), DOCUMENT),
            failed("queue_unavailable")
        );
        assert_eq!(
            refusal("Godex G500", payload(), "Markiro:not-a-uuid"),
            failed("invalid_artifact")
        );
    }

    #[test]
    fn a_name_of_exactly_the_longest_length_is_still_a_name() {
        assert!(valid_name(&"q".repeat(1024)));
        assert!(!valid_name(&"q".repeat(1025)));
        assert!(valid_name("Godex G500"));
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_checked_page_is_unsupported_before_any_start() {
        assert_eq!(
            refusal("Godex G500", payload(), DOCUMENT),
            failed("unsupported_platform")
        );
    }

    #[test]
    fn the_document_name_is_exactly_a_hyphenated_uuid() {
        // One character too many and one too few.
        assert!(!markiro_document(&format!("{DOCUMENT}0")));
        assert!(!markiro_document(&DOCUMENT[..DOCUMENT.len() - 1]));
        assert!(!markiro_document("Markiro:"));
        assert!(!markiro_document("7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"));
        assert!(!markiro_document(""));
        // A hyphen is no hex digit, and a hex digit is no hyphen.
        assert!(!markiro_document(
            "Markiro:-d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"
        ));
        assert!(!markiro_document(
            "Markiro:7d1c2a8e03b4f-4c5d-9e6f-0a1b2c3d4e5f"
        ));
        assert!(markiro_document(
            "Markiro:7D1C2A8E-3B4F-4C5D-9E6F-0A1B2C3D4E5F"
        ));
    }

    #[test]
    fn the_answers_have_the_shapes_the_webview_reads() {
        let receipt = Receipt {
            queue: "Godex G500".into(),
            job_id: 42,
            document_name: DOCUMENT.into(),
        };
        assert_eq!(
            serde_json::to_value(Outcome::Success {
                ok: true,
                receipt: receipt.clone()
            })
            .unwrap(),
            serde_json::json!({
                "ok": true,
                "receipt": { "queue": "Godex G500", "jobId": 42, "documentName": DOCUMENT }
            })
        );
        assert_eq!(
            serde_json::to_value(Outcome::Failed {
                ok: false,
                error: Failure {
                    code: "driver_failure",
                    phase: "delivery_unknown",
                    receipt: Some(receipt.clone()),
                }
            })
            .unwrap(),
            serde_json::json!({
                "ok": false,
                "error": {
                    "code": "driver_failure",
                    "phase": "delivery_unknown",
                    "receipt": { "queue": "Godex G500", "jobId": 42, "documentName": DOCUMENT }
                }
            })
        );
        for (observation, expected) in [
            (
                Observation::Present { status_flags: 8 },
                serde_json::json!({ "state": "present", "statusFlags": 8 }),
            ),
            (
                Observation::Absent,
                serde_json::json!({ "state": "absent" }),
            ),
            (
                Observation::IdentityMismatch,
                serde_json::json!({ "state": "identity_mismatch" }),
            ),
        ] {
            assert_eq!(serde_json::to_value(observation).unwrap(), expected);
        }
        let back: Receipt = serde_json::from_value(serde_json::json!({
            "queue": "Q", "jobId": 7, "documentName": DOCUMENT
        }))
        .unwrap();
        assert_eq!((back.queue.as_str(), back.job_id), ("Q", 7));
    }
}
