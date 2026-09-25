use std::cell::Cell;
#[cfg(unix)]
use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use anyhow::{bail, Context, Result};

thread_local! {
    static ACTIVE_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Temporarily bound process helpers on the current thread to a wall-clock
pub(crate) struct DeadlineGuard {
    previous: Option<Instant>,
}

/// Install a deadline for process helpers called on the current thread.
pub(crate) fn install_deadline(deadline: Option<Instant>) -> DeadlineGuard {
    let previous = ACTIVE_DEADLINE.with(|active| {
        let previous = active.get();
        active.set(deadline);
        previous
    });
    DeadlineGuard { previous }
}

impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        ACTIVE_DEADLINE.with(|active| active.set(self.previous));
    }
}

pub(crate) fn effective_duration(duration: Duration) -> Duration {
    ACTIVE_DEADLINE.with(|active| {
        active
            .get()
            .map(|deadline| duration.min(deadline.saturating_duration_since(Instant::now())))
            .unwrap_or(duration)
    })
}

pub(crate) fn remaining_deadline() -> Option<Duration> {
    ACTIVE_DEADLINE.with(|active| {
        active
            .get()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    })
}
fn effective_timeout(timeout: Duration) -> Duration {
    effective_duration(timeout)
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    // Keep every descendant in a private process group so a timeout cannot
    // leave grandchildren holding the captured pipes open.
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_tree(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // The root is placed in a separate group; taskkill is only considered
    // while the owned child handle still reports that root as alive.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_tree(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn signal_process_group(
    group: u32,
    members: impl IntoIterator<Item = TrackedProcess>,
    signal: libc::c_int,
) {
    let Ok(group) = libc::pid_t::try_from(group) else {
        return;
    };
    if group <= 1 {
        return;
    }
    // A process-group ID is reusable after its last member exits.  Require a
    // still-live member whose start identity was captured while it belonged to
    // this command before addressing the group.  This check is intentionally
    // repeated for every signal, including the post-reap SIGKILL.
    if !members.into_iter().any(|member| {
        if !tracked_process_identity_matches(member) {
            return false;
        }
        let same_group = current_process_group(member.pid) == Some(group);
        same_group && tracked_process_identity_matches(member)
    }) {
        return;
    }
    // SAFETY: the group was created for the command and still contains a
    // verified member with the captured process identity.
    unsafe {
        let _ = libc::kill(-group, signal);
    }
}

#[cfg(unix)]
fn current_process_group(pid: libc::pid_t) -> Option<libc::pid_t> {
    // SAFETY: getpgid only observes the process identified by `pid`.
    let group = unsafe { libc::getpgid(pid) };
    (group > 1).then_some(group)
}
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TrackedProcess {
    pid: libc::pid_t,
    identity: Option<u64>,
}

#[cfg(target_os = "linux")]
fn process_identity(pid: libc::pid_t) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat.rsplit_once(") ")?.1.split_whitespace();
    fields.nth(19)?.parse().ok()
}

#[cfg(target_os = "macos")]
fn process_identity(pid: libc::pid_t) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let copied = unsafe {
        macos_proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int,
        )
    };
    if copied < std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(
        info.pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    )
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_identity(_pid: libc::pid_t) -> Option<u64> {
    None
}

#[cfg(unix)]
pub(crate) fn track_process(pid: u32) -> Option<TrackedProcess> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    Some(TrackedProcess {
        pid,
        identity: Some(process_identity(pid)?),
    })
}

#[cfg(unix)]
fn tracked_process_identity_matches(process: TrackedProcess) -> bool {
    if process.pid <= 1 {
        return false;
    }
    process
        .identity
        .is_some_and(|identity| process_identity(process.pid) == Some(identity))
}

