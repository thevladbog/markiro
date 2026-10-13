//! The trial's mark outside the database (spec §3.4): on Windows, values in
//! `HKLM\SOFTWARE\Markiro\Standalone\Trial` that a reinstall and even a new
//! data folder do not take away (plan ЛЦ-2 task 12); elsewhere none. The
//! trial's start is the earlier of the database's and the mark's.

/// What the mark holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    /// ms UTC.
    pub started_at: i64,
    pub host_id: String,
    pub inn: Option<String>,
}

/// Where the mark lives. Calls block (an external program on Windows): the
/// service calls them off the async threads.
pub trait TrialMark: Send + Sync + 'static {
    /// The mark's start; `None` when there is none or it does not read.
    fn started_at(&self) -> Option<i64>;
    /// Write the mark's values. The caller writes only when there is none.
    fn write(&self, mark: &Mark) -> Result<(), String>;
}

/// No mark: other systems than Windows, and the tests that do not ask for one.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoMark;

impl TrialMark for NoMark {
    fn started_at(&self) -> Option<i64> {
        None
    }

    fn write(&self, _mark: &Mark) -> Result<(), String> {
        Ok(())
    }
}
