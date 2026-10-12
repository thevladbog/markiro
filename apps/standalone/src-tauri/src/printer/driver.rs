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

use super::raster::{decode, Caps, Raster, MAX_BYTES};
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

/// What a driver call that failed says, for the diagnostic line: the call's
/// name, the Windows error code it left (`0` when the call itself did not fail
/// and `detail` says which check refused), and numbers only.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Step {
    name: &'static str,
    error: u32,
    detail: String,
}

/// What the driver's merged DEVMODE says of the job, in the driver's own units
/// (paper width and length in tenths of a millimetre).
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct DriverMode {
    orientation: i16,
    copies: i16,
    scale: i16,
    paper: i16,
    paper_width: i16,
    paper_length: i16,
    quality: i16,
    y_resolution: i16,
}

/// One diagnostic line for a failed driver call, `job` once the spooler has
/// one. Numbers and call names only: never a label's text, a code, a queue or
/// document name, or a byte of the page.
#[cfg_attr(not(windows), allow(dead_code))]
fn step_line(step: &Step, job: Option<u32>) -> String {
    let mut line = format!(
        "standalone: driver print step={} error={}",
        step.name, step.error
    );
    if let Some(job) = job {
        line.push_str(&format!(" job={job}"));
    }
    if !step.detail.is_empty() {
        line.push(' ');
        line.push_str(&step.detail);
    }
    line
}

/// The page against what the driver reported: the page's dots, resolution and
/// required bounds, the device context's `Caps` (unread when the DEVMODE
/// already refused) and the merged DEVMODE's mode.
#[cfg_attr(not(windows), allow(dead_code))]
fn geometry_line(page: &Raster<'_>, caps: Option<Caps>, mode: &DriverMode) -> String {
    let [l, t, r, b] = page.bounds;
    let reported = match caps {
        Some(c) => format!(
            "caps_dpi={}x{} caps_paper={}x{} caps_offset={},{} caps_printable={}x{}",
            c.dpi_x,
            c.dpi_y,
            c.width,
            c.height,
            c.offset_x,
            c.offset_y,
            c.printable_width,
            c.printable_height
        ),
        None => "caps=unread".to_owned(),
    };
    format!(
        "standalone: driver print step=geometry error=0 page_dots={}x{} page_dpi={} \
         page_bounds={l},{t},{r},{b} {reported} mode_orientation={} mode_copies={} \
         mode_scale={} mode_paper={} mode_paper_size={}x{} mode_quality={} mode_y_resolution={}",
        page.width,
        page.height,
        page.dpi,
        mode.orientation,
        mode.copies,
        mode.scale,
        mode.paper,
        mode.paper_width,
        mode.paper_length,
        mode.quality,
        mode.y_resolution
    )
}

/// The line of a refusal the print answers with.
fn refusal_line(error: &Failure) -> String {
    let job = error
        .receipt
        .as_ref()
        .map(|r| format!(" job={}", r.job_id))
        .unwrap_or_default();
    format!(
        "standalone: driver print refused code={} phase={}{job}",
        error.code, error.phase
    )
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
    print_logged(queue, payload_base64, document_name, &mut |line| {
        eprintln!("{line}")
    })
}

