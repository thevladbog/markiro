//! The Windows print spooler (stage 2a spec §5.2): RAW printing and the
//! installed queues, ported from the cloud station's `spooler` module
//! (`apps/station/src-tauri/src/printer.rs`).
//!
//! The order of the spooler calls, and the stage a failure leaves the job in
//! (`not_sent` or `outcome_unknown`), live in [`print_raw_via`], which is
//! generic over the seven calls ([`Spooler`]) and so runs, and is tested, on
//! every OS. Only the calls themselves, and everything unsafe, are
//! `cfg(windows)`: they use `std` and `windows-sys` only, so a probe crate can
//! type-check this file for Windows on any computer (plan 2a4, tasks 6 and 7).

/// How far a RAW job got before it failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// No byte reached the spooler: the queue did not open, or the document
    /// did not start, or the label does not fit one `WritePrinter` call.
    NotSent,
    /// The document had started: the label may be in the queue.
    OutcomeUnknown,
}

/// A failed spooler call: how far the job got, and the system's own words
/// for the process log (never for IPC).
#[derive(Debug)]
pub struct SpoolerError {
    pub stage: Stage,
    pub detail: String,
}

fn not_sent(detail: impl Into<String>) -> SpoolerError {
    SpoolerError {
        stage: Stage::NotSent,
        detail: detail.into(),
    }
}

fn unknown(detail: impl Into<String>) -> SpoolerError {
    SpoolerError {
        stage: Stage::OutcomeUnknown,
        detail: detail.into(),
    }
}

/// The spooler calls of one RAW job, in the order [`print_raw_via`] makes
/// them. Each failure is the call's name and the system's words.
pub trait Spooler {
    /// An open queue (`OpenPrinterW`'s handle).
    type Queue;

    fn open(&self, printer: &str) -> Result<Self::Queue, String>;
    fn start_document(&self, queue: &Self::Queue) -> Result<(), String>;
    fn start_page(&self, queue: &Self::Queue) -> Result<(), String>;
    /// The number of bytes the spooler took.
    fn write(&self, queue: &Self::Queue, bytes: &[u8]) -> Result<usize, String>;
    fn end_page(&self, queue: &Self::Queue) -> Result<(), String>;
    fn end_document(&self, queue: &Self::Queue) -> Result<(), String>;
    fn close(&self, queue: Self::Queue);
}

/// `WritePrinter` takes a `u32` length.
fn within_one_write(len: usize) -> Result<(), SpoolerError> {
    if u32::try_from(len).is_ok() {
        Ok(())
    } else {
        Err(not_sent("the label is larger than 4 GiB"))
    }
}

/// Sends raw ZPL/TSPL bytes to the queue `printer` with datatype RAW, so the
/// driver renders nothing and the printer's firmware reads its own language.
///
/// - `not_sent`: the queue did not open, or the document did not start.
/// - `outcome_unknown`: anything from `StartPagePrinter` on, a short write,
///   and a failed `EndPagePrinter` or `EndDocPrinter` (they may leave the job
///   half-spooled). The first failure is the one reported.
///
/// The queue is closed on every path once opened, and the page and the
/// document are ended once started, whatever the write did.
pub fn print_raw_via<S: Spooler>(
    spooler: &S,
    printer: &str,
    bytes: &[u8],
) -> Result<(), SpoolerError> {
    within_one_write(bytes.len())?;
    let queue = spooler.open(printer).map_err(not_sent)?;
    let result = match spooler.start_document(&queue) {
        Err(detail) => Err(not_sent(detail)),
        Ok(()) => {
            let page = print_page(spooler, &queue, bytes);
            match (spooler.end_document(&queue), page) {
                (_, Err(failure)) => Err(failure),
                (Err(detail), Ok(())) => Err(unknown(detail)),
                (Ok(()), Ok(())) => Ok(()),
            }
        }
    };
    spooler.close(queue);
    result
}

