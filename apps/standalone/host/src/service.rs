//! Windows service entry point. The installer registers `MarkiroHost` in
//! stage 5; this module only answers the service manager.

use std::ffi::OsString;
use std::sync::mpsc;
use std::time::Duration;

use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::config::HostPaths;
use crate::{BoxError, StartOptions};

pub const SERVICE_NAME: &str = "MarkiroHost";

/// Recovery actions configured on the service (installer, stage 5) must see a
/// failure, not a clean stop. The installer must also enable failure actions
/// for non-crash exits (`sc failureflag MarkiroHost 1`), or Windows ignores
/// this exit code.
const FAILURE_EXIT_CODE: u32 = 1;

define_windows_service!(ffi_service_main, service_main);

pub fn dispatch() -> Result<(), BoxError> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

fn service_main(_arguments: Vec<OsString>) {
    let paths = HostPaths::new(HostPaths::default_data_dir());
    // Held until after any error from `run` has been logged, so a failure
    // that happens before the host starts is not lost.
    let log_guard = paths
        .ensure()
        .ok()
        .and_then(|()| crate::logging::init(&paths.logs_dir(), false).ok());
    if let Err(error) = run(&paths) {
        tracing::error!(%error, "markiro-host service failed");
    }
    drop(log_guard);
}

fn status(
    state: ServiceState,
    accept: ServiceControlAccept,
    exit_code: ServiceExitCode,
    wait_hint: Duration,
) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code,
        checkpoint: 0,
        wait_hint,
        process_id: None,
    }
}

fn run(paths: &HostPaths) -> Result<(), BoxError> {
    let (stop_sender, stop_receiver) = mpsc::channel::<()>();
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_sender.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    handle.set_service_status(status(
        ServiceState::StartPending,
        ServiceControlAccept::empty(),
        ServiceExitCode::Win32(0),
        Duration::from_secs(30),
    ))?;

    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        let host = crate::start(paths, StartOptions::default()).await?;
        handle.set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            ServiceExitCode::Win32(0),
            Duration::default(),
        ))?;
        let _ = tokio::task::spawn_blocking(move || stop_receiver.recv()).await;
        handle.set_service_status(status(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::Win32(0),
            Duration::from_secs(30),
        ))?;
        host.stop().await
    });

    let exit_code = if result.is_ok() {
        ServiceExitCode::Win32(0)
    } else {
        ServiceExitCode::ServiceSpecific(FAILURE_EXIT_CODE)
    };
    handle.set_service_status(status(
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
        exit_code,
        Duration::default(),
    ))?;
    result
}
