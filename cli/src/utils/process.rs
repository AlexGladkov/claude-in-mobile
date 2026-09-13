use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use wait_timeout::ChildExt;

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
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to start {action}"))?;
    let stdout = child
        .stdout
        .take()
        .context("Child stdout was not captured")?;
    let stderr = child
        .stderr
        .take()
        .context("Child stderr was not captured")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, max_output_bytes));
    let stderr_reader = thread::spawn(move || read_capped(stderr, max_output_bytes));
    let input_writer = match input {
        Some(bytes) => {
            let mut stdin = child.stdin.take().context("Child stdin was not captured")?;
            Some(thread::spawn(move || stdin.write_all(&bytes)))
        }
        None => None,
    };

    let status = match child.wait_timeout(timeout) {
        Ok(Some(status)) => status,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{action} timed out");
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).with_context(|| format!("Failed while waiting for {action}"));
        }
    };
    if let Some(writer) = input_writer {
        writer
            .join()
            .map_err(|_| anyhow::anyhow!("{action} stdin writer failed"))??;
    }
    let (mut stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("{action} stdout reader failed"))??;
    let (mut stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("{action} stderr reader failed"))??;
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

fn read_capped(mut input: impl Read, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)> {
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
                        '\u{202a}'..='\u{202e}'
                            | '\u{2066}'..='\u{2069}'
                            | '\u{200e}'
                            | '\u{200f}'
                    ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_reader_reports_truncation() {
        let (bytes, truncated) = read_capped(&b"12345"[..], 3).unwrap();
        assert_eq!(bytes, b"123");
        assert!(truncated);
    }

    #[test]
    fn terminal_text_drops_escape_and_bidi_controls() {
        assert_eq!(terminal_safe(b"safe\x1b[31mred\nnext"), "safe[31mred\nnext");
        assert_eq!(terminal_safe("left\u{202e}right".as_bytes()), "leftright");
    }
}
