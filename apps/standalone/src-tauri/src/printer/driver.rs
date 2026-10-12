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
//!
//! An A4 sheet (plan А4, `paper: "a4"`) takes the same path with another page
//! request: the driver's paper is `DMPAPER_A4` in the sheet's orientation, one
//! copy, 100 %, simplex; the sheet is drawn whole-number times larger
//! (`super::sheet`) and refused before `StartDocW` when the device's page or
//! printable area does not hold it. The label path is unchanged.

use super::raster::{check_geometry, decode, Caps, Raster, MAX_BYTES};
use super::sheet::{self, sheet_draw_plan, sheet_orientation, DrawPlan, Orientation, SheetRaster};
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
    /// `dmDuplex`, only when the merged DEVMODE says it is set (`DM_DUPLEX`).
    duplex: Option<i16>,
}

/// The paper a print asks for (`print_windows_raster`'s `paper`): the label's
/// own size by default, or an A4 sheet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Paper {
    Label,
    A4,
}

/// What the print asks of the driver's page, once the page is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Request {
    /// User paper of the page's millimetres, portrait.
    Label,
    /// `DMPAPER_A4` in this orientation.
    Sheet(Orientation),
}

impl Request {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn name(self) -> &'static str {
        match self {
            Request::Label => "label",
            Request::Sheet(Orientation::Portrait) => "a4_portrait",
            Request::Sheet(Orientation::Landscape) => "a4_landscape",
        }
    }
}

/// `paper`: absent is the label, `"a4"` a sheet; any other word is refused
/// before the page is even read (and is not echoed into the log).
fn paper_of(value: Option<&str>) -> Result<Paper, Step> {
    match value {
        None => Ok(Paper::Label),
        Some("a4") => Ok(Paper::A4),
        Some(_) => Err(Step {
            name: "paper",
            error: 0,
            detail: "reason=unknown_paper".into(),
        }),
    }
}

/// The request a checked page makes for `paper`: a sheet must be a 300 dpi
/// A4 page, in either orientation.
fn request_of(paper: Paper, page: &Raster<'_>) -> Result<Request, Step> {
    match paper {
        Paper::Label => Ok(Request::Label),
        Paper::A4 => sheet_orientation(&SheetRaster::from(page))
            .map(Request::Sheet)
            .map_err(|_| Step {
                name: "paper",
                error: 0,
                detail: format!(
                    "reason=not_a4 page_dpi={} page_dots={}x{} page_mm={}x{}",
                    page.dpi, page.width, page.height, page.width_mm, page.height_mm
                ),
            }),
    }
}

/// Whether the driver's merged DEVMODE kept what was asked: the orientation,
/// one copy, 100 %, and for a sheet A4 paper and, if the driver has the
/// setting at all, simplex.
#[cfg_attr(not(windows), allow(dead_code))]
fn mode_holds(request: Request, mode: &DriverMode) -> bool {
    let orientation = match request {
        Request::Label => sheet::DMORIENT_PORTRAIT,
        Request::Sheet(o) => o.devmode(),
    };
    mode.orientation == orientation
        && mode.copies == 1
        && mode.scale == 100
        && match request {
            Request::Label => true,
            Request::Sheet(_) => {
                mode.paper == sheet::DMPAPER_A4
                    && mode.duplex.is_none_or(|d| d == sheet::DMDUP_SIMPLEX)
            }
        }
}

/// The page against the device context's `Caps`: the label's 1:1 check, or the
/// sheet's whole-number draw plan. The refusal is the failure code.
#[cfg_attr(not(windows), allow(dead_code))]
fn plan_of(
    request: Request,
    page: &Raster<'_>,
    caps: Caps,
) -> Result<Option<DrawPlan>, &'static str> {
    match request {
        Request::Label => check_geometry(page, caps)
            .map(|()| None)
            .map_err(|()| "geometry_mismatch"),
        Request::Sheet(_) => sheet_draw_plan(&SheetRaster::from(page), caps.into())
            .map(Some)
            .map_err(|e| e.code()),
    }
}

