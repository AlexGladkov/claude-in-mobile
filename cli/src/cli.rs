//! Clap argument definitions for the CLI.
//!
//! All `#[derive(Parser)]` and `#[derive(Subcommand)]` types live here,
//! keeping the public CLI surface in one place.

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "claude-in-mobile")]
#[command(about = "Fast CLI for mobile device automation and store management")]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Take a screenshot and optionally compress it
    Screenshot {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Output file path (default: stdout as base64)
        #[arg(short, long)]
        output: Option<String>,

        /// Compress image (resize + quality reduction for LLM)
        #[arg(short, long, default_value = "false")]
        compress: bool,

        /// Max width for compression (default: 540)
        #[arg(long, default_value = "540")]
        max_width: u32,

        /// Max height for compression (default: 960)
        #[arg(long, default_value = "960")]
        max_height: Option<u32>,

        /// JPEG quality for compression (1-100, default: 55)
        #[arg(long, default_value = "55")]
        quality: u8,

        /// iOS Simulator name (default: booted)
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial (default: first device)
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,

        /// Monitor index for desktop screenshot
        #[arg(long)]
        monitor_index: Option<u32>,
    },

    /// Take annotated screenshot with UI element bounds
    Annotate {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Output file path (default: stdout as base64)
        #[arg(short, long)]
        output: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Tap at coordinates
    Tap {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// X coordinate
        x: i32,

        /// Y coordinate
        y: i32,

        /// Tap by text instead of coordinates (Android/Desktop)
        #[arg(long)]
        text: Option<String>,

        /// Tap by resource-id (Android)
        #[arg(long)]
        resource_id: Option<String>,

        /// Element index from ui-dump (Android)
        #[arg(long)]
        index: Option<usize>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,

        /// Scale coordinates from screenshot size WxH (e.g. 540x960).
        /// Automatically maps compressed-screenshot coords to device resolution.
        #[arg(long)]
        from_size: Option<String>,
    },

    /// Long press at coordinates
    LongPress {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// X coordinate
        x: i32,

        /// Y coordinate
        y: i32,

        /// Duration in milliseconds (default: 1000)
        #[arg(short, long, default_value = "1000")]
        duration: u32,

        /// Long press by text (Android)
        #[arg(long)]
        text: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Open URL in browser
    OpenUrl {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// URL to open
        url: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Execute shell command on device
    Shell {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Command to execute
        command: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Wait for specified duration
    Wait {
        /// Duration in milliseconds
        ms: u64,
    },

    /// Swipe gesture
    Swipe {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Start X
        x1: i32,

        /// Start Y
        y1: i32,

        /// End X
        x2: i32,

        /// End Y
        y2: i32,

        /// Duration in milliseconds (default: 300)
        #[arg(short, long, default_value = "300")]
        duration: u32,

        /// Swipe direction (up/down/left/right) - overrides coordinates
        #[arg(long)]
        direction: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Scale coordinates from screenshot size WxH (e.g. 540x960).
        /// Automatically maps compressed-screenshot coords to device resolution.
        #[arg(long)]
        from_size: Option<String>,
    },

    /// Input text
    Input {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Text to input
        text: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Press a key/button
    Key {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Key name (home, back, enter, etc.)
        key: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Dump UI hierarchy
    UiDump {
        /// Platform: android, ios, or desktop
        #[arg(value_parser = ["android", "ios", "desktop"])]
        platform: String,

        /// Output format: json or xml
        #[arg(short, long, default_value = "json")]
        format: String,

        /// Show all elements including non-interactive (Android)
        #[arg(long, default_value = "false")]
        show_all: bool,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// List connected devices
    Devices {
        /// Platform: android, ios, aurora, or all
        #[arg(value_parser = ["android", "ios", "aurora", "all"], default_value = "all")]
        platform: String,
    },

    /// List installed apps
    Apps {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Filter by package/bundle name
        #[arg(short, long)]
        filter: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Launch an app
    Launch {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Package name (Android/Aurora) or bundle ID (iOS) or app path (Desktop)
        package: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Stop/kill an app
    Stop {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Package name (Android/Aurora) or bundle ID (iOS) or app name (Desktop)
        package: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Uninstall an app
    Uninstall {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Package name (Android/Aurora) or bundle ID (iOS)
        package: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Install an app
    Install {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Path to APK (Android), app bundle (iOS), or RPM (Aurora)
        path: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Find element by text/resource-id and get coordinates
    Find {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Text, resource-id, or content-desc to search for
        query: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Tap element by text/resource-id
    TapText {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Text, resource-id, or content-desc to tap
        query: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get device logs
    Logs {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// Filter by tag/process
        #[arg(short, long)]
        filter: Option<String>,

        /// Number of lines (default: 100)
        #[arg(short, long, default_value = "100")]
        lines: usize,

        /// Log level filter (Android: V/D/I/W/E/F)
        #[arg(long)]
        level: Option<String>,

        /// Filter by tag (Android)
        #[arg(long)]
        tag: Option<String>,

        /// Filter by package name (Android)
        #[arg(long)]
        package: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Clear device logs
    ClearLogs {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get system info (battery, memory)
    SystemInfo {
        /// Platform: android, ios, or aurora
        #[arg(value_parser = ["android", "ios", "aurora"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get current activity/foreground app
    CurrentActivity {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Reboot device/simulator
    Reboot {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Control screen power (Android only)
    Screen {
        /// Turn screen on or off
        #[arg(value_parser = ["on", "off"])]
        state: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get screen resolution
    ScreenSize {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== New commands =====

    /// Analyze screen structure (Android only)
    AnalyzeScreen {
        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Find element by fuzzy description and tap it (Android only)
    FindAndTap {
        /// Description to match
        description: String,

        /// Minimum confidence threshold (0-100, default: 30)
        #[arg(long, default_value = "30")]
        min_confidence: u32,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Push file to device
    PushFile {
        /// Platform: android or aurora
        #[arg(value_parser = ["android", "aurora"])]
        platform: String,

        /// Local file path
        local: String,

        /// Remote file path on device
        remote: String,

        /// Device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Pull file from device
    PullFile {
        /// Platform: android or aurora
        #[arg(value_parser = ["android", "aurora"])]
        platform: String,

        /// Remote file path on device
        remote: String,

        /// Local file path
        local: String,

        /// Device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get clipboard content
    GetClipboard {
        /// Platform: android, ios, or desktop
        #[arg(value_parser = ["android", "ios", "desktop"])]
        platform: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Set clipboard content
    SetClipboard {
        /// Platform: android, ios, or desktop
        #[arg(value_parser = ["android", "ios", "desktop"])]
        platform: String,

        /// Text to set
        text: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Get performance metrics (Desktop only)
    GetPerformanceMetrics {
        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// List monitors (Desktop only)
    GetMonitors {
        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Launch desktop app
    LaunchDesktopApp {
        /// App path
        app_path: String,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Stop desktop app
    StopDesktopApp {
        /// App name
        app_name: String,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Get desktop window info
    GetWindowInfo {
        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Focus a desktop window
    FocusWindow {
        /// Window ID
        window_id: String,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Resize a desktop window
    ResizeWindow {
        /// Window ID
        window_id: String,

        /// Width
        width: u32,

        /// Height
        height: u32,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Configure integrations with AI coding tools
    Setup {
        #[command(subcommand)]
        command: SetupCommands,
    },

    // ===== Store management =====

    /// Google Play Store management (upload, submit, promote, etc.)
    Store {
        #[command(subcommand)]
        command: StoreCommands,
    },

    /// Huawei AppGallery management
    Huawei {
        #[command(subcommand)]
        command: HuaweiCommands,
    },

    /// RuStore management
    Rustore {
        #[command(subcommand)]
        command: RuStoreCommands,
    },

    /// [experimental] Run a sequence of automation steps in one invocation
    Flow {
        #[command(subcommand)]
        command: FlowCommands,
    },

    /// Wait for a UI element to appear (polls every --interval ms up to --timeout ms)
    UiWait {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Match by text (case-insensitive partial match)
        #[arg(long)]
        text: Option<String>,

        /// Match by resource-id (case-insensitive partial match)
        #[arg(long)]
        resource_id: Option<String>,

        /// Match by class name (case-insensitive partial match)
        #[arg(long)]
        class_name: Option<String>,

        /// Timeout in milliseconds (default: 5000)
        #[arg(long, default_value = "5000")]
        timeout: u64,

        /// Polling interval in milliseconds (default: 500)
        #[arg(long, default_value = "500")]
        interval: u64,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Assert that a UI element is currently visible (exit 1 if not found)
    UiAssertVisible {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Match by text (case-insensitive partial match)
        #[arg(long)]
        text: Option<String>,

        /// Match by resource-id (case-insensitive partial match)
        #[arg(long)]
        resource_id: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Assert that a UI element is NOT present (exit 1 if found)
    UiAssertGone {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Match by text (case-insensitive partial match)
        #[arg(long)]
        text: Option<String>,

        /// Match by resource-id (case-insensitive partial match)
        #[arg(long)]
        resource_id: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Sensor commands (Android-only) =====

    /// Set mock GPS location (Android only)
    SensorLocation {
        /// Latitude in decimal degrees (e.g. 37.7749)
        latitude: f64,

        /// Longitude in decimal degrees (e.g. -122.4194)
        longitude: f64,

        /// Altitude in metres (default: 0.0)
        #[arg(long, default_value = "0.0")]
        altitude: f64,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Override battery state (Android only)
    SensorBattery {
        /// Battery level 0-100
        #[arg(long)]
        level: Option<u8>,

        /// Battery status: charging, discharging, full, not_charging, unknown
        #[arg(long)]
        status: Option<String>,

        /// Power source: ac, usb, wireless, unplugged
        #[arg(long)]
        plugged: Option<String>,

        /// Reset battery to real values
        #[arg(long, default_value = "false")]
        reset: bool,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// List active notifications (Android only)
    SensorNotifications {
        /// Filter by package name
        #[arg(long)]
        package: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Override or reset thermal status (Android only)
    SensorThermal {
        /// Thermal status: none, light, moderate, severe, critical, emergency, shutdown
        #[arg(long)]
        status: Option<String>,

        /// Reset thermal status to real value
        #[arg(long, default_value = "false")]
        reset: bool,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Network commands (Android-only) =====

    /// Show per-app or global network traffic (Android only)
    NetworkTraffic {
        /// Filter by package name (omit for global stats)
        #[arg(long)]
        package: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Show connectivity and WiFi status (Android only)
    NetworkConnectivity {
        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Get, set, or clear the HTTP proxy (Android only)
    NetworkProxy {
        /// Proxy host (required when setting)
        #[arg(long)]
        host: Option<String>,

        /// Proxy port (required when setting)
        #[arg(long)]
        port: Option<u16>,

        /// Clear the proxy setting
        #[arg(long, default_value = "false")]
        clear: bool,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Enable or disable airplane mode (Android only)
    NetworkAirplane {
        /// on or off
        #[arg(value_parser = ["on", "off"])]
        state: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Permission commands =====

    /// Grant a permission to a package
    PermissionGrant {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Package name (Android) or bundle ID (iOS)
        package: String,

        /// Permission (e.g. android.permission.CAMERA or photos/camera for iOS)
        permission: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Revoke a permission from a package
    PermissionRevoke {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Package name (Android) or bundle ID (iOS)
        package: String,

        /// Permission name
        permission: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Reset all runtime permissions for a package
    PermissionReset {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// Package name (Android) or bundle ID (iOS)
        package: String,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Intent commands (Android + iOS deeplink) =====

    /// Start an activity via am start (Android only)
    IntentStart {
        /// Intent action (e.g. android.intent.action.MAIN)
        #[arg(long)]
        action: Option<String>,

        /// Component name (e.g. com.example/.MainActivity)
        #[arg(long)]
        component: Option<String>,

        /// Data URI
        #[arg(long)]
        data: Option<String>,

        /// Category (e.g. android.intent.category.LAUNCHER)
        #[arg(long)]
        category: Option<String>,

        /// Package name
        #[arg(long)]
        package: Option<String>,

        /// Extras as JSON object (e.g. {"key":"value","num":42})
        #[arg(long)]
        extras: Option<String>,

        /// Intent flags as hex string (e.g. 0x10000000)
        #[arg(long)]
        flags: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Send a broadcast intent via am broadcast (Android only)
    IntentBroadcast {
        /// Broadcast action (required)
        #[arg(long)]
        action: String,

        /// Target package
        #[arg(long)]
        package: Option<String>,

        /// Target component (pkg/.ReceiverClass)
        #[arg(long)]
        component: Option<String>,

        /// Extras as JSON object
        #[arg(long)]
        extras: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Open a deep-link URI (Android + iOS)
    IntentDeeplink {
        /// Platform: android or ios
        #[arg(value_parser = ["android", "ios"])]
        platform: String,

        /// URI to open (e.g. myapp://screen/detail?id=1)
        uri: String,

        /// Restrict to this package (Android only)
        #[arg(long)]
        package: Option<String>,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// List running services (Android only)
    IntentServices {
        /// Filter by package name
        #[arg(long)]
        package: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Sandbox commands (Android-only) =====

    /// Read SharedPreferences XML from app sandbox (Android only)
    SandboxPrefsRead {
        /// Package name
        package: String,

        /// Preferences file name without .xml (default: default_preferences)
        #[arg(long)]
        file: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Write a value to SharedPreferences (Android only)
    SandboxPrefsWrite {
        /// Package name
        package: String,

        /// Preferences file name without .xml
        file: String,

        /// Preference key to update
        key: String,

        /// Value to set
        value: String,

        /// Type: string, boolean, int, long, float (default: string)
        #[arg(long, default_value = "string")]
        r#type: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Execute a SQLite query on the app's database (Android only)
    SandboxSqliteQuery {
        /// Package name
        package: String,

        /// Database file name (e.g. app.db) or absolute path
        database: String,

        /// SQL query to execute
        query: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// List files in the app sandbox directory (Android only)
    SandboxFileList {
        /// Package name
        package: String,

        /// Path inside app data dir (default: .)
        #[arg(long)]
        path: Option<String>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Read a file from the app sandbox (Android only)
    SandboxFileRead {
        /// Package name
        package: String,

        /// File path inside app data dir
        path: String,

        /// Maximum bytes to read (omit for full file)
        #[arg(long)]
        max_bytes: Option<u64>,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    // ===== Performance commands (Android-only) =====

    /// Capture memory/CPU/battery/framestats snapshot for a package (Android only)
    PerfSnapshot {
        /// Package name (e.g. com.example.app)
        package: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Save a perf-snapshot as a named baseline to /tmp (Android only)
    PerfBaseline {
        /// Package name (e.g. com.example.app)
        package: String,

        /// Baseline name (e.g. before-refactor)
        name: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Compare current perf against a saved baseline (Android only)
    PerfCompare {
        /// Package name (e.g. com.example.app)
        package: String,

        /// Baseline name to compare against
        name: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Collect N perf samples at an interval and show trends (Android only)
    PerfMonitor {
        /// Package name (e.g. com.example.app)
        package: String,

        /// Number of samples to collect (default: 5)
        #[arg(long, default_value = "5")]
        count: u32,

        /// Interval between samples in milliseconds (default: 1000)
        #[arg(long, default_value = "1000")]
        interval_ms: u64,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Extract recent crashes and ANRs from logcat (Android only)
    PerfCrashes {
        /// Filter by package name
        #[arg(long)]
        package: Option<String>,

        /// Number of log lines to retrieve (default: 50)
        #[arg(long, default_value = "50")]
        lines: usize,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Detailed frame rendering stats for a package (Android only)
    PerfFramestats {
        /// Package name (e.g. com.example.app)
        package: String,

        /// Android device serial
        #[arg(long)]
        device: Option<String>,
    },

    /// Check all tool dependencies and print green/red status for each platform
    Doctor,

    /// Record, manage and replay automation scenarios
    Recorder {
        #[command(subcommand)]
        command: RecorderCommands,
    },

    /// Coordinated multi-device testing (sync groups)
    Sync {
        #[command(subcommand)]
        command: SyncCommands,
    },

    /// Manage persistent CLI settings (~/.claude-mobile/config.json)
    Config {
        #[command(subcommand)]
        command: ConfigCommands,
    },

    /// Inject a scannable barcode/QR into the emulator camera (Android emulator only)
    ///
    /// Generates a barcode of the requested symbology and feeds it to the
    /// back camera as a full-frame `videofile` source, so the app under test
    /// really decodes it via its own camera stack (CameraX / ML Kit / ZXing).
    ///
    /// First run on a given emulator needs `--setup` (cold-boots the AVD into
    /// videofile camera mode). After that, re-running `scan` just swaps the
    /// image; reopen the app's camera screen to pick up the new code.
    Scan {
        /// Text payload to encode (e.g. an item/box code)
        text: String,

        /// Barcode symbology
        #[arg(long, default_value = "qr", value_parser = ["qr", "code128", "ean13"])]
        r#type: String,

        /// Android emulator serial (default: first attached emulator)
        #[arg(long)]
        device: Option<String>,

        /// Cold-boot the emulator into videofile camera mode before injecting.
        /// Required once per emulator session (changes the camera source).
        #[arg(long, default_value = "false")]
        setup: bool,

        /// AVD name to (re)launch with `--setup` (auto-detected from the device if omitted)
        #[arg(long)]
        avd: Option<String>,

        /// Host path for the managed camera video
        /// (default: ~/.claude-mobile/scan/feed.mp4)
        #[arg(long)]
        video_path: Option<String>,

        /// Tile the barcode across the frame so a copy always lands inside the
        /// app's scan region-of-interest. Disable for a single centered code.
        #[arg(long, default_value = "true")]
        tile: bool,
    },
}

// -- Flow subcommands ---------------------------------------------------------

#[derive(Subcommand)]
pub enum FlowCommands {
    /// Execute a sequence of steps from JSON (stdin or --file)
    Run {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Path to JSON file with steps (reads from stdin if omitted)
        #[arg(short, long)]
        file: Option<String>,

        /// Turbo mode: compact UI tree after each step, screenshot on fail
        #[arg(long, default_value = "false")]
        turbo: bool,

        /// Maximum total duration in milliseconds (default: 60000)
        #[arg(long, default_value = "60000")]
        max_duration: u64,

        /// Stop on first error (default: true, respects per-step on_error)
        #[arg(long, default_value = "true")]
        stop_on_error: bool,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Execute multiple named commands sequentially (batch API format)
    ///
    /// Input JSON format:
    /// `[{"name": "tap", "arguments": ["100", "200"]}, {"name": "input", "arguments": ["hello"]}]`
    Batch {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Path to JSON file with commands (reads from stdin if omitted)
        #[arg(short, long)]
        file: Option<String>,

        /// Stop execution on first error (default: true)
        #[arg(long, default_value = "true")]
        stop_on_error: bool,

        /// Turbo mode: compact UI tree after each step, screenshot on fail
        #[arg(long, default_value = "false")]
        turbo: bool,

        /// iOS Simulator name
        #[arg(long)]
        simulator: Option<String>,

        /// Android/Aurora device serial
        #[arg(long)]
        device: Option<String>,

        /// Desktop companion app path
        #[arg(long)]
        companion_path: Option<String>,
    },

    /// Run the same flow file on multiple devices sequentially
    ///
    /// Example: `claude-in-mobile flow parallel android --file steps.json --devices "device1,device2"`
    Parallel {
        /// Platform: android, ios, aurora, or desktop
        #[arg(value_parser = ["android", "ios", "aurora", "desktop"])]
        platform: String,

        /// Path to JSON file with steps (reads from stdin if omitted)
        #[arg(short, long)]
        file: Option<String>,

        /// Comma-separated list of device/simulator identifiers
        #[arg(long)]
        devices: String,

        /// Turbo mode: compact UI tree after each step, screenshot on fail
        #[arg(long, default_value = "false")]
        turbo: bool,

        /// Maximum total duration in milliseconds per device (default: 60000)
        #[arg(long, default_value = "60000")]
        max_duration: u64,
    },
}

// -- Config subcommands -------------------------------------------------------

#[derive(Subcommand)]
pub enum ConfigCommands {
    /// Get the value of a config key
    Get {
        /// Key name (e.g. "turbo")
        key: String,
    },

    /// Set a config key to a value
    Set {
        /// Key name (e.g. "turbo")
        key: String,

        /// Value (true/false → bool, digits → number, else string)
        value: String,
    },

    /// List all config settings
    List,

    /// Remove a config key
    Reset {
        /// Key name to remove
        key: String,
    },
}

// -- Setup subcommands --------------------------------------------------------

#[derive(Subcommand)]
pub enum SetupCommands {
    /// Install OpenCode skill files for CLI-based device automation
    Opencode {
        /// Install into the current project (.opencode/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.config/opencode/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },

    /// Install Pi skill files for CLI-based device automation
    Pi {
        /// Install into the current project (.pi/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.pi/agent/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },

    /// Install Qwen Code skill files for CLI-based device automation
    Qwen {
        /// Install into the current project (.qwen/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.qwen/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },

    /// Install Gemini CLI skill files for CLI-based device automation
    Gemini {
        /// Install into the current project (.gemini/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.gemini/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },

    /// Install Codex skill files for CLI-based device automation
    Codex {
        /// Install into the current project (.agents/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.agents/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },

    /// Install Cursor skill files for CLI-based device automation
    Cursor {
        /// Install into the current project (.cursor/skills). This is the default.
        #[arg(long, conflicts_with = "global")]
        local: bool,

        /// Install globally for the current user (~/.cursor/skills)
        #[arg(long, conflicts_with = "local")]
        global: bool,

        /// Overwrite existing skill files if they differ
        #[arg(long)]
        force: bool,
    },
}

// -- Google Play subcommands --------------------------------------------------

#[derive(Subcommand)]
pub enum StoreCommands {
    /// Upload APK or AAB to Google Play (creates a release draft)
    Upload {
        /// App package name (e.g. com.example.app)
        #[arg(short, long)]
        package: String,
        /// Path to .aab or .apk file
        #[arg(short, long)]
        file: String,
    },
    /// Set release notes for the current Google Play draft
    SetNotes {
        #[arg(short, long)] package: String,
        /// BCP-47 language tag (e.g. en-US, ru-RU)
        #[arg(short, long)] language: String,
        /// Release notes text (max 500 chars)
        #[arg(short, long)] text: String,
    },
    /// Publish the current Google Play draft to a track
    Submit {
        #[arg(short, long)] package: String,
        /// Track: internal, alpha, beta, or production
        #[arg(short, long, default_value = "internal")] track: String,
        /// Staged rollout fraction 0.01-1.0 (default: 1.0 = 100%)
        #[arg(long, default_value = "1.0")] rollout: f64,
    },
    /// Promote latest release from one track to another
    Promote {
        #[arg(short, long)] package: String,
        #[arg(long)] from_track: String,
        #[arg(long)] to_track: String,
    },
    /// Get current releases across tracks
    GetReleases {
        #[arg(short, long)] package: String,
        /// Filter to specific track (omit for all tracks)
        #[arg(short, long)] track: Option<String>,
    },
    /// Halt a staged rollout
    HaltRollout {
        #[arg(short, long)] package: String,
        #[arg(short, long)] track: String,
    },
    /// Discard the current draft without publishing
    Discard {
        #[arg(short, long)] package: String,
    },
}

// -- Huawei AppGallery subcommands --------------------------------------------

#[derive(Subcommand)]
pub enum HuaweiCommands {
    /// Upload APK or AAB to Huawei AppGallery
    Upload {
        #[arg(short, long)] package: String,
        #[arg(short, long)] file: String,
    },
    /// Set release notes for the current Huawei draft
    SetNotes {
        #[arg(short, long)] package: String,
        #[arg(short, long)] language: String,
        #[arg(short, long)] text: String,
    },
    /// Submit Huawei draft for review and publishing
    Submit {
        #[arg(short, long)] package: String,
    },
    /// Get current release info from Huawei AppGallery
    GetReleases {
        #[arg(short, long)] package: String,
    },
}

// -- RuStore subcommands ------------------------------------------------------

#[derive(Subcommand)]
pub enum RuStoreCommands {
    /// Upload APK or AAB to RuStore
    Upload {
        #[arg(short, long)] package: String,
        #[arg(short, long)] file: String,
    },
    /// Set what's new notes for the current RuStore draft
    SetNotes {
        #[arg(short, long)] package: String,
        #[arg(short, long)] language: String,
        #[arg(short, long)] text: String,
    },
    /// Submit RuStore draft for moderation
    Submit {
        #[arg(short, long)] package: String,
    },
    /// Get list of versions and statuses from RuStore
    GetVersions {
        #[arg(short, long)] package: String,
    },
    /// Delete current RuStore draft
    Discard {
        #[arg(short, long)] package: String,
    },
}

// -- Recorder subcommands -----------------------------------------------------

#[derive(Subcommand)]
pub enum RecorderCommands {
    /// Start a new recording session (creates /tmp/claude-mobile-recording-<name>.json)
    Start {
        /// Scenario name (used as filename and identifier)
        #[arg(short, long)]
        name: String,

        /// Target platform (android, ios, aurora, desktop)
        #[arg(short, long, default_value = "android")]
        platform: String,

        /// Human-readable description of the scenario
        #[arg(short, long)]
        description: Option<String>,

        /// Comma-separated tags (e.g. smoke,login)
        #[arg(long)]
        tags: Option<String>,
    },

    /// Stop the active recording and save the scenario (or discard it)
    Stop {
        /// Discard the recording without saving
        #[arg(long, default_value = "false")]
        discard: bool,
    },

    /// Show the current active recording state and recent steps
    Status,

    /// Manually add a step to the active recording
    AddStep {
        /// Action name (tap, swipe, input, …)
        action_name: String,

        /// Action arguments as a JSON array (e.g. '["100","200"]')
        #[arg(long)]
        args: Option<String>,

        /// Optional human-readable label for this step
        #[arg(long)]
        label: Option<String>,
    },

    /// Remove a step from the active recording by 1-based index
    RemoveStep {
        /// 1-based index of the step to remove
        step_index: usize,
    },

    /// List saved scenarios
    List {
        /// Filter by platform (omit to list all platforms)
        #[arg(short, long)]
        platform: Option<String>,

        /// Filter by tag
        #[arg(long)]
        tag: Option<String>,
    },

    /// Display the full contents of a saved scenario
    Show {
        /// Scenario name
        name: String,

        /// Platform the scenario belongs to
        #[arg(short, long, default_value = "android")]
        platform: String,
    },

    /// Delete a saved scenario
    Delete {
        /// Scenario name
        name: String,

        /// Platform the scenario belongs to
        #[arg(short, long, default_value = "android")]
        platform: String,
    },

    /// Replay a saved scenario
    Play {
        /// Scenario name
        name: String,

        /// Platform to replay on
        #[arg(short, long, default_value = "android")]
        platform: String,

        /// Playback speed multiplier (default: 1.0)
        #[arg(long, default_value = "1.0")]
        speed: f64,

        /// Stop replay on the first failing step
        #[arg(long, default_value = "false")]
        stop_on_fail: bool,

        /// Per-step timeout in milliseconds (omit for no timeout)
        #[arg(long)]
        step_timeout: Option<u64>,

        /// Maximum total replay duration in milliseconds (omit for no limit)
        #[arg(long)]
        max_duration: Option<u64>,

        /// First step to replay (1-based, default: 1)
        #[arg(long)]
        from_step: Option<usize>,

        /// Last step to replay (1-based, default: last)
        #[arg(long)]
        to_step: Option<usize>,

        /// Print steps without executing them
        #[arg(long, default_value = "false")]
        dry_run: bool,
    },

    /// Export a scenario as flow_steps JSON or markdown
    Export {
        /// Scenario name
        name: String,

        /// Platform the scenario belongs to
        #[arg(short, long, default_value = "android")]
        platform: String,

        /// Output format: flow_steps or markdown
        #[arg(short, long, default_value = "flow_steps",
              value_parser = ["flow_steps", "markdown"])]
        format: String,
    },
}

// -- Sync subcommands ---------------------------------------------------------

#[derive(Subcommand)]
pub enum SyncCommands {
    /// Create a new device group for coordinated testing
    CreateGroup {
        /// Group name (used as identifier)
        name: String,

        /// Roles as a JSON array (e.g. '[{"name":"sender","deviceId":"abc"}]')
        #[arg(long)]
        roles: String,
    },

    /// Execute a sequence of cross-role steps
    Run {
        /// Sync group name
        group_name: String,

        /// Path to JSON file containing the steps array
        #[arg(long)]
        file: String,

        /// Maximum total run duration in milliseconds (omit for no limit)
        #[arg(long)]
        max_duration: Option<u64>,
    },

    /// Perform a cross-device assertion (source action triggers, target is verified)
    AssertCross {
        /// Sync group name
        group_name: String,

        /// Source role name
        #[arg(long)]
        source_role: String,

        /// Action to perform on the source device
        #[arg(long)]
        source_action: String,

        /// Source action arguments as a JSON array
        #[arg(long)]
        source_args: Option<String>,

        /// Target role name
        #[arg(long)]
        target_role: String,

        /// Action to verify on the target device
        #[arg(long)]
        target_action: String,

        /// Target action arguments as a JSON array
        #[arg(long)]
        target_args: Option<String>,

        /// Milliseconds to wait between source and target action
        #[arg(long)]
        delay_ms: Option<u64>,

        /// Number of retry attempts for the target action (default: 1)
        #[arg(long, default_value = "1")]
        retries: u32,
    },

    /// Show group details and last run summary
    Status {
        /// Sync group name
        group_name: String,
    },

    /// List all active sync groups
    List,

    /// Destroy (delete) a sync group
    Destroy {
        /// Sync group name
        group_name: String,
    },
}
