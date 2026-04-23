//! Command dispatch.
//!
//! The top-level [`run`] function matches the parsed CLI command and delegates
//! to the appropriate handler in [`device`] or [`store`].

mod device;
mod store;

use anyhow::Result;

use crate::cli::Commands;

/// Execute the parsed CLI command.
pub fn run(command: Commands) -> Result<()> {
    match command {
        // -- Device / interaction commands ------------------------------------
        Commands::Screenshot {
            platform,
            output,
            compress,
            max_width,
            max_height: _,
            quality,
            simulator,
            device,
            companion_path,
            monitor_index: _,
        } => device::screenshot(
            &platform,
            output.as_deref(),
            compress,
            max_width,
            quality,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::Annotate {
            platform,
            output,
            simulator,
            device,
        } => device::annotate(&platform, output.as_deref(), simulator.as_deref(), device.as_deref()),

        Commands::Tap {
            platform,
            x,
            y,
            text,
            resource_id: _,
            index: _,
            simulator,
            device,
            companion_path,
            from_size,
        } => device::tap(
            &platform,
            x,
            y,
            text.as_deref(),
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
            from_size.as_deref(),
        ),

        Commands::LongPress {
            platform,
            x,
            y,
            duration,
            text,
            simulator,
            device,
        } => device::long_press(
            &platform,
            x,
            y,
            duration,
            text.as_deref(),
            simulator.as_deref(),
            device.as_deref(),
        ),

        Commands::OpenUrl {
            platform,
            url,
            simulator,
            device,
        } => device::open_url(&platform, &url, simulator.as_deref(), device.as_deref()),

        Commands::Shell {
            platform,
            command,
            simulator,
            device,
        } => device::shell(&platform, &command, simulator.as_deref(), device.as_deref()),

        Commands::Wait { ms } => device::wait(ms),

        Commands::Swipe {
            platform,
            x1,
            y1,
            x2,
            y2,
            duration,
            direction,
            simulator,
            device,
            from_size,
        } => device::swipe(
            &platform,
            x1,
            y1,
            x2,
            y2,
            duration,
            direction.as_deref(),
            simulator.as_deref(),
            device.as_deref(),
            from_size.as_deref(),
        ),

        Commands::Input {
            platform,
            text,
            simulator,
            device,
            companion_path,
        } => device::input(
            &platform,
            &text,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::Key {
            platform,
            key,
            simulator,
            device,
            companion_path,
        } => device::key(
            &platform,
            &key,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::UiDump {
            platform,
            format,
            show_all: _,
            simulator,
            device,
            companion_path,
        } => device::ui_dump(
            &platform,
            &format,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::Devices { platform } => device::devices(&platform),

        Commands::Apps {
            platform,
            filter,
            simulator,
            device,
        } => device::apps(&platform, filter.as_deref(), simulator.as_deref(), device.as_deref()),

        Commands::Launch {
            platform,
            package,
            simulator,
            device,
            companion_path,
        } => device::launch(
            &platform,
            &package,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::Stop {
            platform,
            package,
            simulator,
            device,
            companion_path,
        } => device::stop(
            &platform,
            &package,
            simulator.as_deref(),
            device.as_deref(),
            companion_path.as_deref(),
        ),

        Commands::Install {
            platform,
            path,
            simulator,
            device,
        } => device::install(&platform, &path, simulator.as_deref(), device.as_deref()),

        Commands::Uninstall {
            platform,
            package,
            simulator,
            device,
        } => device::uninstall(&platform, &package, simulator.as_deref(), device.as_deref()),

        Commands::Find {
            platform,
            query,
            simulator,
            device,
        } => device::find(&platform, &query, simulator.as_deref(), device.as_deref()),

        Commands::TapText {
            platform,
            query,
            simulator,
            device,
        } => device::tap_text(&platform, &query, simulator.as_deref(), device.as_deref()),

        Commands::Logs {
            platform,
            filter,
            lines,
            level: _,
            tag: _,
            package: _,
            simulator,
            device,
        } => device::logs(&platform, filter.as_deref(), lines, simulator.as_deref(), device.as_deref()),

        Commands::ClearLogs {
            platform,
            simulator,
            device,
        } => device::clear_logs(&platform, simulator.as_deref(), device.as_deref()),

        Commands::SystemInfo {
            platform,
            simulator,
            device,
        } => device::system_info(&platform, simulator.as_deref(), device.as_deref()),

        Commands::CurrentActivity {
            platform,
            simulator,
            device,
        } => device::current_activity(&platform, simulator.as_deref(), device.as_deref()),

        Commands::Reboot {
            platform,
            simulator,
            device,
        } => device::reboot(&platform, simulator.as_deref(), device.as_deref()),

        Commands::Screen { state, device } => device::screen(&state, device.as_deref()),

        Commands::ScreenSize {
            platform,
            simulator,
            device,
        } => device::screen_size(&platform, simulator.as_deref(), device.as_deref()),

        Commands::AnalyzeScreen { device } => device::analyze_screen(device.as_deref()),

        Commands::FindAndTap {
            description,
            min_confidence,
            device,
        } => device::find_and_tap(&description, min_confidence, device.as_deref()),

        Commands::PushFile {
            platform,
            local,
            remote,
            device,
        } => device::push_file(&platform, &local, &remote, device.as_deref()),

        Commands::PullFile {
            platform,
            remote,
            local,
            device,
        } => device::pull_file(&platform, &remote, &local, device.as_deref()),

        Commands::GetClipboard {
            platform,
            simulator: _,
            device,
            companion_path,
        } => device::get_clipboard(&platform, device.as_deref(), companion_path.as_deref()),

        Commands::SetClipboard {
            platform,
            text,
            simulator: _,
            device,
            companion_path,
        } => device::set_clipboard(&platform, &text, device.as_deref(), companion_path.as_deref()),

        Commands::GetPerformanceMetrics { companion_path } => {
            device::get_performance_metrics(companion_path.as_deref())
        }

        Commands::GetMonitors { companion_path } => {
            device::get_monitors(companion_path.as_deref())
        }

        Commands::LaunchDesktopApp { app_path, companion_path } => {
            device::launch_desktop_app(&app_path, companion_path.as_deref())
        }

        Commands::StopDesktopApp { app_name, companion_path } => {
            device::stop_desktop_app(&app_name, companion_path.as_deref())
        }

        Commands::GetWindowInfo { companion_path } => {
            device::get_window_info(companion_path.as_deref())
        }

        Commands::FocusWindow { window_id, companion_path } => {
            device::focus_window(&window_id, companion_path.as_deref())
        }

        Commands::ResizeWindow { window_id, width, height, companion_path } => {
            device::resize_window(&window_id, width, height, companion_path.as_deref())
        }

        // -- Store commands ---------------------------------------------------
        Commands::Store { command } => store::google_play(command),
        Commands::Huawei { command } => store::huawei(command),
        Commands::Rustore { command } => store::rustore(command),
    }
}
