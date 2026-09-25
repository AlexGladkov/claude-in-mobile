use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use tempfile::{Builder, NamedTempFile, TempDir};

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("Cannot determine the user home directory")
}

pub(crate) fn create_private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            bail!(
                "Private state path is not a regular directory: {}",
                path.display()
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .with_context(|| format!("Cannot create private directory {}", path.display()))?;
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect private directory {}", path.display()));
        }
    }
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Cannot inspect private directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "Private state path is not a regular directory: {}",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || value == "."
        || value == ".."
    {
        bail!("Invalid {label}: use 1-128 ASCII letters, digits, '.', '_' or '-'");
    }
    Ok(())
}
pub fn app_dir() -> Result<PathBuf> {
    let path = home_dir()?.join(".claude-mobile");
    create_private_dir(&path)?;
    Ok(path)
}

pub fn state_dir(namespace: &str) -> Result<PathBuf> {
    validate_identifier(namespace, "state namespace")?;
    let root = app_dir()?.join("state");
    create_private_dir(&root)?;
    let path = root.join(namespace);
    create_private_dir(&path)?;
    Ok(path)
}

pub fn cache_dir(namespace: &str) -> Result<PathBuf> {
    validate_identifier(namespace, "cache namespace")?;
    let root = home_dir()?.join(".cache").join("mcp-devices");
    create_private_dir(&root)?;
    let path = root.join(namespace);
    create_private_dir(&path)?;
    Ok(path)
}

pub fn state_file(namespace: &str, name: &str, extension: &str) -> Result<PathBuf> {
    validate_identifier(name, "state name")?;
    validate_identifier(extension, "state extension")?;
    Ok(state_dir(namespace)?.join(format!("{name}.{extension}")))
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("Private state path has no parent")?;
    create_private_dir(parent)?;
    let mut temp = NamedTempFile::new_in(parent)
        .with_context(|| format!("Cannot create temporary state file in {}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(contents)?;
    temp.as_file_mut().sync_all()?;
    temp.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("Cannot atomically replace {}", path.display()))?;
    Ok(())
}

pub(crate) fn create_private_file_if_missing(
    path: &Path,
    contents: &[u8],
    label: &str,
) -> Result<bool> {
    let parent = path.parent().context("Private state path has no parent")?;
    create_private_dir(parent)?;
    let mut temp = NamedTempFile::new_in(parent)
        .with_context(|| format!("Cannot create temporary state file in {}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(contents)?;
    temp.as_file_mut().sync_all()?;
    match temp.persist_noclobber(path) {
        Ok(_) => Ok(true),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => {
            Err(error.error).with_context(|| format!("Cannot atomically create private {label}"))
        }
    }
}

/// Reject legacy import files that are not regular files owned by this user
/// with no group/world write permission.
///
/// Legacy state historically lived in shared temporary directories, so a
/// caller must not parse or import a file that another user can replace.
pub(crate) fn validate_legacy_file_security(
    path: &Path,
    metadata: &fs::Metadata,
    label: &str,
) -> Result<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("{label} is not a regular file: {}", path.display());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        // SAFETY: geteuid has no preconditions and only reads the process
        // credentials supplied by the operating system.
        let current_uid = unsafe { libc::geteuid() };
        if metadata.uid() != current_uid {
            bail!(
                "{label} is not owned by the current user: {}",
                path.display()
            );
        }
        if metadata.mode() & 0o022 != 0 {
            bail!(
                "{label} is group/world-writable and cannot be imported: {}",
                path.display()
            );
        }
    }

    Ok(())
}

fn open_readonly_no_follow(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
        .open(path)
        .with_context(|| format!("Cannot safely open {}", path.display()))
}

fn read_bounded_file_inner(
    path: &Path,
    max_bytes: u64,
    label: &str,
    validate_security: bool,
) -> Result<Vec<u8>> {
    if max_bytes == 0 {
        bail!("{label} size limit must be greater than zero");
    }
    let file = open_readonly_no_follow(path)?;
    let metadata = file
        .metadata()
        .with_context(|| format!("Cannot inspect {label} at {}", path.display()))?;
    if validate_security {
        validate_legacy_file_security(path, &metadata, label)?;
    }
    if !metadata.is_file() || metadata.len() > max_bytes {
        bail!("{label} is not a regular file or exceeds {max_bytes} bytes");
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut data)
        .with_context(|| format!("Cannot read {label} at {}", path.display()))?;
    if data.len() as u64 > max_bytes {
        bail!("{label} exceeds {max_bytes} bytes");
    }
    Ok(data)
}

pub fn read_bounded_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>> {
    read_bounded_file_inner(path, max_bytes, label, false)
}

pub(crate) fn read_bounded_legacy_file(
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>> {
    read_bounded_file_inner(path, max_bytes, label, true)
}

pub fn read_json_file<T: DeserializeOwned>(path: &Path, max_bytes: u64, label: &str) -> Result<T> {
    let data = read_bounded_file(path, max_bytes, label)?;
    serde_json::from_slice(&data).with_context(|| format!("Corrupt {label} at {}", path.display()))
}

pub fn private_temp_dir(prefix: &str) -> Result<TempDir> {
    validate_identifier(prefix, "temporary directory prefix")?;
    Builder::new()
        .prefix(&format!("mcp-devices-{prefix}-"))
        .tempdir()
        .context("Cannot create private temporary directory")
}

#[cfg(test)]

mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn legacy_file_security_rejects_group_or_world_writable_files() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.json");
        fs::write(&path, br#"{"ok":true}"#).unwrap();

        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(validate_legacy_file_security(&path, &metadata, "legacy file").is_err());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(validate_legacy_file_security(&path, &metadata, "legacy file").is_ok());
    }
    #[test]
    fn identifier_rejects_path_traversal() {
        for value in ["", ".", "..", "../escape", "a/b", "a\\b"] {
            assert!(
                validate_identifier(value, "test").is_err(),
                "accepted {value:?}"
            );
        }
        assert!(validate_identifier("release-4.4.0_test", "test").is_ok());
    }

    #[test]
    fn bounded_read_rejects_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.json");
        fs::write(&path, b"12345").unwrap();
        assert!(read_bounded_file(&path, 4, "test file").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_read_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        let link = directory.path().join("link.json");
        fs::write(&target, br#"{"secret":true}"#).unwrap();
        symlink(&target, &link).unwrap();

        assert!(read_bounded_file(&link, 1024, "test file").is_err());
    }
}
