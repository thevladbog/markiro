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

define_windows_service!(ffi_service_main, service_main);

pub fn dispatch() -> Result<(), BoxError> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run() {
        tracing::error!(%error, "markiro-host service failed");
    }
}

fn status(state: ServiceState, accept: ServiceControlAccept) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    }
}

fn run() -> Result<(), BoxError> {
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
    ))?;

    let paths = HostPaths::new(HostPaths::default_data_dir());
    paths.ensure()?;
    let _log_guard = crate::logging::init(&paths.logs_dir(), false)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        let host = crate::start(&paths, StartOptions::default()).await?;
        handle.set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ))?;
        let _ = tokio::task::spawn_blocking(move || stop_receiver.recv()).await;
        host.stop().await
    });
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))?;
    result
}