fn print_page<S: Spooler>(spooler: &S, queue: &S::Queue, bytes: &[u8]) -> Result<(), SpoolerError> {
    spooler.start_page(queue).map_err(unknown)?;
    let written = match spooler.write(queue, bytes) {
        Err(detail) => Err(unknown(detail)),
        Ok(taken) if taken != bytes.len() => Err(unknown(format!(
            "WritePrinter wrote {taken} of {} bytes",
            bytes.len()
        ))),
        Ok(_) => Ok(()),
    };
    match (written, spooler.end_page(queue)) {
        (Err(failure), _) => Err(failure),
        (Ok(()), Err(detail)) => Err(unknown(detail)),
        (Ok(()), Ok(())) => Ok(()),
    }
}

#[cfg(windows)]
mod native {
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_2W,
    };

    use super::{print_raw_via, Spooler, SpoolerError};

    /// The error of the call that just failed; read before any other call.
    fn last_error(call: &str) -> String {
        format!("{call}: {}", std::io::Error::last_os_error())
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// # Safety
    ///
    /// `ptr` is null or points at a NUL-terminated UTF-16 string.
    unsafe fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }

    /// The real calls.
    struct WindowsSpooler;

    impl Spooler for WindowsSpooler {
        type Queue = PRINTER_HANDLE;

        fn open(&self, printer: &str) -> Result<PRINTER_HANDLE, String> {
            let printer_w = wide(printer);
            let mut handle = PRINTER_HANDLE::default();
            // SAFETY: `printer_w` is NUL-terminated; `handle` receives the queue.
            if unsafe { OpenPrinterW(printer_w.as_ptr(), &mut handle, std::ptr::null_mut()) } == 0 {
                Err(last_error("OpenPrinterW"))
            } else {
                Ok(handle)
            }
        }

        fn start_document(&self, queue: &PRINTER_HANDLE) -> Result<(), String> {
            let doc_name = wide("Markiro label");
            let datatype = wide("RAW");
            let doc = DOC_INFO_1W {
                pDocName: doc_name.as_ptr() as *mut u16,
                pOutputFile: std::ptr::null_mut(),
                pDatatype: datatype.as_ptr() as *mut u16,
            };
            // SAFETY: `queue` is the open queue; `doc` points at live strings.
            if unsafe { StartDocPrinterW(*queue, 1, &doc) } == 0 {
                Err(last_error("StartDocPrinterW"))
            } else {
                Ok(())
            }
        }

        fn start_page(&self, queue: &PRINTER_HANDLE) -> Result<(), String> {
            // SAFETY: `queue` is an open queue with a started document.
            if unsafe { StartPagePrinter(*queue) } == 0 {
                Err(last_error("StartPagePrinter"))
            } else {
                Ok(())
            }
        }

        fn write(&self, queue: &PRINTER_HANDLE, bytes: &[u8]) -> Result<usize, String> {
            let Ok(len) = u32::try_from(bytes.len()) else {
                return Err("WritePrinter: the label is larger than 4 GiB".to_owned());
            };
            let mut written = 0u32;
            // SAFETY: `bytes` holds `len` readable bytes; `written` receives the count.
            if unsafe { WritePrinter(*queue, bytes.as_ptr().cast(), len, &mut written) } == 0 {
                Err(last_error("WritePrinter"))
            } else {
                Ok(written as usize)
            }
        }

        fn end_page(&self, queue: &PRINTER_HANDLE) -> Result<(), String> {
            // SAFETY: `queue` is an open queue with a started page.
            if unsafe { EndPagePrinter(*queue) } == 0 {
                Err(last_error("EndPagePrinter"))
            } else {
                Ok(())
            }
        }

        fn end_document(&self, queue: &PRINTER_HANDLE) -> Result<(), String> {
            // SAFETY: `queue` is an open queue with a started document.
            if unsafe { EndDocPrinter(*queue) } == 0 {
                Err(last_error("EndDocPrinter"))
            } else {
                Ok(())
            }
        }

        fn close(&self, queue: PRINTER_HANDLE) {
            // SAFETY: closes the handle `OpenPrinterW` opened, exactly once.
            unsafe { ClosePrinter(queue) };
        }
    }

    /// RAW printing through the real spooler.
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), SpoolerError> {
        print_raw_via(&WindowsSpooler, printer, bytes)
    }

    /// Installed local queues and the user's printer connections as (queue
    /// name, port name). The first `EnumPrintersW` call measures the buffer;
    /// any failure but "buffer too small" (the spooler service stopped) is an
    /// error, never an empty list, so an operator restarts the service
    /// instead of chasing a USB cable.
    pub fn installed_printers() -> Result<Vec<(String, String)>, String> {
        const ERROR_INSUFFICIENT_BUFFER: i32 = 122;
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed = 0u32;
        let mut returned = 0u32;
        // SAFETY: a null buffer of size 0 asks only for the size needed.
        let sized = unsafe {
            EnumPrintersW(
                flags,
                std::ptr::null(),
                2,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut returned,
            )
        } != 0;
        if !sized
            && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER)
        {
            return Err(last_error("EnumPrintersW"));
        }
        if needed == 0 {
            return Ok(Vec::new());
        }
        // `u64` storage: `PRINTER_INFO_2W` holds pointers and needs 8-byte
        // alignment, which a `Vec<u8>` does not guarantee.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: `buffer` holds at least `needed` bytes.
        let listed = unsafe {
            EnumPrintersW(
                flags,
                std::ptr::null(),
                2,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
                &mut returned,
            )
        } != 0;
        if !listed {
            return Err(last_error("EnumPrintersW"));
        }
        // SAFETY: the spooler wrote `returned` PRINTER_INFO_2W records at the
        // start of `buffer`, whose strings point into `buffer` itself.
        let infos = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_2W>(), returned as usize)
        };
        Ok(infos
            .iter()
            // SAFETY: the record's strings are NUL-terminated or null.
            .map(|info| unsafe { (from_wide(info.pPrinterName), from_wide(info.pPortName)) })
            .collect())
    }
}