/// [`print`] with the diagnostic lines going to `log`: one per failed driver
/// call, then one for the refusal itself.
fn print_logged(
    queue: String,
    payload_base64: String,
    document_name: String,
    log: &mut dyn FnMut(String),
) -> Outcome {
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
            let mut device = native::Device::open(&queue, &page, &mut *log)?;
            submit(&mut device, &page, &queue, &document_name, &mut *log)
        }
        #[cfg(not(windows))]
        {
            let _ = page;
            Err(Failure::before("unsupported_platform"))
        }
    })();
    match result {
        Ok(receipt) => Outcome::Success { ok: true, receipt },
        Err(error) => {
            log(refusal_line(&error));
            Outcome::Failed { ok: false, error }
        }
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
    fn begin(&mut self, name: &str) -> Result<u32, Step>;
    fn page(&mut self) -> Result<(), Step>;
    fn draw(&mut self, page: &Raster<'_>) -> Result<(), Step>;
    fn end_page(&mut self) -> Result<(), Step>;
    fn end(&mut self) -> Result<(), Step>;
    fn abort(&mut self);
}

/// One document of one page. A failed `StartDocW` is `delivery_unknown` too:
/// its RPC answer can be lost after the spooler took the job. After it, the
/// first failure aborts the document and keeps the receipt. Each failed call
/// leaves one line in `log` (`step_line`), the first one only.
#[cfg_attr(not(windows), allow(dead_code))]
fn submit(
    api: &mut impl WindowsPrintApi,
    page: &Raster<'_>,
    queue: &str,
    name: &str,
    log: &mut dyn FnMut(String),
) -> Result<Receipt, Failure> {
    let job_id = api.begin(name).map_err(|step| {
        log(step_line(&step, None));
        Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: None,
        }
    })?;
    let receipt = Receipt {
        queue: queue.into(),
        job_id,
        document_name: name.into(),
    };
    if let Err(step) = api
        .page()
        .and_then(|_| api.draw(page))
        .and_then(|_| api.end_page())
        .and_then(|_| api.end())
    {
        log(step_line(&step, Some(job_id)));
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

    /// The Windows error the last call left. Read it before anything else runs.
    fn last_error() -> u32 {
        std::io::Error::last_os_error()
            .raw_os_error()
            .map_or(0, |n| n as u32)
    }

    /// The queue's handle, or the Windows error `OpenPrinterW` left.
    fn queue(name: &str) -> Result<Queue, u32> {
        let mut h = PRINTER_HANDLE::default();
        if unsafe { OpenPrinterW(wide(name).as_ptr(), &mut h, null_mut()) } == 0 {
            return Err(last_error());
        }
        Ok(Queue(h))
    }

    /// A refusal before `StartDocW`: one diagnostic line for the call, then the
    /// `before_start` failure with `code`.
    fn refuse(
        log: &mut dyn FnMut(String),
        name: &'static str,
        error: u32,
        detail: String,
        code: &'static str,
    ) -> Failure {
        log(step_line(
            &Step {
                name,
                error,
                detail,
            },
            None,
        ));
        Failure::before(code)
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
        pub fn open(
            name: &str,
            p: &Raster<'_>,
            log: &mut dyn FnMut(String),
        ) -> Result<Self, Failure> {
            unsafe {
                let q = queue(name).map_err(|e| {
                    refuse(log, "OpenPrinterW", e, String::new(), "queue_unavailable")
                })?;
                let name = wide(name);
                let needed =
                    DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), null_mut(), null(), 0);
                if needed < size_of::<DEVMODEW>() as i32 || needed > 1024 * 1024 {
                    let e = last_error();
                    return Err(refuse(
                        log,
                        "DocumentPropertiesW.size",
                        e,
                        format!("returned={needed}"),
                        "driver_failure",
                    ));
                }
                let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
                let dm = buffer.as_mut_ptr().cast::<DEVMODEW>();
                let got =
                    DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), dm, null(), DM_OUT_BUFFER);
                if got != 1 {
                    let e = last_error();
                    return Err(refuse(
                        log,
                        "DocumentPropertiesW.out",
                        e,
                        format!("returned={got}"),
                        "driver_failure",
                    ));
                }
                if ((*dm).dmSize as usize) < size_of::<DEVMODEW>()
                    || (*dm).dmSize as usize + (*dm).dmDriverExtra as usize > needed as usize
                {
                    return Err(refuse(
                        log,
                        "DEVMODE.size",
                        0,
                        format!(
                            "dm_size={} dm_driver_extra={} needed={needed}",
                            (*dm).dmSize,
                            (*dm).dmDriverExtra
                        ),
                        "driver_failure",
                    ));
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
                let merged = DocumentPropertiesW(
                    null_mut(),
                    q.0,
                    name.as_ptr(),
                    out,
                    dm,
                    DM_IN_BUFFER | DM_OUT_BUFFER,
                );
                if merged != 1 {
                    let e = last_error();
                    return Err(refuse(
                        log,
                        "DocumentPropertiesW.merge",
                        e,
                        format!("returned={merged}"),
                        "driver_failure",
                    ));
                }
                let v = (*out).Anonymous1.Anonymous1;
                let mode = DriverMode {
                    orientation: v.dmOrientation,
                    copies: v.dmCopies,
                    scale: v.dmScale,
                    paper: v.dmPaperSize,
                    paper_width: v.dmPaperWidth,
                    paper_length: v.dmPaperLength,
                    quality: v.dmPrintQuality,
                    y_resolution: (*out).dmYResolution,
                };
                if v.dmOrientation != DMORIENT_PORTRAIT as i16
                    || v.dmCopies != 1
                    || v.dmScale != 100
                {
                    log(geometry_line(p, None, &mode));
                    return Err(Failure::before("geometry_mismatch"));
                }
                let dc = CreateDCW(wide("WINSPOOL").as_ptr(), name.as_ptr(), null(), out);
                if dc.is_null() {
                    let e = last_error();
                    return Err(refuse(log, "CreateDCW", e, String::new(), "driver_failure"));
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
                if check_geometry(p, caps).is_err() {
                    log(geometry_line(p, Some(caps), &mode));
                    return Err(Failure::before("geometry_mismatch"));
                }
                Ok(device)
            }
        }
    }

    impl WindowsPrintApi for Device {
        fn begin(&mut self, name: &str) -> Result<u32, Step> {
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
                Err(Step {
                    name: "StartDocW",
                    error: last_error(),
                    detail: format!("returned={id}"),
                })
            }
        }

        fn page(&mut self) -> Result<(), Step> {
            let started = unsafe { StartPage(self.dc) };
            if started > 0 {
                Ok(())
            } else {
                Err(Step {
                    name: "StartPage",
                    error: last_error(),
                    detail: format!("returned={started}"),
                })
            }
        }

        fn draw(&mut self, p: &Raster<'_>) -> Result<(), Step> {
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
                Err(Step {
                    name: "StretchDIBits",
                    error: last_error(),
                    detail: format!("returned={drawn} expected={h} blit={w}x{h}"),
                })
            }
        }

        fn end_page(&mut self) -> Result<(), Step> {
            let ended = unsafe { EndPage(self.dc) };
            if ended > 0 {
                Ok(())
            } else {
                Err(Step {
                    name: "EndPage",
                    error: last_error(),
                    detail: format!("returned={ended}"),
                })
            }
        }

        fn end(&mut self) -> Result<(), Step> {
            let ended = unsafe { EndDoc(self.dc) };
            if ended > 0 {
                Ok(())
            } else {
                Err(Step {
                    name: "EndDoc",
                    error: last_error(),
                    detail: format!("returned={ended}"),
                })
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
        fn call(&mut self, n: &'static str) -> Result<(), Step> {
            self.calls.push(n);
            if self.fail == Some(n) {
                Err(Step {
                    name: n,
                    error: 1801,
                    detail: "returned=0".into(),
                })
            } else {
                Ok(())
            }
        }
    }

    impl WindowsPrintApi for Fake {
        fn begin(&mut self, _: &str) -> Result<u32, Step> {
            self.call("begin").map(|_| 42)
        }
        fn page(&mut self) -> Result<(), Step> {
            self.call("page")
        }
        fn draw(&mut self, _: &Raster<'_>) -> Result<(), Step> {
            self.call("draw")
        }
        fn end_page(&mut self) -> Result<(), Step> {
            self.call("end_page")
        }
        fn end(&mut self) -> Result<(), Step> {
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
        let receipt = submit(&mut f, &page(), "Godex G500", DOCUMENT, &mut |_| {}).unwrap();
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
            let e = submit(&mut f, &page(), "Queue", DOCUMENT, &mut |_| {}).unwrap_err();
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
        let e = submit(&mut f, &page(), "Queue", DOCUMENT, &mut |_| {}).unwrap_err();
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

    /// What `submit` logs for a driver whose `fail` call refuses.
    fn logged(fail: &'static str) -> Vec<String> {
        let mut f = Fake {
            fail: Some(fail),
            ..Default::default()
        };
        let mut lines = Vec::new();
        let _ = submit(&mut f, &page(), "Godex G500", DOCUMENT, &mut |l| {
            lines.push(l)
        });
        lines
    }

    #[test]
    fn a_failed_start_doc_leaves_one_line_without_a_job() {
        assert_eq!(
            logged("begin"),
            ["standalone: driver print step=begin error=1801 returned=0"]
        );
    }

    #[test]
    fn a_failure_after_start_doc_leaves_one_line_with_the_job() {
        for step in ["page", "draw", "end_page", "end"] {
            assert_eq!(
                logged(step),
                [format!(
                    "standalone: driver print step={step} error=1801 job=42 returned=0"
                )],
                "{step}"
            );
        }
    }

    #[test]
    fn a_whole_page_logs_nothing() {
        let mut lines = Vec::new();
        let mut f = Fake::default();
        submit(&mut f, &page(), "Godex G500", DOCUMENT, &mut |l| {
            lines.push(l)
        })
        .unwrap();
        assert!(lines.is_empty(), "{lines:?}");
    }

    #[test]
    fn a_step_line_is_the_call_the_code_and_numbers() {
        let step = Step {
            name: "StretchDIBits",
            error: 0,
            detail: "returned=12 expected=40 blit=80x40".into(),
        };
        assert_eq!(
            step_line(&step, None),
            "standalone: driver print step=StretchDIBits error=0 returned=12 expected=40 blit=80x40"
        );
        assert_eq!(
            step_line(&step, Some(7)),
            "standalone: driver print step=StretchDIBits error=0 job=7 returned=12 expected=40 blit=80x40"
        );
        let bare = Step {
            name: "OpenPrinterW",
            error: 1801,
            detail: String::new(),
        };
        assert_eq!(
            step_line(&bare, None),
            "standalone: driver print step=OpenPrinterW error=1801"
        );
    }

    #[test]
    fn the_geometry_line_sets_the_page_against_what_the_driver_reported() {
        let mut page = page();
        page.bounds = [1, 2, 70, 71];
        let mode = DriverMode {
            orientation: 1,
            copies: 1,
            scale: 100,
            paper: 256,
            paper_width: 100,
            paper_length: 100,
            quality: 203,
            y_resolution: 203,
        };
        let caps = Caps {
            dpi_x: 200,
            dpi_y: 201,
            width: 79,
            height: 78,
            offset_x: 3,
            offset_y: 4,
            printable_width: 70,
            printable_height: 71,
        };
        assert_eq!(
            geometry_line(&page, Some(caps), &mode),
            "standalone: driver print step=geometry error=0 page_dots=80x80 page_dpi=203 \
             page_bounds=1,2,70,71 caps_dpi=200x201 caps_paper=79x78 caps_offset=3,4 \
             caps_printable=70x71 mode_orientation=1 mode_copies=1 mode_scale=100 \
             mode_paper=256 mode_paper_size=100x100 mode_quality=203 mode_y_resolution=203"
        );
        assert!(geometry_line(&page, None, &mode).contains(" caps=unread mode_orientation=1 "));
    }

    #[test]
    fn a_refusal_is_one_line_with_its_code_phase_and_job() {
        assert_eq!(
            refusal_line(&Failure::before("geometry_mismatch")),
            "standalone: driver print refused code=geometry_mismatch phase=before_start"
        );
        let unknown = Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: Some(Receipt {
                queue: "Q".into(),
                job_id: 9,
                document_name: DOCUMENT.into(),
            }),
        };
        assert_eq!(
            refusal_line(&unknown),
            "standalone: driver print refused code=driver_failure phase=delivery_unknown job=9"
        );
    }

    #[test]
    fn a_refused_print_logs_its_refusal_once_and_nothing_of_the_label() {
        let mut lines = Vec::new();
        let outcome = print_logged(
            "Godex G500".into(),
            "AAAA".into(),
            DOCUMENT.into(),
            &mut |l| lines.push(l),
        );
        assert!(matches!(outcome, Outcome::Failed { .. }));
        assert_eq!(
            lines,
            ["standalone: driver print refused code=invalid_artifact phase=before_start"]
        );
        // The queue, the document and the page never reach the log.
        let mut lines = Vec::new();
        print_logged("Godex G500".into(), payload(), DOCUMENT.into(), &mut |l| {
            lines.push(l)
        });
        assert!(!lines.is_empty());
        for line in &lines {
            assert!(line.starts_with("standalone: driver print "), "{line}");
            for secret in ["Godex", "Markiro:", &payload()[..16]] {
                assert!(!line.contains(secret), "{line}");
            }
        }
    }

    #[test]
    fn off_windows_a_checked_page_logs_only_its_refusal() {
        // Off Windows a checked page is refused before any start; the refusal is
        // the only line.
        #[cfg(not(windows))]
        {
            let mut lines = Vec::new();
            print_logged("Godex G500".into(), payload(), DOCUMENT.into(), &mut |l| {
                lines.push(l)
            });
            assert_eq!(
                lines,
                ["standalone: driver print refused code=unsupported_platform phase=before_start"]
            );
        }
    }
}
