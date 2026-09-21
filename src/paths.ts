import fs from 'fs';
import os from 'os';
import path from 'path';

// Darwin's sun_path is a 104-byte buffer including the trailing NUL.
export const DARWIN_UNIX_SOCKET_PATH_LIMIT = 103;

/** Create a private, per-action data directory for state and configuration. */
export function createUptermBaseDir(tempDir = os.tmpdir()): string {
  const parent = tempDir;
  const base = fs.mkdtempSync(path.join(parent, 'upterm-action-'));
  fs.chmodSync(base, 0o700);
  return base;
}

/**
 * Create the short private runtime root used for Upterm's AF_UNIX sockets.
 *
 * macOS limits Unix-domain socket paths to 103 bytes. A runner's os.tmpdir()
 * can contain a long /var/folders/... prefix, so keep this root under /tmp on
 * Unix while retaining the normal temp directory on Windows.
 */
export function createUptermRuntimeDir(platform = process.platform, tempDir = os.tmpdir()): string {
  const parent = platform === 'win32' ? tempDir : '/tmp';
  const runtime = fs.mkdtempSync(path.join(parent, 'upterm-runtime-'));
  fs.chmodSync(runtime, 0o700);
  return runtime;
}

export function getUptermAttachSocketPath(runtimeRoot: string, sessionName: string): string {
  return path.join(runtimeRoot, 'upterm', 'sessions', sessionName, 'attach.sock');
}