#[cfg(windows)]
pub use native::{installed_printers, print_raw};

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// A spooler that records the calls it gets and fails the named ones.
    struct Fake {
        calls: RefCell<Vec<&'static str>>,
        failing: &'static [&'static str],
        /// How many bytes `write` claims to have taken, when not all of them.
        takes: Option<usize>,
    }

    impl Fake {
        fn new(failing: &'static [&'static str]) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                failing,
                takes: None,
            }
        }

        fn step(&self, call: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(call);
            if self.failing.contains(&call) {
                Err(format!("{call}: refused"))
            } else {
                Ok(())
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl Spooler for Fake {
        type Queue = ();

        fn open(&self, _printer: &str) -> Result<(), String> {
            self.step("open")
        }
        fn start_document(&self, _queue: &()) -> Result<(), String> {
            self.step("start_document")
        }
        fn start_page(&self, _queue: &()) -> Result<(), String> {
            self.step("start_page")
        }
        fn write(&self, _queue: &(), bytes: &[u8]) -> Result<usize, String> {
            self.step("write")?;
            Ok(self.takes.unwrap_or(bytes.len()))
        }
        fn end_page(&self, _queue: &()) -> Result<(), String> {
            self.step("end_page")
        }
        fn end_document(&self, _queue: &()) -> Result<(), String> {
            self.step("end_document")
        }
        fn close(&self, _queue: ()) {
            self.calls.borrow_mut().push("close");
        }
    }

    const FULL_JOB: [&str; 7] = [
        "open",
        "start_document",
        "start_page",
        "write",
        "end_page",
        "end_document",
        "close",
    ];

    fn run(fake: &Fake) -> Result<(), SpoolerError> {
        print_raw_via(fake, "Zebra ZD421", b"^XA^FDx^FS^XZ")
    }

    #[test]
    fn a_job_makes_every_call_in_order_and_closes_the_queue() {
        let fake = Fake::new(&[]);
        assert!(run(&fake).is_ok());
        assert_eq!(fake.calls(), FULL_JOB);
    }

    /// The split between "nothing reached the spooler" (a retry is safe) and
    /// "the label may be queued" (a retry may print it twice), one case per
    /// call, with the calls the job still makes after the failure.
    #[test]
    fn each_failing_call_leaves_the_job_in_the_right_stage() {
        let cases: [(&'static [&'static str], Stage, Vec<&str>); 6] = [
            (&["open"], Stage::NotSent, vec!["open"]),
            (
                &["start_document"],
                Stage::NotSent,
                vec!["open", "start_document", "close"],
            ),
            (
                &["start_page"],
                Stage::OutcomeUnknown,
                vec![
                    "open",
                    "start_document",
                    "start_page",
                    "end_document",
                    "close",
                ],
            ),
            (&["write"], Stage::OutcomeUnknown, FULL_JOB.to_vec()),
            (&["end_page"], Stage::OutcomeUnknown, FULL_JOB.to_vec()),
            (&["end_document"], Stage::OutcomeUnknown, FULL_JOB.to_vec()),
        ];
        for (failing, stage, calls) in cases {
            let fake = Fake::new(failing);
            let failure = run(&fake).unwrap_err();
            assert_eq!(failure.stage, stage, "{failing:?}");
            assert_eq!(fake.calls(), calls, "{failing:?}");
            assert!(failure.detail.starts_with(failing[0]), "{}", failure.detail);
        }
    }

    #[test]
    fn a_short_write_is_outcome_unknown_and_names_the_counts_only() {
        let mut fake = Fake::new(&[]);
        fake.takes = Some(4);
        let failure = run(&fake).unwrap_err();
        assert_eq!(failure.stage, Stage::OutcomeUnknown);
        assert_eq!(failure.detail, "WritePrinter wrote 4 of 13 bytes");
        // The page and the document are still ended, the queue still closed.
        assert_eq!(fake.calls(), FULL_JOB);
    }

    /// A write that took nothing is a short write too, not a success.
    #[test]
    fn a_write_that_took_nothing_is_not_a_success() {
        let mut fake = Fake::new(&[]);
        fake.takes = Some(0);
        assert_eq!(run(&fake).unwrap_err().stage, Stage::OutcomeUnknown);
    }

    #[test]
    fn the_first_failure_is_the_one_reported() {
        for (failing, first) in [
            (&["write", "end_page", "end_document"][..], "write"),
            (&["end_page", "end_document"][..], "end_page"),
            (&["start_page", "end_document"][..], "start_page"),
        ] {
            let fake = Fake::new(failing);
            let failure = run(&fake).unwrap_err();
            assert_eq!(failure.stage, Stage::OutcomeUnknown);
            assert!(failure.detail.starts_with(first), "{}", failure.detail);
        }
    }

    #[test]
    fn a_failed_document_start_hides_nothing_behind_the_later_calls() {
        // `start_document` refusing must stay `not_sent` even though `close`
        // follows; and `end_document` is never called for a document that did
        // not start.
        let fake = Fake::new(&["start_document", "end_document"]);
        let failure = run(&fake).unwrap_err();
        assert_eq!(failure.stage, Stage::NotSent);
        assert!(!fake.calls().contains(&"end_document"));
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn a_label_longer_than_one_write_is_not_sent_before_anything_opens() {
        assert!(within_one_write(u32::MAX as usize).is_ok());
        let failure = within_one_write(u32::MAX as usize + 1).unwrap_err();
        assert_eq!(failure.stage, Stage::NotSent);
    }
}