/// A DEVMODE the driver filled claims a size of at least `minimum` bytes and
/// keeps its private tail inside the `needed` bytes `DocumentPropertiesW`
/// asked the buffer to have.
#[cfg_attr(not(windows), allow(dead_code))]
fn devmode_fits(size: usize, driver_extra: usize, needed: usize, minimum: usize) -> bool {
    size >= minimum && size + driver_extra <= needed
}

/// `StretchDIBits` of a sheet copies scan lines: more than none is a blit.
#[cfg_attr(not(windows), allow(dead_code))]
fn sheet_blit_ok(drawn: i32) -> bool {
    drawn > 0
}

/// The numbers of a sheet blit for the diagnostic line.
#[cfg_attr(not(windows), allow(dead_code))]
fn sheet_blit_detail(drawn: i32, plan: &DrawPlan) -> String {
    format!(
        "returned={drawn} expected>0 scale={} at={},{} blit={}x{}",
        plan.scale, plan.x, plan.y, plan.width, plan.height
    )
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
/// already refused), the merged DEVMODE's mode and what was requested.
#[cfg_attr(not(windows), allow(dead_code))]
fn geometry_line(
    page: &Raster<'_>,
    request: Request,
    caps: Option<Caps>,
    mode: &DriverMode,
) -> String {
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
    let duplex = mode
        .duplex
        .map_or_else(|| "none".to_owned(), |d| d.to_string());
    format!(
        "standalone: driver print step=geometry error=0 request={} page_dots={}x{} page_dpi={} \
         page_bounds={l},{t},{r},{b} {reported} mode_orientation={} mode_copies={} \
         mode_scale={} mode_paper={} mode_paper_size={}x{} mode_quality={} mode_y_resolution={} \
         mode_duplex={duplex}",
        request.name(),
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
/// `paper` is absent for a label and `"a4"` for an A4 sheet.
pub fn print(
    queue: String,
    payload_base64: String,
    document_name: String,
    paper: Option<String>,
) -> Outcome {
    print_logged(queue, payload_base64, document_name, paper, &mut |line| {
        eprintln!("{line}")
    })
}

/// [`print`] with the diagnostic lines going to `log`: one per failed driver
/// call, then one for the refusal itself.
fn print_logged(
    queue: String,
    payload_base64: String,
    document_name: String,
    paper: Option<String>,
    log: &mut dyn FnMut(String),
) -> Outcome {
    let result = (|| {
        // A paper or a sheet that is no A4 page is an unusable artifact; the
        // line says why, with numbers only.
        let refuse_paper = |step: Step, log: &mut dyn FnMut(String)| {
            log(step_line(&step, None));
            Failure::before("invalid_artifact")
        };
        let paper = paper_of(paper.as_deref()).map_err(|step| refuse_paper(step, &mut *log))?;
        let bytes = artifact(&payload_base64)?;
        let page = decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
        let request = request_of(paper, &page).map_err(|step| refuse_paper(step, &mut *log))?;
        if !valid_name(&queue) {
            return Err(Failure::before("queue_unavailable"));
        }
        if !markiro_document(&document_name) {
            return Err(Failure::before("invalid_artifact"));
        }
        #[cfg(windows)]
        {
            let mut device = native::Device::open(&queue, &page, request, &mut *log)?;
            submit(&mut device, &page, &queue, &document_name, &mut *log)
        }
        #[cfg(not(windows))]
        {
            let _ = (page, request);
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
    use super::super::raster::{dib_pixels, Caps};
    use super::*;
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Graphics::{Gdi::*, Printing::*},
        Storage::Xps::*,
    };

    // The host-side values of `super::super::sheet` are the ones Windows has.
    const _: () = {
        assert!(sheet::DMPAPER_A4 == DMPAPER_A4 as i16);
        assert!(sheet::DMORIENT_PORTRAIT == DMORIENT_PORTRAIT as i16);
        assert!(sheet::DMORIENT_LANDSCAPE == DMORIENT_LANDSCAPE as i16);
        assert!(sheet::DMDUP_SIMPLEX == DMDUP_SIMPLEX);
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
        /// How a sheet is drawn; `None` for a label.
        plan: Option<DrawPlan>,
    }

    impl Drop for Device {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.dc);
            }
        }
    }

    impl Device {
        /// The queue's device context with the driver set to the page: for a
        /// label user paper of the page's millimetres, portrait, one copy,
        /// 100 %, the page's resolution; for a sheet `DMPAPER_A4` in the
        /// sheet's orientation, one copy, 100 %, simplex. The driver-private
        /// tail of DEVMODE is kept (a separate output buffer), and the
        /// driver's answer is checked.
        pub fn open(
            name: &str,
            p: &Raster<'_>,
            request: Request,
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
                if !devmode_fits(
                    (*dm).dmSize as usize,
                    (*dm).dmDriverExtra as usize,
                    needed as usize,
                    size_of::<DEVMODEW>(),
                ) {
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
                match request {
                    Request::Label => {
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
                    }
                    Request::Sheet(orientation) => {
                        // A named paper, not a size of the page's own: the
                        // label's width, length and form name are dropped, and
                        // the resolution stays the driver's (the plan scales
                        // the sheet to it).
                        (*dm).dmFields = ((*dm).dmFields
                            & !(DM_FORMNAME | DM_PAPERWIDTH | DM_PAPERLENGTH))
                            | DM_ORIENTATION
                            | DM_PAPERSIZE
                            | DM_COPIES
                            | DM_SCALE
                            | DM_DUPLEX;
                        let v = &mut (*dm).Anonymous1.Anonymous1;
                        v.dmOrientation = orientation.devmode();
                        v.dmPaperSize = DMPAPER_A4 as i16;
                        v.dmCopies = 1;
                        v.dmScale = 100;
                        (*dm).dmDuplex = DMDUP_SIMPLEX;
                    }
                }
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
                if matches!(request, Request::Sheet(_))
                    && !devmode_fits(
                        (*out).dmSize as usize,
                        (*out).dmDriverExtra as usize,
                        needed as usize,
                        size_of::<DEVMODEW>(),
                    )
                {
                    return Err(refuse(
                        log,
                        "DEVMODE.size.merged",
                        0,
                        format!(
                            "dm_size={} dm_driver_extra={} needed={needed}",
                            (*out).dmSize,
                            (*out).dmDriverExtra
                        ),
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
                    duplex: ((*out).dmFields & DM_DUPLEX != 0).then_some((*out).dmDuplex),
                };
                if !mode_holds(request, &mode) {
                    log(geometry_line(p, request, None, &mode));
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
                // The device owns the context from here: every refusal below
                // drops it (`DeleteDC`).
                let mut device = Self {
                    dc,
                    caps,
                    plan: None,
                };
                match plan_of(request, p, caps) {
                    Ok(plan) => device.plan = plan,
                    Err(code) => {
                        log(geometry_line(p, request, Some(caps), &mode));
                        return Err(Failure::before(code));
                    }
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
            if let Some(plan) = self.plan {
                // COLORONCOLOR drops or repeats whole dots: no smoothing, no fit.
                if unsafe { SetStretchBltMode(self.dc, COLORONCOLOR) } == 0 {
                    return Err(Step {
                        name: "SetStretchBltMode",
                        error: last_error(),
                        detail: "returned=0".into(),
                    });
                }
                let drawn = unsafe {
                    StretchDIBits(
                        self.dc,
                        plan.x,
                        plan.y,
                        plan.width,
                        plan.height,
                        0,
                        0,
                        p.width,
                        p.height,
                        data.as_ptr().cast(),
                        (&info as *const Info).cast(),
                        DIB_RGB_COLORS,
                        SRCCOPY,
                    )
                };
                return if sheet_blit_ok(drawn) {
                    Ok(())
                } else {
                    Err(Step {
                        name: "StretchDIBits",
                        error: last_error(),
                        detail: sheet_blit_detail(drawn, &plan),
                    })
                };
            }
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
        let refused = print("Godex G500".into(), "AAAA".into(), DOCUMENT.into(), None);
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
        serde_json::to_value(print(queue.into(), payload, name.into(), None)).unwrap()
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
            duplex: None,
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
            geometry_line(&page, Request::Label, Some(caps), &mode),
            "standalone: driver print step=geometry error=0 request=label page_dots=80x80 \
             page_dpi=203 page_bounds=1,2,70,71 caps_dpi=200x201 caps_paper=79x78 \
             caps_offset=3,4 caps_printable=70x71 mode_orientation=1 mode_copies=1 \
             mode_scale=100 mode_paper=256 mode_paper_size=100x100 mode_quality=203 \
             mode_y_resolution=203 mode_duplex=none"
        );
        assert!(geometry_line(&page, Request::Label, None, &mode)
            .contains(" caps=unread mode_orientation=1 "));
        let sheet = DriverMode {
            duplex: Some(2),
            ..mode
        };
        let line = geometry_line(&page, Request::Sheet(Orientation::Landscape), None, &sheet);
        assert!(line.contains(" request=a4_landscape "), "{line}");
        assert!(line.ends_with(" mode_duplex=2"), "{line}");
        assert!(
            geometry_line(&page, Request::Sheet(Orientation::Portrait), None, &mode)
                .contains(" request=a4_portrait ")
        );
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
            None,
            &mut |l| lines.push(l),
        );
        assert!(matches!(outcome, Outcome::Failed { .. }));
        assert_eq!(
            lines,
            ["standalone: driver print refused code=invalid_artifact phase=before_start"]
        );
        // The queue, the document and the page never reach the log.
        let mut lines = Vec::new();
        print_logged(
            "Godex G500".into(),
            payload(),
            DOCUMENT.into(),
            None,
            &mut |l| lines.push(l),
        );
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
            print_logged(
                "Godex G500".into(),
                payload(),
                DOCUMENT.into(),
                None,
                &mut |l| lines.push(l),
            );
            assert_eq!(
                lines,
                ["standalone: driver print refused code=unsupported_platform phase=before_start"]
            );
        }
    }

    // ---- plan А4: the sheet request ----

    use super::super::sheet::{a4_page_bytes, blank_page_bytes};

    fn mode() -> DriverMode {
        DriverMode {
            orientation: 1,
            copies: 1,
            scale: 100,
            paper: 9,
            paper_width: 0,
            paper_length: 0,
            quality: 600,
            y_resolution: 600,
            duplex: None,
        }
    }

    fn base64_of(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    fn a4_payload(orientation: Orientation) -> String {
        base64_of(&a4_page_bytes(orientation, [118, 118, 2000, 2000]))
    }

    /// The lines a print leaves, with the paper it was asked for.
    fn print_paper(
        queue: &str,
        payload: String,
        name: &str,
        paper: Option<&str>,
    ) -> (serde_json::Value, Vec<String>) {
        let mut lines = Vec::new();
        let outcome = print_logged(
            queue.into(),
            payload,
            name.into(),
            paper.map(str::to_owned),
            &mut |l| lines.push(l),
        );
        (serde_json::to_value(outcome).unwrap(), lines)
    }

    #[test]
    fn the_paper_is_absent_for_a_label_or_exactly_a4() {
        assert_eq!(paper_of(None).unwrap(), Paper::Label);
        assert_eq!(paper_of(Some("a4")).unwrap(), Paper::A4);
        for word in ["A4", "a5", "", " a4", "a4 ", "label", "a4\0", "letter"] {
            let step = paper_of(Some(word)).unwrap_err();
            assert_eq!(
                step_line(&step, None),
                "standalone: driver print step=paper error=0 reason=unknown_paper",
                "{word:?}"
            );
        }
    }

    #[test]
    fn a_sheet_page_must_be_a_300_dpi_a4_page_and_names_its_orientation() {
        for (orientation, request) in [
            (Orientation::Portrait, Request::Sheet(Orientation::Portrait)),
            (
                Orientation::Landscape,
                Request::Sheet(Orientation::Landscape),
            ),
        ] {
            let bytes = a4_page_bytes(orientation, [118, 118, 2000, 2000]);
            let page = decode(&bytes).unwrap();
            assert_eq!(request_of(Paper::A4, &page).unwrap(), request);
            // The same page asked as a label stays a label, whatever its size.
            assert_eq!(request_of(Paper::Label, &page).unwrap(), Request::Label);
        }
        // A label page, an A4 page at 203 dpi, an A5 page at 300 dpi.
        let fixture: Vec<u8> = STANDARD.decode(payload()).unwrap();
        let label = decode(&fixture).unwrap();
        let step = request_of(Paper::A4, &label).unwrap_err();
        assert_eq!(
            step_line(&step, None),
            "standalone: driver print step=paper error=0 reason=not_a4 page_dpi=203 \
             page_dots=80x80 page_mm=10x10"
        );
        for bytes in [
            blank_page_bytes(203, (210.0, 297.0), [0; 4]),
            blank_page_bytes(300, (148.0, 210.0), [0; 4]),
        ] {
            let page = decode(&bytes).unwrap();
            assert!(request_of(Paper::A4, &page).is_err());
        }
        // The line names the page's dots and millimetres, width first.
        let a5 = blank_page_bytes(300, (148.0, 210.0), [0; 4]);
        let step = request_of(Paper::A4, &decode(&a5).unwrap()).unwrap_err();
        assert_eq!(
            step_line(&step, None),
            "standalone: driver print step=paper error=0 reason=not_a4 page_dpi=300 \
             page_dots=1748x2480 page_mm=148x210"
        );
    }

    #[test]
    fn the_request_names_are_what_the_geometry_line_prints() {
        assert_eq!(Request::Label.name(), "label");
        assert_eq!(Request::Sheet(Orientation::Portrait).name(), "a4_portrait");
        assert_eq!(
            Request::Sheet(Orientation::Landscape).name(),
            "a4_landscape"
        );
    }

    #[test]
    fn a_label_keeps_what_it_asked_of_the_driver_and_only_that() {
        assert!(mode_holds(Request::Label, &mode()));
        for broken in [
            DriverMode {
                orientation: 2,
                ..mode()
            },
            DriverMode {
                copies: 2,
                ..mode()
            },
            DriverMode {
                copies: 0,
                ..mode()
            },
            DriverMode {
                scale: 99,
                ..mode()
            },
            DriverMode { scale: 0, ..mode() },
        ] {
            assert!(!mode_holds(Request::Label, &broken));
        }
        // Paper and duplex are the sheet's concern, not the label's.
        for free in [
            DriverMode {
                paper: 256,
                ..mode()
            },
            DriverMode {
                duplex: Some(2),
                ..mode()
            },
        ] {
            assert!(mode_holds(Request::Label, &free));
        }
    }

    #[test]
    fn a_sheet_keeps_a4_the_orientation_one_copy_full_scale_and_simplex() {
        let portrait = Request::Sheet(Orientation::Portrait);
        let landscape = Request::Sheet(Orientation::Landscape);
        assert!(mode_holds(portrait, &mode()));
        assert!(mode_holds(
            portrait,
            &DriverMode {
                duplex: Some(1),
                ..mode()
            }
        ));
        assert!(mode_holds(
            landscape,
            &DriverMode {
                orientation: 2,
                ..mode()
            }
        ));
        // The driver turned the page, or kept the other orientation.
        assert!(!mode_holds(landscape, &mode()));
        assert!(!mode_holds(
            portrait,
            &DriverMode {
                orientation: 2,
                ..mode()
            }
        ));
        for broken in [
            DriverMode { paper: 8, ..mode() },
            DriverMode {
                paper: 256,
                ..mode()
            },
            DriverMode { paper: 0, ..mode() },
            DriverMode {
                duplex: Some(2),
                ..mode()
            },
            DriverMode {
                duplex: Some(3),
                ..mode()
            },
            DriverMode {
                copies: 2,
                ..mode()
            },
            DriverMode {
                scale: 50,
                ..mode()
            },
        ] {
            assert!(!mode_holds(portrait, &broken), "{broken:?}");
        }
    }

    fn laser_caps() -> Caps {
        Caps {
            dpi_x: 600,
            dpi_y: 600,
            width: 4960,
            height: 7016,
            offset_x: 100,
            offset_y: 100,
            printable_width: 4760,
            printable_height: 6816,
        }
    }

    #[test]
    fn the_plan_of_a_label_is_the_labels_geometry_check_and_of_a_sheet_the_draw_plan() {
        // A label page of 80 x 80 dots on a device that holds it 1:1.
        let fixture: Vec<u8> = STANDARD.decode(payload()).unwrap();
        let label = decode(&fixture).unwrap();
        let fits = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 0,
            offset_y: 0,
            printable_width: 80,
            printable_height: 80,
        };
        assert_eq!(plan_of(Request::Label, &label, fits), Ok(None));
        let off = Caps { dpi_y: 300, ..fits };
        assert_eq!(
            plan_of(Request::Label, &label, off),
            Err("geometry_mismatch")
        );
        // A sheet.
        let bytes = a4_page_bytes(Orientation::Portrait, [118, 118, 2362, 3390]);
        let sheet = decode(&bytes).unwrap();
        let request = Request::Sheet(Orientation::Portrait);
        assert_eq!(
            plan_of(request, &sheet, laser_caps()),
            Ok(Some(DrawPlan {
                scale: 2,
                x: -100,
                y: -100,
                width: 4960,
                height: 7016,
            }))
        );
        let letter = Caps {
            width: 5100,
            height: 6600,
            ..laser_caps()
        };
        assert_eq!(plan_of(request, &sheet, letter), Err("geometry_mismatch"));
        // A label's geometry check does not accept a sheet's device, and the
        // other way round: an 80 dot device is no A4.
        assert_eq!(plan_of(request, &sheet, fits), Err("geometry_mismatch"));
    }

    #[test]
    fn a_driver_devmode_must_claim_a_size_that_fits_its_buffer() {
        // 220 bytes is the struct, 300 the buffer asked for.
        assert!(devmode_fits(220, 80, 300, 220));
        assert!(devmode_fits(220, 0, 300, 220));
        assert!(!devmode_fits(219, 0, 300, 220));
        assert!(!devmode_fits(220, 81, 300, 220));
        assert!(!devmode_fits(301, 0, 300, 220));
        assert!(devmode_fits(300, 0, 300, 220));
    }

    #[test]
    fn a_sheet_blit_is_a_positive_number_of_scan_lines() {
        assert!(sheet_blit_ok(1));
        assert!(sheet_blit_ok(3508));
        assert!(!sheet_blit_ok(0));
        assert!(!sheet_blit_ok(-1));
        let plan = DrawPlan {
            scale: 2,
            x: -100,
            y: -90,
            width: 4960,
            height: 7016,
        };
        assert_eq!(
            sheet_blit_detail(0, &plan),
            "returned=0 expected>0 scale=2 at=-100,-90 blit=4960x7016"
        );
        let step = Step {
            name: "StretchDIBits",
            error: 87,
            detail: sheet_blit_detail(-1, &plan),
        };
        assert_eq!(
            step_line(&step, Some(5)),
            "standalone: driver print step=StretchDIBits error=87 job=5 returned=-1 \
             expected>0 scale=2 at=-100,-90 blit=4960x7016"
        );
    }

    #[test]
    fn an_a4_page_goes_through_the_same_calls_and_answers_its_receipt() {
        let bytes = a4_page_bytes(Orientation::Portrait, [118, 118, 2362, 3390]);
        let page = decode(&bytes).unwrap();
        assert!(plan_of(Request::Sheet(Orientation::Portrait), &page, laser_caps()).is_ok());
        let mut f = Fake::default();
        let mut lines = Vec::new();
        let receipt = submit(&mut f, &page, "HP LaserJet", DOCUMENT, &mut |l| {
            lines.push(l)
        })
        .unwrap();
        assert_eq!(receipt.job_id, 42);
        assert_eq!(f.calls, ["begin", "page", "draw", "end_page", "end"]);
        assert!(lines.is_empty());
        // A failing blit leaves the one line with the job, aborts, never retries.
        for step in ["draw", "end"] {
            let mut f = Fake {
                fail: Some(step),
                ..Default::default()
            };
            let e = submit(&mut f, &page, "HP LaserJet", DOCUMENT, &mut |_| {}).unwrap_err();
            assert_eq!(e.phase, "delivery_unknown", "{step}");
            assert_eq!(f.calls.last(), Some(&"abort"));
            assert_eq!(f.calls.iter().filter(|s| **s == "begin").count(), 1);
        }
    }

    #[test]
    fn an_unknown_paper_is_refused_before_the_page_with_one_line_and_no_echo() {
        for word in ["a5", "A4", "secret-paper-word"] {
            let (outcome, lines) = print_paper("Godex G500", "AAAA".into(), DOCUMENT, Some(word));
            assert_eq!(outcome, failed("invalid_artifact"), "{word}");
            assert_eq!(
                lines,
                [
                    "standalone: driver print step=paper error=0 reason=unknown_paper",
                    "standalone: driver print refused code=invalid_artifact phase=before_start"
                ],
                "{word}"
            );
        }
        // Even with a good page and an A4 name the wrong word does not print.
        let (outcome, _) = print_paper(
            "Godex G500",
            a4_payload(Orientation::Portrait),
            DOCUMENT,
            Some("a5"),
        );
        assert_eq!(outcome, failed("invalid_artifact"));
    }

    #[test]
    fn a_page_that_is_not_a4_never_reaches_a_queue_as_a_sheet() {
        let (outcome, lines) = print_paper("Godex G500", payload(), DOCUMENT, Some("a4"));
        assert_eq!(outcome, failed("invalid_artifact"));
        assert_eq!(
            lines,
            [
                "standalone: driver print step=paper error=0 reason=not_a4 page_dpi=203 \
                 page_dots=80x80 page_mm=10x10",
                "standalone: driver print refused code=invalid_artifact phase=before_start"
            ]
        );
        // The sheet check comes before the queue's.
        let (outcome, _) = print_paper(" ", payload(), DOCUMENT, Some("a4"));
        assert_eq!(outcome, failed("invalid_artifact"));
        // A bad artifact is still the artifact's refusal, with no paper line.
        let (outcome, lines) = print_paper("Godex G500", "AAAA".into(), DOCUMENT, Some("a4"));
        assert_eq!(outcome, failed("invalid_artifact"));
        assert_eq!(
            lines,
            ["standalone: driver print refused code=invalid_artifact phase=before_start"]
        );
    }

    #[test]
    fn a_good_sheet_then_meets_the_queue_and_the_document_checks_in_their_order() {
        for orientation in [Orientation::Portrait, Orientation::Landscape] {
            let sheet = a4_payload(orientation);
            let (outcome, _) = print_paper(" ", sheet.clone(), DOCUMENT, Some("a4"));
            assert_eq!(outcome, failed("queue_unavailable"));
            let (outcome, _) = print_paper("HP LaserJet", sheet.clone(), "Markiro:x", Some("a4"));
            assert_eq!(outcome, failed("invalid_artifact"));
            // The A4 page asked as a label is a label: the queue check follows.
            let (outcome, _) = print_paper(" ", sheet, DOCUMENT, None);
            assert_eq!(outcome, failed("queue_unavailable"));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_good_sheet_is_unsupported_not_invalid() {
        for orientation in [Orientation::Portrait, Orientation::Landscape] {
            let sheet = a4_payload(orientation);
            let (outcome, lines) = print_paper("HP LaserJet", sheet.clone(), DOCUMENT, Some("a4"));
            assert_eq!(outcome, failed("unsupported_platform"));
            assert_eq!(
                lines,
                ["standalone: driver print refused code=unsupported_platform phase=before_start"]
            );
            let (outcome, _) = print_paper("HP LaserJet", sheet, DOCUMENT, None);
            assert_eq!(outcome, failed("unsupported_platform"));
        }
    }

    #[test]
    fn an_a4_page_at_300_dpi_is_inside_the_pages_limits() {
        // The raster limit is 2 MiB and the sides 10-300 mm: A4 is 1.04 MiB.
        for orientation in [Orientation::Portrait, Orientation::Landscape] {
            let bytes = a4_page_bytes(orientation, [0; 4]);
            assert!(bytes.len() < MAX_BYTES);
            assert!(artifact(&base64_of(&bytes)).is_ok());
        }
    }
}
