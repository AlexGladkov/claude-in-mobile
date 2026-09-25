import { constants } from "node:fs";
import type { ReadStream, Stats } from "node:fs";
import {
  mkdtemp,
  open,
  lstat,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MobileError } from "../errors.js";

export type StoreArtifactPlatform = "android" | "ios";

export interface ValidatedStoreArtifact {
  /** Canonical path retained for file name and extension metadata. */
  path: string;
  /** Size observed from the opened descriptor, for upload metadata. */
  size: number;
  /** The descriptor whose identity and metadata were validated. */
  handle: FileHandle;
  /** A stream backed by the validated descriptor; never reopens `path`. */
  stream: ReadStream;
  /** Close the stream and descriptor. Safe to call more than once. */
  close(): Promise<void>;
}

export interface StagedStoreArtifact {
  /** Unique private snapshot file inside a private directory under the trusted root. */
  path: string;
  /** Number of bytes copied from the validated descriptor. */
  size: number;
  /** Remove the snapshot. Safe to call more than once. */
  remove(): Promise<void>;
}

export interface StoreMultipartField {
  name: string;
  value: string;
}

export interface StoreArtifactMultipartBody {
  body: ReadableStream;
  contentType: string;
  contentLength: number;
}

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;

function artifactError(code: string, message: string): never {
  throw new MobileError(message, code);
}

function isWithinRoot(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  if (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0) {
    return before.dev === after.dev && before.ino === after.ino;
  }
  return before.size === after.size
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.uid === after.uid
    && before.gid === after.gid
    && before.rdev === after.rdev
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.birthtimeMs === after.birthtimeMs;
}

