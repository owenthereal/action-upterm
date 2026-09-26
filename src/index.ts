import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import {execShellCommand, shellEscape, sleep} from './helpers';
import {generateSessionName, getSession, hasGuestJoined, isNoSuchSession, isTerminal, isUptermVersionSupported, parseUptermVersion, parseSessionInfo, SessionInfo, formatVersion, UPTERM_MIN_VERSION} from './session';

// Constants
const UPTERM_RELEASE_BASE_URL = 'https://github.com/owenthereal/upterm/releases';
const SESSION_STATUS_POLL_INTERVAL = 5000;
// Consecutive failed lookups between warnings, ~1 minute at the 5s poll
// interval. The first failure always warns.
const UNKNOWN_POLL_WARN_INTERVAL = 12;
const SUPPORTED_UPTERM_ARCHITECTURES = ['amd64', 'arm64'] as const;

// Continue file paths - users can touch either location to exit the session
// /continue may require sudo, but $GITHUB_WORKSPACE/continue never does
const CONTINUE_FILE_PATHS = {
  win32: 'C:/msys64/continue',
  unix: '/continue'
} as const;

// Deterministic directories for all upterm-related files in CI environments.
// We explicitly set these to ensure upterm and our action create files in
// predictable, writable locations across all platforms. This avoids issues
// where platform defaults (e.g., /run/user/<uid> on Linux) don't exist or
// aren't writable in CI environments like GitHub Actions.

interface UptermDirs {
  base: string;
  runtime: string;
  state: string;
  config: string;
}

// Cache for getUptermDirs() to avoid repeated path computation
let uptermDirsCache: UptermDirs | null = null;

// upterm refuses any socket path longer than this many bytes, on every platform
// (host/sessiondir/sessiondir.go:87, `maxSocketPath = 103`). The path it
// measures is $XDG_RUNTIME_DIR/upterm/sessions/<name>/attach.sock
// (utils/utils.go:43,84-86 append `upterm`; sessiondir.go:154-160
// CheckSocketPath), and it measures it while validating `upterm host --name`
// (cmd/upterm/command/host.go:320-331) - so an over-long root makes
// `upterm host` exit immediately, before any session record exists.
const UPTERM_MAX_SOCKET_PATH = 103;
// Kept short on purpose: every byte here comes out of the socket budget above.
const RUNTIME_DIR_PREFIX = 'upterm-rt-';
// fs.mkdtempSync appends exactly six characters to its prefix.
const MKDTEMP_SUFFIX_PLACEHOLDER = 'XXXXXX';

/**
 * Root for this run's base directory (state, config, timeout flag).
 *
 * The base directory holds no sockets, so its length does not matter.
 * RUNNER_TEMP is reaped by the runner per job.
 */
