//! Command dispatch.
//!
//! The top-level [`run`] function matches the parsed CLI command and delegates
//! to the appropriate handler in [`device`] or [`store`].

pub mod config;
mod device;
mod doctor;
mod flow;
pub mod recorder;
mod setup;
mod store;
pub mod sync;

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

        Commands::UiWait {
            platform,
            text,
            resource_id,
            class_name,
            timeout,
            interval,
            simulator,
            device,
        } => device::ui_wait(
            &platform,
            text.as_deref(),
            resource_id.as_deref(),
            class_name.as_deref(),
            timeout,
            interval,
            simulator.as_deref(),
            device.as_deref(),
        ),

        Commands::UiAssertVisible {
            platform,
            text,
            resource_id,
            simulator,
            device,
        } => device::ui_assert_visible(
            &platform,
            text.as_deref(),
            resource_id.as_deref(),
            simulator.as_deref(),
            device.as_deref(),
        ),

        Commands::UiAssertGone {
            platform,
            text,
            resource_id,
            simulator,
            device,
        } => device::ui_assert_gone(
            &platform,
            text.as_deref(),
            resource_id.as_deref(),
            simulator.as_deref(),
            device.as_deref(),
        ),

        // -- Sensor commands --------------------------------------------------
        Commands::SensorLocation { latitude, longitude, altitude, device } => {
            device::sensor_location(latitude, longitude, altitude, device.as_deref())
        }

        Commands::SensorBattery { level, status, plugged, reset, device } => {
            device::sensor_battery(
                level,
                status.as_deref(),
                plugged.as_deref(),
                reset,
                device.as_deref(),
            )
        }

        Commands::SensorNotifications { package, device } => {
            device::sensor_notifications(package.as_deref(), device.as_deref())
        }

        Commands::SensorThermal { status, reset, device } => {
            device::sensor_thermal(status.as_deref(), reset, device.as_deref())
        }

        // -- Network commands -------------------------------------------------
        Commands::NetworkTraffic { package, device } => {
            device::network_traffic(package.as_deref(), device.as_deref())
        }

        Commands::NetworkConnectivity { device } => {
            device::network_connectivity(device.as_deref())
        }

        Commands::NetworkProxy { host, port, clear, device } => {
            device::network_proxy(host.as_deref(), port, clear, device.as_deref())
        }

        Commands::NetworkAirplane { state, device } => {
            device::network_airplane(state == "on", device.as_deref())
        }

        // -- Permission commands ----------------------------------------------
        Commands::PermissionGrant { platform, package, permission, simulator, device } => {
            device::permission_grant(
                &platform,
                &package,
                &permission,
                simulator.as_deref(),
                device.as_deref(),
            )
        }

        Commands::PermissionRevoke { platform, package, permission, simulator, device } => {
            device::permission_revoke(
                &platform,
                &package,
                &permission,
                simulator.as_deref(),
                device.as_deref(),
            )
        }

        Commands::PermissionReset { platform, package, simulator, device } => {
            device::permission_reset(
                &platform,
                &package,
                simulator.as_deref(),
                device.as_deref(),
            )
        }

        // -- Intent commands --------------------------------------------------
        Commands::IntentStart {
            action,
            component,
            data,
            category,
            package,
            extras,
            flags,
            device,
        } => device::intent_start(
            action.as_deref(),
            component.as_deref(),
            data.as_deref(),
            category.as_deref(),
            package.as_deref(),
            extras.as_deref(),
            flags.as_deref(),
            device.as_deref(),
        ),

        Commands::IntentBroadcast { action, package, component, extras, device } => {
            device::intent_broadcast(
                &action,
                package.as_deref(),
                component.as_deref(),
                extras.as_deref(),
                device.as_deref(),
            )
        }

        Commands::IntentDeeplink { platform, uri, package, simulator, device } => {
            device::intent_deeplink(
                &platform,
                &uri,
                package.as_deref(),
                simulator.as_deref(),
                device.as_deref(),
            )
        }

        Commands::IntentServices { package, device } => {
            device::intent_services(package.as_deref(), device.as_deref())
        }

        // -- Sandbox commands -------------------------------------------------
        Commands::SandboxPrefsRead { package, file, device } => {
            device::sandbox_prefs_read(&package, file.as_deref(), device.as_deref())
        }

        Commands::SandboxPrefsWrite { package, file, key, value, r#type, device } => {
            device::sandbox_prefs_write(
                &package,
                &file,
                &key,
                &value,
                Some(r#type.as_str()),
                device.as_deref(),
            )
        }

        Commands::SandboxSqliteQuery { package, database, query, device } => {
            device::sandbox_sqlite_query(&package, &database, &query, device.as_deref())
        }

        Commands::SandboxFileList { package, path, device } => {
            device::sandbox_file_list(&package, path.as_deref(), device.as_deref())
        }

        Commands::SandboxFileRead { package, path, max_bytes, device } => {
            device::sandbox_file_read(&package, &path, max_bytes, device.as_deref())
        }

        // -- Setup commands ---------------------------------------------------
        Commands::Setup { command } => setup::run(command),

        // -- Store commands ---------------------------------------------------
        Commands::Store { command } => store::google_play(command),
        Commands::Huawei { command } => store::huawei(command),
        Commands::Rustore { command } => store::rustore(command),

        // -- Flow commands ----------------------------------------------------
        Commands::Flow { command } => {
            // Resolve turbo: CLI flag || global config.
            let global_turbo = config::get_bool("turbo").unwrap_or(false);

            match command {
                crate::cli::FlowCommands::Run {
                    platform,
                    file,
                    turbo,
                    max_duration,
                    stop_on_error,
                    simulator,
                    device,
                    companion_path,
                } => flow::run(
                    &platform,
                    file.as_deref(),
                    turbo || global_turbo,
                    max_duration,
                    stop_on_error,
                    simulator.as_deref(),
                    device.as_deref(),
                    companion_path.as_deref(),
                ),

                crate::cli::FlowCommands::Batch {
                    platform,
                    file,
                    stop_on_error,
                    turbo,
                    simulator,
                    device,
                    companion_path,
                } => flow::batch(
                    &platform,
                    file.as_deref(),
                    stop_on_error,
                    turbo || global_turbo,
                    simulator.as_deref(),
                    device.as_deref(),
                    companion_path.as_deref(),
                ),

                crate::cli::FlowCommands::Parallel {
                    platform,
                    file,
                    devices,
                    turbo,
                    max_duration,
                } => flow::parallel(
                    &platform,
                    file.as_deref(),
                    &devices,
                    turbo || global_turbo,
                    max_duration,
                ),
            }
        }

        // -- Performance commands (Android-only) ------------------------------
        Commands::PerfSnapshot { package, device } => {
            device::perf_snapshot(&package, device.as_deref())
        }

        Commands::PerfBaseline { package, name, device } => {
            device::perf_baseline(&package, &name, device.as_deref())
        }

        Commands::PerfCompare { package, name, device } => {
            device::perf_compare(&package, &name, device.as_deref())
        }

        Commands::PerfMonitor { package, count, interval_ms, device } => {
            device::perf_monitor(&package, count, interval_ms, device.as_deref())
        }

        Commands::PerfCrashes { package, lines, device } => {
            device::perf_crashes(package.as_deref(), lines, device.as_deref())
        }

        Commands::PerfFramestats { package, device } => {
            device::perf_framestats(&package, device.as_deref())
        }

        // -- Doctor -----------------------------------------------------------
        Commands::Doctor => doctor::run(),

        // -- Recorder commands ------------------------------------------------
        Commands::Recorder { command } => recorder::run(command),

        // -- Sync commands ----------------------------------------------------
        Commands::Sync { command } => sync::run(command),

        // -- Scan (camera barcode injection) ----------------------------------
        Commands::Scan {
            text,
            r#type,
            device,
            setup,
            avd,
            video_path,
            tile,
            hold,
        } => crate::scan::run(
            &text,
            &r#type,
            device.as_deref(),
            setup,
            avd.as_deref(),
            video_path.as_deref(),
            tile,
            hold,
        ),

        // -- Config commands --------------------------------------------------
        Commands::Config { command } => {
            match command {
                crate::cli::ConfigCommands::Get { key } => config::get(&key),
                crate::cli::ConfigCommands::Set { key, value } => config::set(&key, &value),
                crate::cli::ConfigCommands::List => config::list(),
                crate::cli::ConfigCommands::Reset { key } => config::reset(&key),
            }
        }
    }
}