function descriptorLinkPaths(fd: number): readonly string[] {
  if (process.platform === "win32") return [];
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return [`/dev/fd/${fd}`, `/proc/self/fd/${fd}`];
  }
  return [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`];
}

/**
 * Re-check the resolved path after opening. O_NOFOLLOW protects only the final
 * component, so a parent-directory replacement can otherwise redirect open().
 * POSIX descriptor links let us verify the object that was actually opened.
 * Windows has no equivalent cross-platform Node API; its post-open check below
 * still detects a parent redirect that remains in place, but cannot close a
 * replacement-and-restore race without a native openat-style primitive.
 */
async function assertOpenedPathWithinRoot(
  handle: FileHandle,
  canonicalPath: string,
  canonicalRoot: string,
  filePath: string,
): Promise<void> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(canonicalPath);
  } catch {
    throw new MobileError(
      `Upload artifact changed while opening: ${filePath}`,
      "STORE_ARTIFACT_CHANGED",
    );
  }
  if (!isWithinRoot(resolvedPath, canonicalRoot)) {
    throw new MobileError(
      `Upload artifact changed outside the trusted root: ${filePath}`,
      "STORE_ARTIFACT_OUTSIDE_ROOT",
    );
  }

  const linkPaths = descriptorLinkPaths(handle.fd);
  if (linkPaths.length === 0) return;
  let openedPath: string | undefined;
  for (const linkPath of linkPaths) {
    try {
      openedPath = await realpath(linkPath);
      break;
    } catch {
      // Try the other host-specific descriptor link before failing closed.
    }
  }
  if (!openedPath) {
    throw new MobileError(
      `Unable to verify upload artifact location: ${filePath}`,
      "STORE_ARTIFACT_UNREADABLE",
    );
  }
  if (!isWithinRoot(openedPath, canonicalRoot)) {
    throw new MobileError(
      `Upload artifact opened outside the trusted root: ${filePath}`,
      "STORE_ARTIFACT_OUTSIDE_ROOT",
    );
  }
}

/**
 * Validate and open a local store artifact before any credentials, network calls, or file streaming.
 *
 * The process working directory is the only trusted root. The final path must be a regular,
 * non-symlink file with the exact platform extension, and both lexical and canonical paths
 * must remain below that root. After opening, the descriptor's resolved location is checked
 * again where the host exposes a POSIX descriptor link. The returned stream is backed by the
 * descriptor whose metadata was checked, so callers never reopen the caller's untrusted spelling.
 */
export async function validateStoreArtifact(
  filePath: string,
  platform: StoreArtifactPlatform,
): Promise<ValidatedStoreArtifact> {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    artifactError("STORE_ARTIFACT_INVALID_PATH", "Upload artifact path must not be empty.");
  }
  if (CONTROL_CHARACTER_RE.test(filePath)) {
    artifactError("STORE_ARTIFACT_INVALID_PATH", "Upload artifact path contains control characters.");
  }
  // Reject traversal syntax before touching the filesystem. This intentionally retains the
  // existing path policy's conservative treatment of any `..` component/text.
  if (filePath.includes("..")) {
    artifactError(
      "PATH_TRAVERSAL_BLOCKED",
      "Path traversal blocked in upload artifact path.",
    );
  }

  const expectedExtensions = platform === "ios" ? [".ipa"] : [".apk", ".aab"];
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (!expectedExtensions.includes(extension)) {
    const expected = platform === "ios" ? ".ipa" : ".apk or .aab";
    artifactError(
      "STORE_ARTIFACT_INVALID_TYPE",
      `Upload artifact must have an ${expected} extension: ${filePath}`,
    );
  }

  const trustedRoot = resolve(process.cwd());
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(trustedRoot);
  } catch {
    artifactError("STORE_ARTIFACT_ROOT_UNAVAILABLE", "Trusted upload artifact root is unavailable.");
  }

  const lexicalPath = resolve(filePath);
  if (!isWithinRoot(lexicalPath, trustedRoot)) {
    artifactError(
      "STORE_ARTIFACT_OUTSIDE_ROOT",
      `Upload artifact is outside the trusted root: ${filePath}`,
    );
  }

  let metadata: Stats;
  try {
    metadata = await lstat(lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MobileError(`File not found: ${filePath}`, "STORE_ARTIFACT_NOT_FOUND");
    }
    throw new MobileError(`Unable to inspect upload artifact: ${filePath}`, "STORE_ARTIFACT_UNREADABLE");
  }

  if (metadata.isSymbolicLink()) {
    artifactError(
      "STORE_ARTIFACT_SYMLINK",
      `Upload artifact must not be a symbolic link: ${filePath}`,
    );
  }
  if (!metadata.isFile()) {
    artifactError(
      "STORE_ARTIFACT_NOT_REGULAR",
      `Upload artifact must be a regular file: ${filePath}`,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch {
    throw new MobileError(`Unable to resolve upload artifact: ${filePath}`, "STORE_ARTIFACT_UNREADABLE");
  }
  if (!isWithinRoot(canonicalPath, canonicalRoot)) {
    artifactError(
      "STORE_ARTIFACT_OUTSIDE_ROOT",
      `Upload artifact is outside the trusted root: ${filePath}`,
    );
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  let handle: FileHandle;
  try {
    // Open the canonical target itself. O_NOFOLLOW closes the final path-component
    // replacement race on platforms that support it; O_NONBLOCK avoids FIFO races.
    handle = await open(canonicalPath, constants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new MobileError(
        `Upload artifact must not be a symbolic link: ${filePath}`,
        "STORE_ARTIFACT_SYMLINK",
      );
    }
    if (code === "ENOENT") {
      throw new MobileError(`File not found: ${filePath}`, "STORE_ARTIFACT_NOT_FOUND");
    }
    throw new MobileError(`Unable to open upload artifact: ${filePath}`, "STORE_ARTIFACT_UNREADABLE");
  }

  try {
    const openedMetadata = await handle.stat();
    if (openedMetadata.isSymbolicLink()) {
      throw new MobileError(
        `Upload artifact must not be a symbolic link: ${filePath}`,
        "STORE_ARTIFACT_SYMLINK",
      );
    }
    if (!openedMetadata.isFile()) {
      throw new MobileError(
        `Upload artifact must be a regular file: ${filePath}`,
        "STORE_ARTIFACT_NOT_REGULAR",
      );
    }
    await assertOpenedPathWithinRoot(handle, canonicalPath, canonicalRoot, filePath);
    if (!sameFileIdentity(metadata, openedMetadata)) {
      throw new MobileError(
        `Upload artifact changed while opening: ${filePath}`,
        "STORE_ARTIFACT_CHANGED",
      );
    }

    const stream = handle.createReadStream({ autoClose: false });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const streamFinished = finished(stream).catch(() => {});
      stream.destroy();
      await streamFinished;
      await handle.close().catch(() => {});
    };

    return {
      path: canonicalPath,
      size: openedMetadata.size,
      handle,
      stream,
      close,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof MobileError) throw error;
    throw new MobileError(`Unable to inspect upload artifact: ${filePath}`, "STORE_ARTIFACT_UNREADABLE");
  }
}

const STAGED_ARTIFACT_PREFIX = ".mcp-store-upload-";
const STAGED_ARTIFACT_MODE = 0o600;

async function removeStagedSnapshot(root: string, filePath: string): Promise<void> {
  let firstError: unknown;
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    firstError = error;
  }
  try {
    await rmdir(root);
  } catch (error) {
    if (firstError === undefined) firstError = error;
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Copy the bytes from an already validated descriptor into a private snapshot.
 *
 * mkdtemp creates a 0700 directory under the trusted process root; the snapshot
 * file itself is created with 0600 permissions. This blocks other OS users from
 * replacing the pathname while validateIpa/uploadIpa are using it. Same-UID
 * code can still mutate a pathname, and xcrun accepts only a pathname rather
 * than a descriptor, so that limitation cannot be closed with Node's portable
 * filesystem APIs.
 */
export async function stageStoreArtifact(
  artifact: ValidatedStoreArtifact,
): Promise<StagedStoreArtifact> {
  const trustedRoot = resolve(process.cwd());
  let snapshotRoot: string | undefined;
  let output: FileHandle | undefined;
  let committed = false;

  try {
    const privateRoot = await mkdtemp(
      join(trustedRoot, `${STAGED_ARTIFACT_PREFIX}${randomUUID()}-`),
    );
    snapshotRoot = privateRoot;
    const stagedPath = join(privateRoot, "artifact.ipa");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    output = await open(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      STAGED_ARTIFACT_MODE,
    );

    let copiedBytes = 0;
    for await (const chunk of artifact.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let writtenBytes = 0;
      while (writtenBytes < buffer.byteLength) {
        const result = await output.write(
          buffer,
          writtenBytes,
          buffer.byteLength - writtenBytes,
        );
        if (result.bytesWritten === 0) {
          throw new MobileError(
            "Unable to stage upload artifact.",
            "STORE_ARTIFACT_SNAPSHOT_FAILED",
          );
        }
        writtenBytes += result.bytesWritten;
      }
      copiedBytes += buffer.byteLength;
    }

    if (copiedBytes !== artifact.size) {
      throw new MobileError(
        "Upload artifact changed while staging.",
        "STORE_ARTIFACT_CHANGED",
      );
    }
    await output.sync();
    await output.close();
    output = undefined;
    committed = true;

    let removed = false;
    return {
      path: stagedPath,
      size: copiedBytes,
      remove: async () => {
        if (removed) return;
        await removeStagedSnapshot(privateRoot, stagedPath);
        removed = true;
      },
    };
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError(
      "Unable to stage upload artifact.",
      "STORE_ARTIFACT_SNAPSHOT_FAILED",
    );
  } finally {
    await output?.close().catch(() => {});
    if (!committed && snapshotRoot) {
      await removeStagedSnapshot(
        snapshotRoot,
        join(snapshotRoot, "artifact.ipa"),
      ).catch(() => {});
    }
  }
}

/**
 * Build a streaming multipart request whose file part reads only from the
 * descriptor already validated by validateStoreArtifact.
 */
export function createStoreArtifactMultipartBody(
  artifact: ValidatedStoreArtifact,
  fileName: string,
  fields: readonly StoreMultipartField[],
): StoreArtifactMultipartBody {
  const boundary = `----mcp-devices-${randomUUID()}`;
  const escapedFileName = fileName.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${escapedFileName}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n";
  const fieldBodies = fields.map((field) => {
    const escapedName = field.name.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
    return (
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapedName}"\r\n\r\n` +
      `${field.value}\r\n`
    );
  });
  const closingBoundary = `--${boundary}--\r\n`;
  const contentLength = Buffer.byteLength(fileHeader)
    + artifact.size
    + Buffer.byteLength("\r\n")
    + fieldBodies.reduce((total, fieldBody) => total + Buffer.byteLength(fieldBody), 0)
    + Buffer.byteLength(closingBoundary);
  const multipart = Readable.from((async function* () {
    yield Buffer.from(fileHeader);
    for await (const chunk of artifact.stream) {
      yield chunk;
    }
    yield Buffer.from("\r\n");
    for (const fieldBody of fieldBodies) {
      yield Buffer.from(fieldBody);
    }
    yield Buffer.from(closingBoundary);
  })());

  return {
    body: Readable.toWeb(multipart),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
  };
}