function tempRoot(): string {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

/** The attach socket path upterm will measure if the runtime dir is created under `root`. */
function runtimeSocketPath(root: string, sessionName: string): string {
  return path.join(root, `${RUNTIME_DIR_PREFIX}${MKDTEMP_SUFFIX_PLACEHOLDER}`, 'upterm', 'sessions', sessionName, 'attach.sock');
}

/**
 * Root for this run's runtime directory (XDG_RUNTIME_DIR, which holds upterm's
 * sockets): the first candidate whose socket path fits upterm's budget.
 *
 * This deliberately departs from the design spec, which said no action-side
 * length check was needed because upterm's own check reports it better. That
 * reasoning assumed the user picks the root. The action does: it overrides
 * XDG_RUNTIME_DIR, so a runner whose RUNNER_TEMP is too long - GitHub's default
 * self-hosted layout, ~/actions-runner/_work/_temp, under a long user name -
 * could never start a session, and the user could not fix it.
 *
 * /tmp is the last resort, non-Windows only. It is reached only when both
 * preferred roots are too long. Unlike RUNNER_TEMP it is not reaped by the
 * runner, so the directory is removed only if the post step runs - a cancelled
 * job leaves it behind. If /tmp is unwritable, mkdtempSync fails with a clear
 * error.
 */
function runtimeRoot(sessionName: string): string {
  const runnerTemp = process.env.RUNNER_TEMP;
  const candidates = [...new Set([runnerTemp, os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].filter((c): c is string => !!c))];
  const tooLong: string[] = [];

  for (const candidate of candidates) {
    const socketPath = runtimeSocketPath(candidate, sessionName);
    // Bytes, not characters: upterm compares len() of a Go string.
    const bytes = Buffer.byteLength(socketPath);
    if (bytes > UPTERM_MAX_SOCKET_PATH) {
      tooLong.push(`${socketPath} is ${bytes} bytes`);
      continue;
    }
    if (candidate !== runnerTemp) {
      const why = tooLong.length ? `${tooLong.join('; ')}, over upterm's ${UPTERM_MAX_SOCKET_PATH}-byte socket path limit` : 'RUNNER_TEMP is not set';
      core.info(`Using ${candidate} for upterm's runtime directory: ${why}`);
    }
    return candidate;
  }

  throw new Error(
    `Cannot create upterm's runtime directory: every candidate gives a socket path over upterm's ${UPTERM_MAX_SOCKET_PATH}-byte limit (${tooLong.join('; ')}). ` +
      'Use a shorter runner work folder (it contains RUNNER_TEMP), or on Windows point TMP/TEMP at a shorter directory.'
  );
}

function createPrivateDir(root: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function getUptermDirs(): UptermDirs {
  if (uptermDirsCache) {
    return uptermDirsCache;
  }

  // The post process is a separate Node process: it restores what main saved
  // rather than minting fresh directories that would point nowhere.
  const savedBase = core.getState('uptermBaseDir');
  const savedRuntime = core.getState('uptermRuntimeDir');

  // Each directory is saved as soon as it exists: runtimeRoot() can throw, and
  // the post step can only remove a base directory it was told about.
  const base = savedBase || createPrivateDir(tempRoot(), 'upterm-action-');
  if (!savedBase) core.saveState('uptermBaseDir', base);
  // getSessionName() is memoized, so the name measured here is the one passed
  // to `upterm host --name`.
  const runtime = savedRuntime || createPrivateDir(runtimeRoot(getSessionName()), RUNTIME_DIR_PREFIX);
  if (!savedRuntime) core.saveState('uptermRuntimeDir', runtime);

  const state = path.join(base, 'state');
  uptermDirsCache = {
    base,
    runtime, // XDG_RUNTIME_DIR - for sockets
    state, // XDG_STATE_HOME - for upterm's session records and logs
    config: path.join(base, 'config') // XDG_CONFIG_HOME
  };
  return uptermDirsCache;
}

// Cache for getSessionName(); the name must be identical for every call within
// a process, and identical across main and post.
let sessionNameCache: string | null = null;

/**
 * This run's session name.
 *
 * Minted once in main and saved as state, so the post process - a separate Node
 * process - addresses the same session rather than inventing a new name that
 * matches nothing.
 */
function getSessionName(): string {
  if (sessionNameCache) return sessionNameCache;
  const saved = core.getState('sessionName');
  sessionNameCache = saved || generateSessionName();
  if (!saved) core.saveState('sessionName', sessionNameCache);
  return sessionNameCache;
}

/** The XDG values in the form upterm and the shell expect them. */
interface XdgPaths {
  runtime: string;
  state: string;
  config: string;
}

/**
 * Export XDG_* to this process so the action's own `upterm session info` calls
 * resolve the same session record the host published to, and return the
 * converted values for anyone who needs to write them somewhere else.
 *
 * upterm finds a session's record through XDG_STATE_HOME
 * (cmd/upterm/command/session.go:425). execShellCommand inherits process.env
 * on both platforms (see its spawn call), so one assignment covers every call
 * site, in main and in post alike.
 *
 * The conversion lives here and only here. XDG_STATE_HOME must agree exactly
 * between the host process (which publishes the record) and every query (which
 * resolves it); a second copy of `win32 ? toMsys2Path : toShellPath` elsewhere
 * would agree only by coincidence, and diverge silently - on one platform only
 * - the first time either copy is edited.
 */
function exportXdgEnvironment(): XdgPaths {
  const dirs = getUptermDirs();
  // On Windows this is POSIX-style (/c/Users/... not C:/Users/...) not because
  // upterm.exe itself expects that - it's a native executable - but because
  // MSYS2's bash converts POSIX-style env values to Windows form automatically
  // when it launches a native child process. Every upterm call goes through
  // bash for exactly that reason.
  const convert = process.platform === 'win32' ? toMsys2Path : toShellPath;
  const xdg: XdgPaths = {
    runtime: convert(dirs.runtime),
    state: convert(dirs.state),
    config: convert(dirs.config)
  };

  process.env.XDG_RUNTIME_DIR = xdg.runtime;
  process.env.XDG_STATE_HOME = xdg.state;
  process.env.XDG_CONFIG_HOME = xdg.config;

  return xdg;
}

// Utility Functions

/**
 * Convert path to forward slashes for shell use.
 * Keeps Windows drive letter format (C:/) for native Windows executables.
 *
 * Use this for:
 * - Paths passed to native Windows executables (upterm.exe)
 * - Paths used in MSYS2 bash commands (works with both formats)
 * - SSH key generation paths
 * - Tmux config paths when invoked from bash
 *
 * @example
 * // On Windows:
 * toShellPath('C:\\Users\\foo\\bar') // => 'C:/Users/foo/bar'
 * // On Unix:
 * toShellPath('/home/foo/bar')       // => '/home/foo/bar'
 *
 * @param filePath - The file path to convert
 * @returns Path with forward slashes, preserving Windows drive format
 */
function toShellPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Convert Windows path to MSYS2/Cygwin POSIX-style path.
 * Transforms C:/Users/... into /c/Users/...
 *
 * Use this for:
 * - XDG environment variables (XDG_RUNTIME_DIR, XDG_STATE_HOME, etc.)
 * - A path handed to a bash command that will itself launch a native Windows
 *   child process (e.g. the `cp` source path when copying upterm.exe into
 *   MSYS2's /usr/bin) - MSYS2's bash converts it to Windows form
 *   automatically for that child, so the value bash itself sees must be
 *   POSIX-style
 *
 * @example
 * // On Windows:
 * toMsys2Path('C:\\Users\\foo\\bar') // => '/c/Users/foo/bar'
 * toMsys2Path('C:/Users/foo/bar')    // => '/c/Users/foo/bar'
 * // On Unix (no transformation):
 * toMsys2Path('/home/foo/bar')       // => '/home/foo/bar'
 *
 * @param filePath - The file path to convert
 * @returns POSIX-style path on Windows, unchanged on Unix
 */
function toMsys2Path(filePath: string): string {
  let result = filePath.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    result = result.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  }
  return result;
}

type UptermArchitecture = (typeof SUPPORTED_UPTERM_ARCHITECTURES)[number];

export function getUptermArchitecture(nodeArch: string): UptermArchitecture | null {
  switch (nodeArch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}

function validateArchitecture(arch: string): UptermArchitecture {
  const uptermArch = getUptermArchitecture(arch);
  if (!uptermArch) {
    throw new Error(`Unsupported architecture for upterm: ${arch}. Only x64 and arm64 are supported.`);
  }
  return uptermArch;
}

export function getUptermDownloadUrl(platform: 'linux' | 'darwin' | 'win32', nodeArch: string): string {
  const uptermArch = validateArchitecture(nodeArch);
  const artifactPlatformMap: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows'
  };
  const artifactPlatform = artifactPlatformMap[platform];
  const filename = `upterm_${artifactPlatform}_${uptermArch}.tar.gz`;

  const versionInput = core.getInput('upterm-version');
  const version = versionInput?.trim();
  const versionSegment = version ? `download/${version}` : 'latest/download';
  const url = `${UPTERM_RELEASE_BASE_URL}/${versionSegment}/${filename}`;

  core.debug(`Upterm download URL resolved to ${url}`);
  return url;
}

function validateInputs(): void {
  const waitTimeout = core.getInput('wait-timeout-minutes');
  if (waitTimeout) {
    const parsedTimeout = parseInt(waitTimeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout < 0 || parsedTimeout > 1440 || !Number.isInteger(parsedTimeout)) {
      throw new Error('wait-timeout-minutes must be a valid positive integer not exceeding 1440 (24 hours)');
    }
  }

  const uptermServer = core.getInput('upterm-server');
  if (!uptermServer) {
    throw new Error('upterm-server is required');
  }
}

export async function run() {
  try {
    // Check if this is the POST action
    if (core.getState('isPost') === 'true') {
      await runPost();
      return;
    }

    validateInputs();

    // Mark that the main action has run (for POST action detection)
    // This must happen before any fallible setup so the post action
    // always runs cleanup instead of re-entering the main path.
    core.saveState('isPost', 'true');

    await installDependencies();
    await assertSupportedUptermVersion();
    const session = await startUptermSession();

    if (core.getInput('detached') === 'true') {
      await runDetachedMode(session);
      return;
    }

    await waitForSession(attachedTimeoutSeconds(), `SSH: ${session.sshCommand}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

async function installDependencies(): Promise<void> {
  core.debug('Installing dependencies');
  const platformHandlers = {
    linux: async () => {
      const archiveUrl = getUptermDownloadUrl('linux', process.arch);
      const archive = await tc.downloadTool(archiveUrl);
      const extractDir = await tc.extractTar(archive);
      const uptermPath = path.join(extractDir, 'upterm');

      if (!fs.existsSync(uptermPath)) {
        throw new Error(`Downloaded upterm archive does not contain binary at expected path: ${uptermPath}`);
      }

      core.addPath(extractDir);
    },
    win32: async () => {
      const archiveUrl = getUptermDownloadUrl('win32', process.arch);
      const archive = await tc.downloadTool(archiveUrl);
      const extractDir = await tc.extractTar(archive);
      const uptermExePath = path.join(extractDir, 'upterm.exe');

      if (!fs.existsSync(uptermExePath)) {
        throw new Error(`Downloaded upterm archive does not contain upterm.exe at expected path: ${uptermExePath}`);
      }

      core.addPath(extractDir);

      // core.addPath only puts the tool-cache dir on the Node process PATH and
      // on subsequent (non-MSYS2) steps via GITHUB_PATH. The interactive SSH
      // session spawns bash login shells that re-source /etc/profile with the
      // default MSYS2_PATH_TYPE=minimal, which rebuilds PATH and drops that
      // tool-cache dir - so upterm would be missing once the user connects.
      // /usr/bin is always on the minimal MSYS2 PATH (it's where bash lives),
      // so copy the binary there to guarantee it resolves in every MSYS2
      // context. Done via bash `cp` so /usr/bin tracks whichever MSYS2 root
      // the shell uses rather than a hardcoded location.
      await execShellCommand(`cp ${shellEscape(toMsys2Path(uptermExePath))} /usr/bin/upterm.exe`);
    },
    darwin: async () => {
      const archiveUrl = getUptermDownloadUrl('darwin', process.arch);
      const archive = await tc.downloadTool(archiveUrl);
      const extractDir = await tc.extractTar(archive);
      const uptermPath = path.join(extractDir, 'upterm');

      if (!fs.existsSync(uptermPath)) {
        throw new Error(`Downloaded upterm archive does not contain binary at expected path: ${uptermPath}`);
      }

      core.addPath(extractDir);
    }
  };

  const handler = platformHandlers[process.platform as keyof typeof platformHandlers];
  if (!handler) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  try {
    await handler();
    core.debug('Installed dependencies successfully');
  } catch (error) {
    // Installation is the same on every platform: download the upterm release
    // tarball from GitHub and extract it (Windows also copies upterm.exe into
    // MSYS2's /usr/bin so it's on the hosted login shell's PATH). No apt-get,
    // Homebrew or pacman is involved - those were tmux-era guidance.
    const platformGuidance: Record<string, string> = {
      linux: 'Ensure this runner can reach GitHub releases (github.com) to download and extract the upterm tarball',
      darwin: 'Ensure this runner can reach GitHub releases (github.com) to download and extract the upterm tarball',
      win32: "Ensure this runner can reach GitHub releases (github.com) to download upterm.exe, and that it can be copied into MSYS2's /usr/bin"
    };
    const guidance = platformGuidance[process.platform] || '';
    throw new Error(`Failed to install dependencies on ${process.platform}: ${error}\n\n` + (guidance ? `Tip: ${guidance}` : ''));
  }
}

/**
 * Refuse to run against an upterm older than v0.31.0.
 *
 * v0.31.0 is the first upterm that publishes firstGuestJoinedAt. v2 decides
 * whether to stop an unanswered session from this field, and an older upterm
 * always omits it, which would read as "nobody joined" and stop a session
 * somebody is in. Older versions are refused, not guessed at - including a
 * version string that cannot be parsed, which v1 only warned about.
 */
async function assertSupportedUptermVersion(): Promise<void> {
  let output: string;
  try {
    output = await execShellCommand('upterm version');
  } catch (error) {
    throw new Error(`Failed to check the installed upterm version: ${error}\n\nEnsure upterm was installed successfully and is executable on PATH.`);
  }

  const version = parseUptermVersion(output);
  const floor = formatVersion(UPTERM_MIN_VERSION);

  // Refused, not warned about: v2 decides whether to stop a session from a
  // field older upterms never publish, and an unknown version is an unknown
  // answer to "can this upterm say whether anyone joined?".
  if (!version) {
    throw new Error(`Could not determine the installed upterm version from: ${output.trim()}. action-upterm v2 requires upterm >= ${floor}.`);
  }

  if (!isUptermVersionSupported(version)) {
    throw new Error(`action-upterm v2 requires upterm >= ${floor} (found ${formatVersion(version)}). ` + `Remove the upterm-version input to use the latest release, or pin owenthereal/action-upterm@v1 to keep using an older upterm.`);
  }
}

function getAllowedUsers(): string[] {
  const allowedUsers = core
    .getInput('limit-access-to-users')
    .split(/[\s\n,]+/)
    .filter(Boolean);

  if (core.getInput('limit-access-to-actor') === 'true') {
    core.info(`Adding actor "${github.context.actor}" to allowed users.`);
    allowedUsers.push(github.context.actor);
  }

  return [...new Set(allowedUsers)];
}

/**
 * The command the session hosts, as a CLI suffix. Unix: none, so upterm runs
 * $SHELL. Windows: MSYS2's login bash - what v1's tmux ran - found as
 * /usr/bin/bash because this command line is run by MSYS2 bash.
 */
function hostedCommand(): string {
  return process.platform === 'win32' ? ' -- bash -l' : '';
}

/**
 * Start this run's session in the background and return what upterm reports
 * for it.
 *
 * `upterm host --detach` returns only once the daemon has started the command
 * and written the ready record, so its JSON - the same shape `session info -o
 * json` prints - is already a usable session: no readiness polling. The daemon
 * outlives this step on every platform without help (see the Windows notes in
 * ARCHITECTURE.md), and the runner's orphan sweep reaps it at the end of the job.
 */
async function launchSession(uptermServer: string, allowedUsers: string[]): Promise<SessionInfo> {
  const dirs = getUptermDirs();
  fs.mkdirSync(dirs.runtime, {recursive: true});
  fs.mkdirSync(dirs.state, {recursive: true});
  fs.mkdirSync(dirs.config, {recursive: true});
  exportXdgEnvironment();

  const auth = allowedUsers.map(user => ` --authorized-user ${shellEscape(`github:${user}`)}`).join('');
  // getSessionName() is gha- + 8 hex characters: shell-safe by construction.
  const cmd = `upterm host --detach --accept --output json --name ${getSessionName()} --skip-host-key-check --server ${shellEscape(uptermServer)}${auth}${hostedCommand()}`;

  core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);
  // Evidence for the post step that there may be a session to stop. Saved
  // before the launch: a launch that fails half way can still leave one.
  core.saveState('sessionStarted', 'true');

  let output: string;
  try {
    output = await execShellCommand(cmd, {quiet: true});
  } catch (error) {
    throw new Error(`Failed to start the upterm session: ${error}\n\n${await collectDiagnostics()}`);
  }

  const session = parseSessionInfo(output);
  // A terminal status must fail even with an sshCommand: upterm's printStarted
  // can report "disconnected" - the record's status the instant the tunnel
  // dropped - alongside a claim captured moments earlier that still carries an
  // sshCommand. A connect string for a session already gone can never connect.
  if (isTerminal(session.status) || !session.sshCommand) {
    throw new Error(await collectDiagnostics(session));
  }
  return session;
}

/**
 * Build the readiness-failure report.
 *
 * Takes the session readiness last observed, when its last poll saw one: a
 * second lookup could disagree with the one that decided to give up. Falls
 * back to a fresh lookup otherwise.
 */
async function collectDiagnostics(observed?: SessionInfo): Promise<string> {
  const dirs = getUptermDirs();
  const name = getSessionName();

  let lookupFailure = '';
  const session =
    observed ??
    (await getSession(name).catch(error => {
      lookupFailure = `- Session lookup failed: ${error}\n`;
      return null;
    }));

  // A session that ended is not one that was slow: a misconfigured
  // upterm-server ends it on the first poll, with retries to spare.
  const headline = session && isTerminal(session.status) ? `Upterm session ended before it became ready (status: ${session.status}).` : 'Upterm did not start a usable session.';
  let diagnostics = `${headline}\n\nDiagnostics:\n`;

  diagnostics += `- Upterm data directory: ${dirs.base}\n`;
  diagnostics += `- Session name: ${name}\n`;
  diagnostics += lookupFailure;

  diagnostics += `- Session status: ${session ? session.status : 'no session record found'}\n`;
  // Only meaningful for a session that should still be answering: a terminal
  // one has no admin socket left to query, so the absence of live detail there
  // is expected, not a failure.
  if (session && !isTerminal(session.status) && !session.hasLiveDetail) diagnostics += '- Upterm answered from its record only; its admin query did not succeed\n';
  if (session?.reason) diagnostics += `- Reason: ${session.reason}\n`;
  if (session?.exitCode !== undefined) diagnostics += `- Exit code: ${session.exitCode}\n`;
  if (session?.signal) diagnostics += `- Signal: ${session.signal}\n`;

  // upterm writes its log under XDG_STATE_HOME, not the runtime dir - the old
  // path never existed, so this section was always silently omitted.
  //
  // Guarded: an unreadable log must cost only its own section. Unguarded, the
  // error escapes this function and replaces the entire report.
  if (session?.logPath && fs.existsSync(session.logPath)) {
    try {
      diagnostics += `- Upterm log:\n${fs.readFileSync(session.logPath, 'utf8')}\n`;
    } catch (error) {
      diagnostics += `- Could not read upterm log (${session.logPath}): ${error}\n`;
    }
  }

  // Check if upterm is in PATH
  try {
    const uptermVersion = await execShellCommand('upterm version 2>&1 || echo "upterm not found in PATH"');
    diagnostics += `- Upterm binary check: ${uptermVersion.trim()}\n`;
  } catch (error) {
    diagnostics += `- Could not check upterm binary: ${error}\n`;
  }

  // Check environment
  const xdgPathConverter = process.platform === 'win32' ? toMsys2Path : toShellPath;
  diagnostics += `- XDG_RUNTIME_DIR (passed to upterm): ${xdgPathConverter(dirs.runtime)}\n`;
  diagnostics += `- XDG_RUNTIME_DIR (actual directory): ${dirs.runtime}\n`;
  diagnostics += `- USER: ${process.env.USER || 'not set'}\n`;
  diagnostics += `- UID: ${process.getuid ? process.getuid() : 'unknown'}\n`;
  diagnostics += `- Platform: ${process.platform}\n`;

  diagnostics += '\n=== Troubleshooting Steps ===\n';
  diagnostics += '1. Check upterm is installed and in PATH\n';
  diagnostics += '2. Verify upterm-server setting is correct\n';
  diagnostics += '3. Check network connectivity to upterm server\n';
  diagnostics += '4. Review the logs above for specific error messages\n';
  diagnostics += '5. On Windows: Verify MSYS2 environment is working\n';

  diagnostics += '\nPlease report this issue with the above diagnostics at: https://github.com/owenthereal/action-upterm/issues';
  return diagnostics;
}

/**
 * One lookup per poll.
 *
 * Three outcomes, deliberately distinct. Collapsing 'unknown' into 'gone'
 * would make a transient registry hiccup end a live debugging session - the
 * exact failure this whole change exists to remove.
 */
type PollResult = {kind: 'session'; session: SessionInfo} | {kind: 'gone'} | {kind: 'unknown'};

/**
 * Consecutive failed lookups, reset by the first success.
 *
 * 'unknown' deliberately exits nothing and spends no countdown, so a lookup
 * that fails on EVERY iteration leaves a loop with no exit and a log that
 * repeats the same unchanging number. Warning makes that visible to a human who
 * can act on it; the deferral itself is not negotiable, because spending the
 * countdown on an unknown can shut down a session a developer is attached to.
 */
let consecutiveUnknownPolls = 0;

async function pollSession(): Promise<PollResult> {
  try {
    const session = await getSession(getSessionName());
    consecutiveUnknownPolls = 0;
    return session ? {kind: 'session', session} : {kind: 'gone'};
  } catch (error) {
    consecutiveUnknownPolls++;
    // Warn on the first failure, then roughly once a minute. core.debug alone is
    // invisible at default verbosity, which is how this failure mode stayed
    // silent.
    if (consecutiveUnknownPolls === 1 || consecutiveUnknownPolls % UNKNOWN_POLL_WARN_INTERVAL === 0) {
      core.warning(`Could not query the upterm session (attempt ${consecutiveUnknownPolls}): ${error}. Still waiting; the session may still be live.`);
    } else {
      core.debug(`Session lookup failed, treating as unknown: ${error}`);
    }
    return {kind: 'unknown'};
  }
}

async function outputSshCommand(session: SessionInfo): Promise<string | null> {
  const sshCommand = session.sshCommand;
  if (!sshCommand) {
    core.warning('Upterm reported a session without an SSH command');
    return null;
  }

  core.setOutput('ssh-command', sshCommand);
  core.info(`SSH command available as output: ${sshCommand}`);
  // The job summary is a convenience. write() throws when GITHUB_STEP_SUMMARY
  // is unset (older GHES, some runner setups), and that must not fail a
  // session that is already up.
  try {
    await core.summary.addHeading('Upterm SSH Connection').addCodeBlock(sshCommand, 'bash').addRaw(`\n\nConnect with: <code>${sshCommand}</code>`).write();
  } catch (error) {
    core.debug(`Could not write the job summary: ${error}`);
  }
  return sshCommand;
}

async function startUptermSession(): Promise<SessionInfo> {
  const session = await launchSession(core.getInput('upterm-server'), getAllowedUsers());
  await outputSshCommand(session);
  return session;
}

/** Log the end of a session, distinguishing an unreachable one from an exit. */
function logSessionEnded(session: SessionInfo): void {
  if (session.status === 'disconnected') {
    // Unrecoverable in 0.30: the host keeps running but its connect string
    // cannot connect (cmd/upterm/command/session.go:469-476).
    core.warning('upterm lost its connection to the server; this session can no longer be reached');
    return;
  }
  core.info("Exiting debugging session: 'upterm' quit");
  if (session.reason && session.reason !== 'unknown') core.info(`Reason: ${session.reason}`);
  if (session.exitCode !== undefined) core.info(`Exit code: ${session.exitCode}`);
  if (session.signal) core.info(`Signal: ${session.signal}`);
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? CONTINUE_FILE_PATHS.win32 : CONTINUE_FILE_PATHS.unix;
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

/**
 * Ask upterm to end this run's session. Never throws: it is called from the
 * countdown, from teardown and from a signal handler, and in none of them may
 * upterm's own exit code, or a transient failure, fail the job.
 *
 * `session stop` itself exits 0 and prints "has already ended" for a session
 * whose record is still there but no longer held (an ordinary completed
 * session); it exits 4 only when no record exists at all - which a launch
 * that failed before any record was written, or a fully reaped session, both
 * produce. That case is expected, not a failure: treated as a quiet no-op
 * (core.debug), exactly as getSession() does for lookups.
 */
async function stopSession(): Promise<void> {
  const name = getSessionName();
  try {
    // Unescaped, as in the launch: generateSessionName() yields gha- + 8 hex
    // characters, shell-safe by construction.
    await execShellCommand(`upterm session stop ${name}`, {quiet: true});
  } catch (error) {
    if (isNoSuchSession(error)) {
      core.debug(`upterm session ${name} was never started or is already fully gone: ${error}`);
      return;
    }
    core.warning(`Could not stop upterm session ${name}: ${error}`);
  }
}

/** wait-timeout-minutes in attached mode: null when unset, so the wait is unbounded. */
function attachedTimeoutSeconds(): number | null {
  const input = core.getInput('wait-timeout-minutes');
  return input ? parseInt(input, 10) * 60 : null;
}

/** wait-timeout-minutes in detached mode's post step: 10 minutes when unset, as in v1. */
function detachedTimeoutSeconds(): number {
  const minutes = parseInt(core.getInput('wait-timeout-minutes') || '10', 10);
  return (isNaN(minutes) || minutes <= 0 ? 10 : minutes) * 60;
}

type WaitEnd = 'continue' | 'ended' | 'timeout';

/**
 * Wait for this run's session to end, for the continue file, or - while no guest
 * has ever joined - for the countdown to run out, in which case the session is
 * stopped.
 *
 * "Has a guest ever joined" is upterm's firstGuestJoinedAt, never guestCount:
 * the daemon records it from its own join events, so a guest who came and went
 * between two polls, or during the build before the post step began, is not
 * missed, and forwarding-only connections - which guestCount includes - do not
 * count. Once seen, the countdown is disarmed for the rest of the session.
 *
 * Only a lookup that succeeded spends the countdown. A failed one ('unknown')
 * says nothing about who is there, and spending time on it could stop a session
 * somebody is in.
 */
async function waitForSession(timeoutSeconds: number | null, message: string): Promise<WaitEnd> {
  let remaining = timeoutSeconds;
  let joined = false;
  const noteJoin = (session: SessionInfo) => {
    if (joined || !hasGuestJoined(session)) return;
    joined = true;
    core.info(`A guest joined at ${session.firstGuestJoinedAt}; the session stays up until it ends`);
  };

  /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
  while (true) {
    if (continueFileExists()) {
      core.info("Exiting debugging session because '/continue' file was created");
      return 'continue';
    }

    const poll = await pollSession();
    if (poll.kind === 'gone') {
      core.info("Exiting debugging session: 'upterm' quit");
      return 'ended';
    }
    if (poll.kind === 'session') {
      if (isTerminal(poll.session.status)) {
        logSessionEnded(poll.session);
        return 'ended';
      }
      noteJoin(poll.session);
      // Evidence in the log that this process resolved the session main published.
      core.info(`Session ${poll.session.name} (${poll.session.status})`);
    }

    const counting = remaining !== null && !joined;
    console.log(`${counting ? `Waiting for client to connect (at most ${remaining} more second(s))` : 'Waiting for session to end'}\n${message}`);

    if (counting && (remaining as number) <= 0) {
      // A last look before acting: a guest may have joined since the poll
      // above, or the session may have ended since then. A failed lookup here
      // must never spend the countdown or end the wait, exactly like an
      // ordinary poll - it says nothing about who is there, and could stop a
      // session somebody is in.
      const last = await pollSession();
      if (last.kind === 'gone') {
        core.info("Exiting debugging session: 'upterm' quit");
        return 'ended';
      }
      if (last.kind === 'session') {
        if (isTerminal(last.session.status)) {
          logSessionEnded(last.session);
          return 'ended';
        }
        noteJoin(last.session);
        if (!joined) {
          core.warning(`Timed out waiting for client to connect (after ${timeoutSeconds} seconds)`);
          core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
          await stopSession();
          return 'timeout';
        }
        continue;
      }
      // last.kind === 'unknown': do not stop, and do not spend the countdown
      // further - it stays at zero. Sleep one interval and let the next
      // successful poll and re-check decide.
      await sleep(SESSION_STATUS_POLL_INTERVAL);
      continue;
    }

    await sleep(SESSION_STATUS_POLL_INTERVAL);
    if (counting && poll.kind === 'session') remaining = (remaining as number) - SESSION_STATUS_POLL_INTERVAL / 1000;
  }
}

async function runDetachedMode(session: SessionInfo): Promise<void> {
  core.debug('Entering detached mode');

  // launchSession() already proved this session has a usable connect string.
  // Re-querying here would let a transient admin-query failure fail a healthy
  // session moments after startup succeeded.
  //
  // Emit the notice once; use plain text for the post-action loop
  // to avoid creating duplicate annotations in the GitHub Actions UI.
  const message = `SSH: ${session.sshCommand}`;
  core.notice(message);

  // Save state for the POST action
  core.saveState('message', message);

  console.log(message);
  core.info('Detached mode: workflow will continue while upterm session is active');
}

/**
 * Remove this run's private directories.
 *
 * Guarded: rmSync(force) suppresses only ENOENT and defaults to maxRetries 0,
 * so on Windows - where the upterm process this run started can still be
 * releasing its own open handle on state/upterm/upterm.log a moment after
 * `session stop` returns, more strictly enforced there than on POSIX - an
 * unguarded EBUSY would fail a job whose debug session succeeded.
 */
function cleanupUptermData(): void {
  for (const key of ['uptermBaseDir', 'uptermRuntimeDir']) {
    const dir = core.getState(key);
    if (!dir) continue;
    try {
      fs.rmSync(dir, {recursive: true, force: true});
    } catch (error) {
      core.debug(`Could not remove ${dir}: ${error}`);
    }
  }
}

/**
 * Stop the session this run started, then remove its directories. Order
 * matters: the runtime directory holds the session's live sockets.
 *
 * Guarded by sessionStarted: isPost is saved before installation, and post-if
 * is "!cancelled()", so a failed download or a rejected upterm version reaches
 * here having started nothing. The directories are ours either way.
 */
async function finalizeSession(): Promise<void> {
  if (core.getState('sessionStarted') === 'true') {
    // The post step is a fresh process: session stop finds the session through
    // XDG_STATE_HOME, which only main had exported so far.
    exportXdgEnvironment();
    await stopSession();
  }
  cleanupUptermData();
}

async function runPost(): Promise<void> {
  try {
    const message = core.getState('message');
    // Non-detached runs save no message: there is nothing to wait for, but the
    // session and its directories still need tearing down in the finally.
    if (!message) return;

    exportXdgEnvironment();

    // The runner interrupts a post step it is cancelling. Stop the session on the
    // way out - through bash, like every other upterm call, because on Windows the
    // exported XDG paths are MSYS-form and only a bash launch converts them.
    const shutdown = async () => {
      core.error('Got signal');
      await stopSession();
      process.exit(1);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    core.debug('Waiting for session to end');

    await waitForSession(detachedTimeoutSeconds(), message);
  } finally {
    await finalizeSession();
  }
}
