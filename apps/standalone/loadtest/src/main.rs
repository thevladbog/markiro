//! `markiro-loadtest`: see `markiro_loadtest::cli::USAGE`.

use std::process::ExitCode;

use markiro_loadtest::cli::{self, Command};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let outcome: Result<bool, String> = match command {
        Command::Run(run) => {
            let runtime = tokio::runtime::Runtime::new().expect("a runtime");
            runtime.block_on(cli::run(run))
        }
        Command::Compare { old, new } => cli::compare_files(&old, &new).map(|found| {
            for line in &found {
                println!("regression: {line}");
            }
            if found.is_empty() {
                println!("no regression");
            }
            found.is_empty()
        }),
        Command::Summary { report } => cli::summary_of(&report).map(|text| {
            println!("{text}");
            true
        }),
    };
    if let Err(message) = &outcome {
        eprintln!("{message}");
    }
    ExitCode::from(cli::exit_code(&outcome))
}
