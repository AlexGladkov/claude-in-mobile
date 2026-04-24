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