#[cfg(unix)]
pub(crate) fn signal_process(process: TrackedProcess, signal: libc::c_int) {
    if !tracked_process_identity_matches(process) {
        return;
    }
    // SAFETY: callers pass a child or descendant PID discovered from the
    // process tree rooted at the command we spawned, and its identity was
    // revalidated immediately before signaling.
    unsafe {
        let _ = libc::kill(process.pid, signal);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
const MAX_PROCESS_DESCENDANTS: usize = 4096;

fn collect_linux_descendants(pid: u32, descendants: &mut Vec<libc::pid_t>) {
    let mut pending = vec![pid];
    let mut seen = HashSet::new();
    seen.insert(pid as libc::pid_t);
    while let Some(parent) = pending.pop() {
        let path = format!("/proc/{parent}/task/{parent}/children");
        let Ok(children) = std::fs::read_to_string(path) else {
            continue;
        };
        for child in children
            .split_whitespace()
            .filter_map(|value| value.parse::<libc::pid_t>().ok())
        {
            if descendants.len() >= MAX_PROCESS_DESCENDANTS {
                return;
            }
            if child <= 1 || !seen.insert(child) {
                continue;
            }
            descendants.push(child);
            let Ok(child_id) = u32::try_from(child) else {
                continue;
            };
            pending.push(child_id);
        }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    #[link_name = "proc_listchildpids"]
    fn macos_proc_listchildpids(
        ppid: libc::pid_t,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
    #[link_name = "proc_pidinfo"]
    fn macos_proc_pidinfo(
        pid: libc::pid_t,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
const MACOS_MAX_DESCENDANTS: usize = 4096;

/// Snapshot a bounded descendant tree through macOS's libproc API. Unlike
/// process groups, this also finds children that called `setsid()`.
#[cfg(target_os = "macos")]
fn collect_macos_descendants(pid: u32, descendants: &mut Vec<libc::pid_t>) {
    let pid_size = std::mem::size_of::<libc::pid_t>();
    let mut pending = vec![pid];
    let mut seen = HashSet::new();
    seen.insert(pid as libc::pid_t);

    while let Some(parent) = pending.pop() {
        let mut capacity = 32usize;
        loop {
            let buffer_bytes = capacity
                .saturating_mul(pid_size)
                .min(libc::c_int::MAX as usize);
            if buffer_bytes < pid_size {
                break;
            }
            let mut children = vec![0 as libc::pid_t; buffer_bytes / pid_size];
            // SAFETY: libproc writes at most `buffer_bytes` bytes to the
            // owned, correctly aligned PID buffer.
            let copied = unsafe {
                macos_proc_listchildpids(
                    parent as libc::pid_t,
                    children.as_mut_ptr().cast(),
                    buffer_bytes as libc::c_int,
                )
            };
            if copied <= 0 {
                break;
            }
            let copied_bytes = copied as usize;
            let count = (copied_bytes / pid_size).min(children.len());
            for child in children.into_iter().take(count) {
                if descendants.len() >= MACOS_MAX_DESCENDANTS {
                    return;
                }
                if child <= 1 || !seen.insert(child) {
                    continue;
                }
                descendants.push(child);
                if let Ok(child_id) = u32::try_from(child) {
                    pending.push(child_id);
                }
            }

            // libproc returns the number of bytes copied. A full buffer may
            // have truncated the result; grow it up to the safety bound.
            if copied_bytes < buffer_bytes || capacity >= MACOS_MAX_DESCENDANTS {
                break;
            }
            capacity = capacity.saturating_mul(2).min(MACOS_MAX_DESCENDANTS);
        }
    }
}

#[cfg(unix)]
fn collect_process_descendants(pid: u32) -> Vec<libc::pid_t> {
    let mut descendants = Vec::new();
    #[cfg(target_os = "linux")]
    collect_linux_descendants(pid, &mut descendants);
    #[cfg(target_os = "macos")]
    collect_macos_descendants(pid, &mut descendants);
    descendants
}

#[cfg(unix)]
pub(crate) fn append_process_descendants(pid: u32, descendants: &mut Vec<TrackedProcess>) {
    let mut seen: HashSet<libc::pid_t> = descendants.iter().map(|process| process.pid).collect();
    for child in collect_process_descendants(pid) {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if descendants.len() >= MAX_PROCESS_DESCENDANTS {
            break;
        }
        if !seen.insert(child) {
            continue;
        }
        let identity = process_identity(child);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if identity.is_none() {
            continue;
        }
        descendants.push(TrackedProcess {
            pid: child,
            identity,
        });
    }
}

#[cfg(unix)]
fn terminate_process_tree(
    child: &mut Child,
    group: u32,
    root: Option<TrackedProcess>,
    mut descendants: Vec<TrackedProcess>,
    cleanup_descendants: bool,
) {
    // Descendants were snapshotted while the root was still alive, so children
    // that escape their process group cannot be reparented before discovery.
    // Preserve every descendant after a successful root exit; ADB, hdc, and
    // simctl may intentionally leave persistent daemons behind.
    if !cleanup_descendants {
        let _ = child.wait();
        return;
    }

    signal_process_group(
        group,
        root.into_iter().chain(descendants.iter().copied()),
        libc::SIGTERM,
    );
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    for process in descendants.iter().rev().copied() {
        signal_process(process, libc::SIGTERM);
    }
    let _ = child.kill();
    let _ = child.wait();
    // A descendant may ignore SIGTERM; force-close every inherited pipe.  The
    // group helper revalidates a surviving owned member before this SIGKILL,
    // so a reaped root's recycled process-group ID cannot target outsiders.
    signal_process_group(
        group,
        root.into_iter().chain(descendants.iter().copied()),
        libc::SIGKILL,
    );
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    for process in descendants.drain(..).rev() {
        signal_process(process, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child, cleanup_tree: bool) {
    // `Child::try_wait` observes the owned process handle.  Never invoke
    // taskkill after that handle reports the root has exited: the PID may have
    // been recycled for an unrelated process.
    if cleanup_tree && matches!(child.try_wait(), Ok(None)) {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn reap_thread<T: Send + 'static>(worker: thread::JoinHandle<T>) {
    // Dropping a JoinHandle detaches the worker.  Reaping it from a separate
    // thread lets the command return even when a Windows pipe read cannot be
    // interrupted after a descendant retained the pipe handle.
    let _ = thread::Builder::new()
        .name("mcp-process-reaper".to_owned())
        .spawn(move || {
            let _ = worker.join();
        });
}

#[cfg(windows)]
fn join_thread_bounded<T: Send + 'static>(
    worker: thread::JoinHandle<T>,
    label: &str,
) -> Result<Option<T>> {
    const JOIN_GRACE: Duration = Duration::from_millis(250);
    let deadline = Instant::now() + JOIN_GRACE;
    while !worker.is_finished() {
        if Instant::now() >= deadline {
            reap_thread(worker);
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(2));
    }
    worker
        .join()
        .map(Some)
        .map_err(|_| anyhow::anyhow!("{label} worker panicked"))
}

#[cfg(not(windows))]
fn join_thread_bounded<T: Send + 'static>(
    worker: thread::JoinHandle<T>,
    label: &str,
) -> Result<Option<T>> {
    worker
        .join()
        .map(Some)
        .map_err(|_| anyhow::anyhow!("{label} worker panicked"))
}

fn join_input_writer_handle(
    worker: thread::JoinHandle<std::io::Result<()>>,
    action: &str,
) -> Result<()> {
    let label = format!("{action} stdin writer");
    let Some(joined) = join_thread_bounded(worker, &label)? else {
        bail!("{label} did not terminate after process cleanup");
    };
    joined.with_context(|| format!("{action} stdin writer failed"))
}

fn join_output_reader_handle(
    worker: thread::JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
    stream: &str,
    action: &str,
) -> Result<(Vec<u8>, bool)> {
    let label = format!("{action} {stream} reader");
    let Some(joined) = join_thread_bounded(worker, &label)? else {
        bail!("{label} did not terminate after process cleanup");
    };
    joined.with_context(|| format!("{label} failed"))
}

pub fn run_with_limits(
    command: &mut Command,
    timeout: Duration,
    max_output_bytes: usize,
    action: &str,
) -> Result<Output> {
    run(command, None, timeout, max_output_bytes, action)
}

pub fn run_with_input_limits(
    command: &mut Command,
    input: Vec<u8>,
    timeout: Duration,
    max_output_bytes: usize,
    action: &str,
) -> Result<Output> {
    run(command, Some(input), timeout, max_output_bytes, action)
}

fn run(
    command: &mut Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
    action: &str,
) -> Result<Output> {
    let timeout = effective_timeout(timeout);
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_tree(command);
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to start {action}"))?;
    #[cfg(unix)]
    let process_group = child.id();
    #[cfg(unix)]
    let root_process = track_process(child.id());
    #[cfg(unix)]
    let mut descendants = Vec::new();

    let stdout = child
        .stdout
        .take()
        .context("Child stdout was not captured")?;
    let stderr = child
        .stderr
        .take()
        .context("Child stderr was not captured")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let stdout_cancel = Arc::clone(&cancelled);
    let stderr_cancel = Arc::clone(&cancelled);
    let stdout_reader =
        thread::spawn(move || read_capped_cancelable(stdout, max_output_bytes, stdout_cancel));
    let stderr_reader =
        thread::spawn(move || read_capped_cancelable(stderr, max_output_bytes, stderr_cancel));
    let input_writer = match input {
        Some(bytes) => {
            let stdin = child.stdin.take().context("Child stdin was not captured")?;
            let input_cancel = Arc::clone(&cancelled);
            Some(thread::spawn(move || {
                write_input_cancelable(stdin, bytes, input_cancel)
            }))
        }
        None => None,
    };

    #[cfg(unix)]
    append_process_descendants(child.id(), &mut descendants);
    let wait_started = Instant::now();
    let wait_result = loop {
        #[cfg(unix)]
        append_process_descendants(child.id(), &mut descendants);

        match child.try_wait() {
            Ok(Some(status)) => break Ok(Some(status)),
            Ok(None) => {
                if wait_started.elapsed() >= timeout {
                    // The root is still alive at this point, so capture a
                    // late-spawned setsid child before termination reaps it.
                    #[cfg(unix)]
                    append_process_descendants(child.id(), &mut descendants);
                    break Ok(None);
                }
                let remaining = timeout.saturating_sub(wait_started.elapsed());
                thread::sleep(remaining.min(Duration::from_millis(5)));
            }
            Err(error) => break Err(error),
        }
    };
    // Preserve escaped daemons only after a successful root exit. Timeouts,
    // wait errors, and failed commands must clean descendants.
    #[cfg(unix)]
    let cleanup_descendants = !matches!(&wait_result, Ok(Some(status)) if status.success());
    #[cfg(unix)]
    terminate_process_tree(
        &mut child,
        process_group,
        root_process,
        descendants,
        cleanup_descendants,
    );
    #[cfg(windows)]
    terminate_process_tree(&mut child, matches!(&wait_result, Ok(None)));
    #[cfg(not(any(unix, windows)))]
    terminate_process_tree(&mut child);

    // Request cancellation before bounded joins. Unix readers observe this
    // flag directly; Windows readers may still be blocked on a pipe, so a
    // reaper thread takes ownership if they do not settle promptly.
    cancelled.store(true, Ordering::SeqCst);
    let input_result = input_writer.map(|writer| join_input_writer_handle(writer, action));
    let stdout_result = join_output_reader_handle(stdout_reader, "stdout", action);
    let stderr_result = join_output_reader_handle(stderr_reader, "stderr", action);

    let status = match wait_result {
        Ok(Some(status)) => status,
        Ok(None) => bail!("{action} timed out"),
        Err(error) => {
            return Err(error).with_context(|| format!("Failed while waiting for {action}"));
        }
    };

    if let Some(input_result) = input_result {
        input_result?;
    }
    let (mut stdout, stdout_truncated) = stdout_result?;
    let (mut stderr, stderr_truncated) = stderr_result?;
    if stdout_truncated || stderr_truncated {
        bail!("{action} exceeded the output limit");
    }

    if !status.success() {
        stdout.clear();
        stderr.clear();
        stderr.extend_from_slice(b"command failed");
    }

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(not(unix))]
fn read_capped(mut input: impl Read, max_bytes: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(max_bytes.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = max_bytes.saturating_sub(output.len());
        if count > remaining {
            truncated = true;
        }
        if remaining > 0 {
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    Ok((output, truncated))
}

#[cfg(unix)]
fn set_nonblocking(file: &impl AsRawFd) -> io::Result<()> {
    let fd = file.as_raw_fd();
    // SAFETY: fcntl only changes flags on this owned pipe descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor remains owned by the caller for this operation.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn read_capped_cancelable(
    mut input: impl Read + AsRawFd,
    max_bytes: usize,
    cancelled: Arc<AtomicBool>,
) -> io::Result<(Vec<u8>, bool)> {
    set_nonblocking(&input)?;
    let mut output = Vec::with_capacity(max_bytes.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let remaining = max_bytes.saturating_sub(output.len());
                if count > remaining {
                    truncated = true;
                }
                if remaining > 0 {
                    output.extend_from_slice(&buffer[..count.min(remaining)]);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
    Ok((output, truncated))
}

#[cfg(not(unix))]
fn read_capped_cancelable(
    input: impl Read,
    max_bytes: usize,
    _cancelled: Arc<AtomicBool>,
) -> io::Result<(Vec<u8>, bool)> {
    // Windows anonymous-pipe reads are blocking through std. `run` bounds
    // this worker's join and reaps it if a descendant retains the pipe.
    read_capped(input, max_bytes)
}

#[cfg(unix)]
fn write_input_cancelable(
    mut input: impl Write + AsRawFd,
    bytes: Vec<u8>,
    cancelled: Arc<AtomicBool>,
) -> io::Result<()> {
    set_nonblocking(&input)?;
    let mut offset = 0;
    while offset < bytes.len() {
        match input.write(&bytes[offset..]) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "stdin closed")),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_input_cancelable(
    mut input: impl Write,
    bytes: Vec<u8>,
    _cancelled: Arc<AtomicBool>,
) -> io::Result<()> {
    // Windows anonymous-pipe writes are blocking through std. `run` bounds
    // this worker's join and reaps it if a descendant retains the pipe.
    input.write_all(&bytes)
}

pub fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if !output.status.success() {
        bail!("{action} failed with status {}", output.status);
    }
    Ok(())
}
pub fn terminal_safe(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|character| {
            matches!(character, '\n' | '\t')
                || (!character.is_control()
                    && !matches!(
                        character,
                        '\u{061c}'
                            | '\u{202a}'..='\u{202e}'
                            | '\u{2066}'..='\u{2069}'
                            | '\u{200e}'
                            | '\u{200f}'
                    ))
        })
        .collect()
}

/// Serialize JSON then remove terminal-active control and bidi characters.
pub fn terminal_safe_json(value: &impl serde::Serialize) -> Result<String> {
    let serialized = serde_json::to_string_pretty(value)?;
    Ok(terminal_safe(serialized.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(unix))]
    fn capped_reader_reports_truncation() {
        let (bytes, truncated) = read_capped(&b"12345"[..], 3).unwrap();
        assert_eq!(bytes, b"123");
        assert!(truncated);
    }

    #[cfg(windows)]
    #[test]
    fn blocked_worker_join_is_bounded_and_reaped() {
        let started = Instant::now();
        let worker = thread::spawn(|| {
            thread::sleep(Duration::from_secs(1));
            7_u8
        });

        let joined = join_thread_bounded(worker, "Windows pipe reader").unwrap();
        assert!(joined.is_none());
        assert!(started.elapsed() < Duration::from_millis(800));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn tracked_process_identity_mismatch_is_not_signalable() {
        let pid = libc::pid_t::try_from(std::process::id()).unwrap();
        let identity = process_identity(pid).expect("current process identity");
        let tracked = TrackedProcess {
            pid,
            identity: Some(identity ^ 1),
        };
        assert!(!tracked_process_identity_matches(tracked));
        assert!(tracked_process_identity_matches(TrackedProcess {
            pid,
            identity: Some(identity),
        }));
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn process_group_identity_mismatch_is_not_signalable() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        configure_process_tree(&mut command);
        let mut child = command.spawn().expect("spawn process-group probe");
        let pid = libc::pid_t::try_from(child.id()).unwrap();
        let identity = process_identity(pid).expect("child process identity");
        let mismatched = TrackedProcess {
            pid,
            identity: Some(identity ^ 1),
        };

        signal_process_group(child.id(), std::iter::once(mismatched), libc::SIGKILL);
        assert!(
            child.try_wait().unwrap().is_none(),
            "a mismatched process identity was signaled"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn terminal_text_drops_escape_and_bidi_controls() {
        assert_eq!(terminal_safe(b"safe\x1b[31mred\nnext"), "safe[31mred\nnext");
        assert_eq!(
            terminal_safe("left\u{061c}mark\u{202e}right".as_bytes()),
            "leftmarkright"
        );
    }

    #[test]
    fn terminal_safe_json_removes_bidi_controls_and_remains_parseable() {
        let value =
            serde_json::json!({"label": "left\u{061c}mark\u{202e}right\u{2066}hidden\u{2069}"});
        let output = terminal_safe_json(&value).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["label"], "leftmarkrighthidden");
        assert!(!output.contains('\u{061c}'));
        assert!(!output.contains('\u{202e}'));
        assert!(!output.contains('\u{2066}'));
        assert!(!output.contains('\u{2069}'));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_descendants_and_joins_pipe_readers() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("descendant-ran");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"(sleep 1; printf descendant > "$MARKER") & sleep 30"#,
            ])
            .env("MARKER", marker.as_os_str());

        let started = std::time::Instant::now();
        let result = run_with_limits(
            &mut command,
            Duration::from_millis(100),
            4096,
            "process-tree regression",
        );

        assert!(result.is_err(), "the child should exceed the deadline");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout cleanup exceeded the bound"
        );
        thread::sleep(Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "a descendant survived the timeout process-tree cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_deadline_caps_command_timeout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(50))
            .expect("short test deadline");
        let _guard = install_deadline(Some(deadline));

        let started = Instant::now();
        let result = run_with_limits(
            &mut command,
            Duration::from_secs(120),
            4096,
            "deadline regression",
        );

        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timeout_kills_late_spawned_setsid_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("late-descendant-ran");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"(sleep 30ms; setsid /bin/sh -c 'sleep 1; printf late > "$MARKER"') & sleep 30"#,
            ])
            .env("MARKER", marker.as_os_str());

        let result = run_with_limits(
            &mut command,
            Duration::from_millis(150),
            4096,
            "late process-tree regression",
        );

        assert!(result.is_err());
        thread::sleep(Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "a late-spawned setsid descendant survived cleanup"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn successful_root_preserves_escaped_daemon() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("successful-root-descendant-ran");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"setsid /bin/sh -c 'sleep 1; printf success > "$MARKER"' & sleep 30ms; exit 0"#,
            ])
            .env("MARKER", marker.as_os_str());

        let result = run_with_limits(
            &mut command,
            Duration::from_secs(2),
            4096,
            "successful process-tree regression",
        );

        assert!(result.is_ok());
        thread::sleep(Duration::from_millis(1200));
        assert!(
            marker.exists(),
            "a persistent escaped daemon was killed after successful cleanup"
        );
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn successful_root_preserves_process_group_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("successful-root-group-descendant-ran");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"(sleep 1; printf success > "$MARKER") & sleep 30ms; exit 0"#,
            ])
            .env("MARKER", marker.as_os_str());

        let result = run_with_limits(
            &mut command,
            Duration::from_secs(2),
            4096,
            "successful process-group regression",
        );

        assert!(result.is_ok());
        thread::sleep(Duration::from_millis(1200));
        assert!(
            marker.exists(),
            "a process-group descendant was killed after successful cleanup"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_libproc_descendant_snapshot_is_bounded_and_unique() {
        let mut descendants = Vec::new();
        collect_macos_descendants(std::process::id(), &mut descendants);
        assert!(descendants.len() <= MACOS_MAX_DESCENDANTS);
        for (index, pid) in descendants.iter().enumerate() {
            assert!(!descendants[..index].contains(pid));
            assert!(*pid > 1);
        }
    }
}
