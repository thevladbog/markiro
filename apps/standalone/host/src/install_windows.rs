//! [`Services`] on the Windows service manager (`windows-service`). Compiled
//! only for Windows: the `standalone-windows-build` job builds it, and its
//! installer smoke test (`tools/standalone-release/smoke.ps1`) drives it.
//!
//! The service manager is spoken to through its API, never through `sc.exe`:
//! its answers are numbers (`winerror.h`, see the constants in `install.rs`),
//! not text that a Russian Windows would translate.

use std::ffi::OsString;

use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl, ServiceFailureActions,
    ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState as WinState,
    ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::install::{
    delete_refusal_is_harmless, service_error_text, start_refusal_is_harmless,
    stop_refusal_is_harmless, InstallError, ServiceSpec, ServiceState, Services,
    ERROR_SERVICE_DOES_NOT_EXIST, SERVICE_NAME,
};

/// The access `configure` and the waits need on the service.
fn access() -> ServiceAccess {
    ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE
}

/// The local service manager, opened for creating services (administrators only).
pub struct WindowsServices {
    manager: ServiceManager,
}

impl WindowsServices {
    pub fn connect() -> Result<Self, InstallError> {
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .map_err(service_error)?;
        Ok(Self { manager })
    }

    fn open(&self) -> Result<Option<windows_service::service::Service>, InstallError> {
        match self.manager.open_service(SERVICE_NAME, access()) {
            Ok(service) => Ok(Some(service)),
            Err(error) if os_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => Ok(None),
            Err(error) => Err(service_error(error)),
        }
    }

    fn existing(&self) -> Result<windows_service::service::Service, InstallError> {
        self.open()?
            .ok_or_else(|| InstallError::Service(format!("{SERVICE_NAME} is not installed")))
    }
}

impl Services for WindowsServices {
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError> {
        let Some(service) = self.open()? else {
            return Ok(None);
        };
        let status = service.query_status().map_err(service_error)?;
        Ok(Some(match status.current_state {
            WinState::Stopped => ServiceState::Stopped,
            WinState::StartPending => ServiceState::StartPending,
            WinState::StopPending => ServiceState::StopPending,
            WinState::Running => ServiceState::Running,
            _ => ServiceState::Other,
        }))
    }

    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError> {
        let info = ServiceInfo {
            name: OsString::from(spec.name),
            display_name: OsString::from(spec.display_name),
            service_type: ServiceType::OWN_PROCESS,
            start_type: if spec.automatic {
                ServiceStartType::AutoStart
            } else {
                ServiceStartType::OnDemand
            },
            error_control: ServiceErrorControl::Normal,
            executable_path: spec.executable.clone(),
            launch_arguments: spec.arguments.iter().map(OsString::from).collect(),
            dependencies: Vec::new(),
            account_name: Some(OsString::from(spec.account)),
            account_password: None,
        };
        let service = match self.open()? {
            Some(service) => {
                service.change_config(&info).map_err(service_error)?;
                service
            }
            None => self
                .manager
                .create_service(&info, access())
                .map_err(service_error)?,
        };
        service
            .set_description(spec.description)
            .map_err(service_error)?;
        service
            .update_failure_actions(ServiceFailureActions {
                reset_period: ServiceFailureResetPeriod::After(spec.reset_after),
                reboot_msg: None,
                command: None,
                actions: Some(
                    spec.restart_delays
                        .iter()
                        .map(|delay| ServiceAction {
                            action_type: ServiceActionType::Restart,
                            delay: *delay,
                        })
                        .collect(),
                ),
            })
            .map_err(service_error)?;
        service
            .set_failure_actions_on_non_crash_failures(spec.failure_actions_on_non_crash)
            .map_err(service_error)
    }

    fn start(&mut self) -> Result<(), InstallError> {
        match self.existing()?.start::<&str>(&[]) {
            Ok(()) => Ok(()),
            Err(error) if os_code(&error).is_some_and(start_refusal_is_harmless) => Ok(()),
            Err(error) => Err(service_error(error)),
        }
    }

    /// A service that is not running, or that is starting or stopping, refuses
    /// the stop: that is no error here. `install::stop` reads the state and
    /// asks again until the service is stopping.
    fn stop(&mut self) -> Result<(), InstallError> {
        match self.existing()?.stop() {
            Ok(_) => Ok(()),
            Err(error) if os_code(&error).is_some_and(stop_refusal_is_harmless) => Ok(()),
            Err(error) => Err(service_error(error)),
        }
    }

    fn delete(&mut self) -> Result<(), InstallError> {
        match self.existing()?.delete() {
            Ok(()) => Ok(()),
            Err(error) if os_code(&error).is_some_and(delete_refusal_is_harmless) => Ok(()),
            Err(error) => Err(service_error(error)),
        }
    }
}

fn os_code(error: &windows_service::Error) -> Option<i32> {
    match error {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn service_error(error: windows_service::Error) -> InstallError {
    let code = os_code(&error);
    let text = match &error {
        windows_service::Error::Winapi(io) => format!("{error}: {io}"),
        _ => error.to_string(),
    };
    InstallError::Service(service_error_text(text, code))
}
