import {execSync} from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import {execShellCommand, launchOutsideJobObject, shellEscape, sleep} from './helpers';
import {generateSessionName, getSession, isTerminal, isUptermVersionSupported, parseUptermVersion, SessionInfo} from './session';

// Constants
const UPTERM_RELEASE_BASE_URL = 'https://github.com/owenthereal/upterm/releases';
const UPTERM_READY_POLL_INTERVAL = 1000;
// Readiness now requires upterm's second, unlocked admin round-trip to have
// succeeded - strictly harder than the old "does a socket inode exist" check,
// and a slow first attempt costs a whole retry. A wider budget costs nothing on
// the happy path (the loop returns on its first success) and the alternative is
// a hard failure on a session that was about to be fine.
const UPTERM_READY_MAX_RETRIES = 30;
const SESSION_STATUS_POLL_INTERVAL = 5000;
// Consecutive failed lookups between warnings, ~1 minute at the 5s poll
// interval. The first failure always warns.
const UNKNOWN_POLL_WARN_INTERVAL = 12;
const SUPPORTED_UPTERM_ARCHITECTURES = ['amd64', 'arm64'] as const;
const TMUX_DIMENSIONS = {width: 132, height: 43};
// Delay (in milliseconds) to allow upterm sufficient time to initialize before proceeding.
// This 2-second delay helps ensure the upterm server is fully started and ready for connections.
const UPTERM_INIT_DELAY = 2000;

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
  logs: {uptermCommand: string; tmuxError: string};
  timeoutFlag: string;
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
 * Root for this run's base directory (tmux.conf, state, config, timeout flag).
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
    config: path.join(base, 'config'), // XDG_CONFIG_HOME
    logs: {
      uptermCommand: path.join(state, 'upterm-command.log'), // Our action's log of upterm stdout/stderr
      tmuxError: path.join(state, 'tmux-error.log') // Our action's log of tmux stderr
    },
    timeoutFlag: path.join(base, 'timeout-flag') // Flag file for timeout detection
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
 * (cmd/upterm/command/session.go:425). Until now the action only set these
 * inside tmux.conf, because every query passed --admin-socket explicitly.
 * execShellCommand inherits process.env on both platforms (see its spawn call),
 * so one assignment covers every call site, in main and in post alike.
 *
 * The conversion lives here and only here. XDG_STATE_HOME must agree exactly
 * between the host process (which publishes the record) and every query (which
 * resolves it); a second copy of `win32 ? toMsys2Path : toShellPath` elsewhere
 * would agree only by coincidence, and diverge silently - on one platform only
 * - the first time either copy is edited.
 */
function exportXdgEnvironment(): XdgPaths {
  const dirs = getUptermDirs();
  // On Windows, upterm.exe expects POSIX-style paths in XDG vars (e.g., /c/Users/... not C:/Users/...)
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
 * - Shell redirects and pipes (>, 2>, |)
 * - MSYS2 utilities (cat, tee, echo)
 * - Paths spawned by native Windows executables (inner tmux)
 * - Timeout flag file path
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

function getUptermTimeoutFlagPath(): string {
  return toMsys2Path(getUptermDirs().timeoutFlag);
}

function getUptermCommandLogPath(): string {
  return toMsys2Path(getUptermDirs().logs.uptermCommand);
}

function getTmuxErrorLogPath(): string {
  return toMsys2Path(getUptermDirs().logs.tmuxError);
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
    await setupSSH();
    const session = await startUptermSession();

    if (core.getInput('detached') === 'true') {
      await runDetachedMode(session);
      return;
    }

    await monitorSession();
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
      await execShellCommand('if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
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
      // on subsequent (non-MSYS2) steps via GITHUB_PATH. The interactive
      // SSH/tmux session spawns bash login shells that re-source /etc/profile
      // with the default MSYS2_PATH_TYPE=minimal, which rebuilds PATH and drops
      // that tool-cache dir - so upterm would be missing once the user connects.
      // /usr/bin is always on the minimal MSYS2 PATH (it's where bash and the
      // pacman-installed tmux live), so copy the binary there to guarantee it
      // resolves in every MSYS2 context. Done via bash `cp` so /usr/bin tracks
      // whichever MSYS2 root the shell uses rather than a hardcoded location.
      await execShellCommand(`cp ${shellEscape(toMsys2Path(uptermExePath))} /usr/bin/upterm.exe`);

      await execShellCommand('if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');
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
      await execShellCommand('brew install tmux');
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
    const platformGuidance: Record<string, string> = {
      linux: 'Ensure apt-get is available and you have sudo permissions',
      darwin: 'Ensure Homebrew is installed: https://brew.sh',
      win32: 'Ensure MSYS2 is properly configured with pacman package manager'
    };
    const guidance = platformGuidance[process.platform] || '';
    throw new Error(`Failed to install dependencies on ${process.platform}: ${error}\n\n` + (guidance ? `Tip: ${guidance}` : ''));
  }
}

/**
 * Refuse to run against an upterm older than 0.30.
 *
 * The action addresses its session with `--name` and `upterm session info NAME
 * -o json`, neither of which exists before 0.30. Failing here beats failing
 * later with a socket that was never going to be found.
 */
async function assertSupportedUptermVersion(): Promise<void> {
  let output: string;
  try {
    output = await execShellCommand('upterm version');
  } catch (error) {
    throw new Error(`Failed to check the installed upterm version: ${error}\n\nEnsure upterm was installed successfully and is executable on PATH.`);
  }

  const version = parseUptermVersion(output);

  if (!version) {
    core.warning(`Could not determine the installed upterm version from: ${output.trim()}. Continuing, but this action requires upterm >= v0.30.0.`);
    return;
  }

  if (!isUptermVersionSupported(version)) {
    throw new Error(
      `action-upterm requires upterm >= v0.30.0 (found v${version.major}.${version.minor}.${version.patch}). ` +
        `Remove the upterm-version input to use the latest release, or pin owenthereal/action-upterm@v1.15.0 to keep using an older upterm.`
    );
  }
}

async function generateSSHKeys(sshPath: string): Promise<void> {
  const idRsaPath = path.join(sshPath, 'id_rsa');
  const idEd25519Path = path.join(sshPath, 'id_ed25519');

  if (fs.existsSync(idRsaPath)) {
    core.debug('SSH key already exists');
    return;
  }

  core.debug('Generating SSH keys');
  fs.mkdirSync(sshPath, {recursive: true});

  // Use absolute paths instead of ~ to avoid MSYS2 home directory mismatch on Windows
  const rsaKeyPath = toShellPath(idRsaPath);
  const ed25519KeyPath = toShellPath(idEd25519Path);

  try {
    await execShellCommand(`ssh-keygen -q -t rsa -N "" -f "${rsaKeyPath}"; ssh-keygen -q -t ed25519 -N "" -f "${ed25519KeyPath}"`);
    core.debug('Generated SSH keys successfully');
  } catch (error) {
    throw new Error(`Failed to generate SSH keys: ${error}`);
  }
}

function configureSSHClient(sshPath: string): void {
  core.debug('Configuring ssh client');
  const sshConfig = `Host *
  StrictHostKeyChecking no
  CheckHostIP no
  TCPKeepAlive yes
  ServerAliveInterval 30
  ServerAliveCountMax 180
  VerifyHostKeyDNS yes
  UpdateHostKeys yes
  AddressFamily inet
`;
  fs.appendFileSync(path.join(sshPath, 'config'), sshConfig);
}

async function setupSSH(): Promise<void> {
  const sshPath = path.join(os.homedir(), '.ssh');

  await generateSSHKeys(sshPath);
  configureSSHClient(sshPath);
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

function buildAuthorizedKeysParameter(allowedUsers: string[]): string {
  return allowedUsers.map(user => `--github-user ${shellEscape(user)}`).join(' ') + ' ';
}

async function createUptermSession(uptermServer: string, authorizedKeysParameter: string): Promise<void> {
  core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);

  // Get deterministic paths for all upterm-related files
  const dirs = getUptermDirs();

  // Create all required directories - upterm and our action expect these to exist
  fs.mkdirSync(dirs.runtime, {recursive: true});
  fs.mkdirSync(dirs.state, {recursive: true});
  fs.mkdirSync(dirs.config, {recursive: true});
  // The same triple that goes into this process's environment goes into
  // tmux.conf below: the host and every later query must agree on XDG_STATE_HOME
  // or the session record cannot be resolved.
  const xdg = exportXdgEnvironment();
  core.debug(`Created upterm directories under ${dirs.base}`);

  // Remove any stale timeout flag left in a reused temp directory (e.g. on a
  // self-hosted runner, or a second invocation in the same job). Otherwise
  // monitorSession() would read the old flag via the native path and report a
  // timeout for this fresh session before its timer has even been armed.
  fs.rmSync(dirs.timeoutFlag, {force: true});

  // Create custom tmux config that sets XDG environment variables globally
  // Using a custom config file ensures both outer and inner tmux sessions get the same config
  const tmuxConf = `# Set XDG directories for upterm
set-environment -g XDG_RUNTIME_DIR "${xdg.runtime}"
set-environment -g XDG_STATE_HOME "${xdg.state}"
set-environment -g XDG_CONFIG_HOME "${xdg.config}"

# Allow UPTERM_ADMIN_SOCKET to be inherited from client environment.
# The action itself no longer runs 'upterm session current' - it addresses the
# session by name - but a human who runs it from a shell inside the session
# still needs the variable to reach their tmux client.
set-option -ga update-environment " UPTERM_ADMIN_SOCKET"

# Enable aggressive window resizing for better multi-client support
setw -g aggressive-resize on
`;

  const tmuxConfPath = path.join(dirs.base, 'tmux.conf');
  fs.writeFileSync(tmuxConfPath, tmuxConf);
  core.debug(`Created tmux config at ${tmuxConfPath}`);

  // Use -f to load our custom config for both outer and inner tmux sessions
  // For outer tmux: Use Windows path (C:/...) with quotes since it runs in bash
  // For inner tmux: Use POSIX path (/c/...) without quotes since upterm.exe spawns it
  const tmuxConfPathShell = toShellPath(tmuxConfPath);
  const tmuxConfPathPosix = toMsys2Path(tmuxConfPath);
  const tmuxConfFlagOuter = `-f ${shellEscape(tmuxConfPathShell)}`;
  const tmuxConfFlagInner = `-f ${tmuxConfPathPosix}`;

  try {
    // getSessionName() is interpolated raw, unlike every other value here:
    // generateSessionName() produces `gha-` + 8 hex chars and nothing else, so
    // it is shell-safe by construction. Any change that lets a name carry
    // user input must wrap it in shellEscape(), as session.ts already does.
    const tmuxCmd = `tmux ${tmuxConfFlagOuter} new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --name ${getSessionName()} --skip-host-key-check --accept --server ${shellEscape(uptermServer)} ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux ${tmuxConfFlagInner} new -s upterm -f read-only -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee ${shellEscape(getUptermCommandLogPath())}" 2>${shellEscape(getTmuxErrorLogPath())}`;

    // Evidence for the post step that process teardown is warranted. isPost is
    // saved before installDependencies(), so without this a failed download or
    // a rejected upterm version would reach finalizeSession() and kill tmux
    // sessions named upterm-wrapper/upterm that this run never created.
    core.saveState('sessionStarted', 'true');

    if (process.platform === 'win32') {
      // On Windows, launch the tmux/upterm process tree outside the
      // runner's Job Object via WMI.  Without this, a sibling step's
      // timeout-minutes limit terminates the entire Job Object, taking
      // tmux and upterm with it.  WMI's Win32_Process::Create spawns
      // the process under WmiPrvSE.exe, which is outside the runner's
      // Job Object and therefore immune to step timeout cascades.
      //
      // Pass the current PATH so that the WMI-spawned bash can find
      // tmux and upterm (which were added to PATH by installDependencies).
      // MSYSTEM and CHERE_INVOKING are set by the launch script itself
      // (the WMI-spawned process has a minimal environment), so we only
      // need to forward PATH and HOME here.
      launchOutsideJobObject(
        tmuxCmd,
        {
          PATH: process.env.PATH || '',
          HOME: process.env.USERPROFILE || os.homedir()
        },
        getUptermDirs().base
      );
    } else {
      await execShellCommand(tmuxCmd);
    }
    core.debug('Created new session successfully');
  } catch (error) {
    try {
      const tmuxError = await execShellCommand(`cat ${shellEscape(getTmuxErrorLogPath())} 2>/dev/null || echo "No tmux error log found"`);
      core.error(`Tmux error log: ${tmuxError.trim()}`);
    } catch (logError) {
      core.debug(`Could not read tmux error log: ${logError}`);
    }

    const errorMsg = `Failed to create upterm session: ${error}

Common causes:
- Network connectivity issues (cannot reach upterm server)
- Upterm server unavailable or incorrect server URL
- Tmux not installed or not in PATH
- On Windows: MSYS2 environment issues
- Insufficient permissions for creating sockets/files

Troubleshooting:
- Check upterm-server input is correct (default: ssh://uptermd.upterm.dev:22)
- Verify network connectivity to upterm server
- On Windows: Ensure MSYS2 is properly configured
- Check the logs above for specific error details

For help, see: https://github.com/owenthereal/action-upterm/issues`;
    throw new Error(errorMsg);
  }
}

async function setupSessionTimeout(waitTimeoutMinutes: string): Promise<void> {
  const timeout = parseInt(waitTimeoutMinutes, 10);
  const timeoutFlagPath = getUptermTimeoutFlagPath();

  const timeoutScript = `
    (
      sleep $(( ${timeout} * 60 ));
      if [ -z "$(tmux list-clients -t upterm -f '#{?client_readonly,,1}')" ]; then
        echo "UPTERM_TIMEOUT_REACHED" > ${shellEscape(timeoutFlagPath)};
        tmux kill-server;
      fi
    ) & disown
  `;

  try {
    await execShellCommand(timeoutScript);
    core.info(`wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`);
  } catch (error) {
    throw new Error(`Failed to setup timeout: ${error}`);
  }
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
  const headline = session && isTerminal(session.status) ? `Upterm session ended before it became ready (status: ${session.status}).` : 'Upterm did not become ready after maximum retries.';
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

  // Check tmux sessions
  try {
    const tmuxList = await execShellCommand('tmux list-sessions 2>/dev/null || echo "No tmux sessions"');
    diagnostics += `- Tmux sessions: ${tmuxList.trim()}\n`;
  } catch (error) {
    diagnostics += `- Could not check tmux sessions: ${error}\n`;
  }

  // Check tmux error log
  try {
    const tmuxErrorLog = await execShellCommand(`cat ${shellEscape(getTmuxErrorLogPath())} 2>/dev/null || echo "No tmux error log"`);
    if (tmuxErrorLog.trim() !== 'No tmux error log') {
      diagnostics += `- Tmux error log:\n${tmuxErrorLog.trim()}\n`;
    }
  } catch (error) {
    diagnostics += `- Could not read tmux error log: ${error}\n`;
  }

  // Check upterm command output log
  try {
    const cmdLog = await execShellCommand(`cat ${shellEscape(getUptermCommandLogPath())} 2>/dev/null || echo "No command log"`);
    if (cmdLog.trim() !== 'No command log') {
      diagnostics += `- Upterm command output:\n${cmdLog.trim()}\n`;
    }
  } catch (error) {
    diagnostics += `- Could not read command log: ${error}\n`;
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
  diagnostics += '1. Check tmux and upterm are installed and in PATH\n';
  diagnostics += '2. Verify upterm-server setting is correct\n';
  diagnostics += '3. Check network connectivity to upterm server\n';
  diagnostics += '4. Review the logs above for specific error messages\n';
  diagnostics += '5. On Windows: Verify MSYS2 environment is working\n';

  diagnostics += '\nPlease report this issue with the above diagnostics at: https://github.com/owenthereal/action-upterm/issues';
  return diagnostics;
}

/**
 * Report whether a guest has joined: true, false, or null for UNKNOWN.
 *
 * Null means upterm answered without the live detail that carries the counts.
 * A missing guestCount must never be read as zero - that would shut down a
 * session a developer is actively attached to.
 *
 * Takes the session rather than fetching one: the post loop already needs a
 * lookup for its terminal check, and two lookups per poll would double the
 * shell-outs and could disagree with each other within a single iteration.
 */
function guestPresence(session: SessionInfo | null): boolean | null {
  if (!session?.hasLiveDetail) return null;
  return (session.guestCount ?? 0) > 0;
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

/**
 * Wait until the session is genuinely usable.
 *
 * Readiness requires BOTH status === 'ready' AND live detail. upterm returns
 * "ready" from the record alone when its admin query fails
 * (cmd/upterm/command/session.go:485-488), and a "ready" session with no
 * sshCommand is one nobody can connect to.
 */
async function waitForUptermReady(): Promise<SessionInfo> {
  let tries = UPTERM_READY_MAX_RETRIES;
  // What the LAST poll saw, if it saw a session - handed to the diagnostics so
  // the report describes the state that ended the wait.
  let lastObserved: SessionInfo | undefined;

  while (tries-- > 0) {
    core.info(`Waiting for upterm to be ready... (${UPTERM_READY_MAX_RETRIES - tries}/${UPTERM_READY_MAX_RETRIES})`);
    const poll = await pollSession();
    lastObserved = poll.kind === 'session' ? poll.session : undefined;

    if (poll.kind === 'session') {
      if (poll.session.status === 'ready' && poll.session.hasLiveDetail) return poll.session;
      if (isTerminal(poll.session.status)) break;
    }
    // 'gone' (the record is not published this early) and 'unknown' (the lookup
    // itself failed) both mean "not ready YET", never "failed": burn a retry,
    // exactly as a `starting` status does. An unguarded lookup here would let
    // one hiccup abandon the remaining retries and fail the job - and would
    // skip collectDiagnostics(), the report written for precisely this case.

    await sleep(UPTERM_READY_POLL_INTERVAL);
  }

  throw new Error(await collectDiagnostics(lastObserved));
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
  const allowedUsers = getAllowedUsers();
  const authorizedKeysParameter = buildAuthorizedKeysParameter(allowedUsers);
  const uptermServer = core.getInput('upterm-server');
  const waitTimeoutMinutes = core.getInput('wait-timeout-minutes');

  await createUptermSession(uptermServer, authorizedKeysParameter);
  await sleep(UPTERM_INIT_DELAY);

  if (waitTimeoutMinutes && core.getInput('detached') !== 'true') {
    await setupSessionTimeout(waitTimeoutMinutes);
  }

  const session = await waitForUptermReady();
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

async function monitorSession(): Promise<void> {
  core.debug('Entering main loop');
  // Main loop: wait for /continue file or upterm exit
  /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
  while (true) {
    if (continueFileExists()) {
      core.info("Exiting debugging session because '/continue' file was created");
      break;
    }

    // Check if timeout was reached before looking the session up
    if (isTimeoutReached()) {
      logTimeoutMessage();
      break;
    }

    const poll = await pollSession();
    if (poll.kind === 'gone') {
      core.info("Exiting debugging session: 'upterm' quit");
      break;
    }
    if (poll.kind === 'session') {
      if (isTerminal(poll.session.status)) {
        logSessionEnded(poll.session);
        break;
      }
      if (poll.session.sshCommand) core.info(`Session ${poll.session.name} (${poll.session.status}): ${poll.session.sshCommand}`);
    }
    // poll.kind === 'unknown' falls through: a lookup that failed is not a
    // session that ended. The checks at the top of the loop remain the exits.

    await sleep(SESSION_STATUS_POLL_INTERVAL);
  }
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? CONTINUE_FILE_PATHS.win32 : CONTINUE_FILE_PATHS.unix;
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

function isTimeoutReached(): boolean {
  // This is a Node fs check, so it must use the native filesystem path.
  // getUptermTimeoutFlagPath() returns the MSYS "/c/..." form used by the bash
  // writer in setupSessionTimeout(); Node cannot resolve that on Windows (it
  // maps to C:\c\...), so check the native path the flag actually lives at.
  return fs.existsSync(getUptermDirs().timeoutFlag);
}

function logTimeoutMessage(): void {
  core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
  core.info('The session was automatically shut down to prevent unnecessary resource usage');
}

async function runDetachedMode(session: SessionInfo): Promise<void> {
  core.debug('Entering detached mode');

  // waitForUptermReady() already proved this session has a usable connect
  // string. Re-querying here would let a transient admin-query failure fail a
  // healthy session moments after startup succeeded.
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
 * so on Windows - where the tee redirects still hold state/*.log open - an
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
 * Stop the session this run started, then remove its directories.
 *
 * Order matters: the runtime directory holds the live admin/attach sockets, so
 * removing it under a running host unlinks them out from under it. Nothing in
 * the non-detached path stops the host - monitorSession() merely breaks - so
 * the post step is where teardown happens, for every mode.
 *
 * Process teardown is SCOPED: it kills only the two sessions this action
 * creates, by exact name, never the whole server. The launch uses the default
 * tmux server, which on a self-hosted runner can be one the job did not start -
 * a runner launched with ./run.sh inside tmux, or a developer's machine - and
 * `kill-server` there would take the runner offline mid-job or destroy
 * unrelated sessions. The `=` prefix makes tmux match the name exactly, so a
 * session such as `upterm-dev` is never prefix-matched. Killing a session
 * closes its panes, which delivers the same SIGHUP to `upterm host` that
 * kill-server would.
 *
 * Process teardown is also GUARDED; directory cleanup is not. run() saves
 * isPost before installDependencies(), and post-if is "!cancelled()", so a
 * failed download or a rejected upterm version reaches this function having
 * started nothing - and a session named `upterm` it finds then is not ours.
 * The directories are ours in every case, so removing them stays
 * unconditional.
 */
async function finalizeSession(): Promise<void> {
  if (core.getState('sessionStarted') === 'true') {
    try {
      await execShellCommand("tmux kill-session -t '=upterm-wrapper' 2>/dev/null; tmux kill-session -t '=upterm' 2>/dev/null; true");
    } catch (error) {
      core.debug(`Could not stop tmux: ${error}`);
    }
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

    const shutdown = () => {
      core.error('Got signal');
      try {
        execSync('tmux kill-server');
      } catch {
        /* Ignore errors during shutdown */
      }
      process.exit(1);
    };

    // Support canceling the post-job Action
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    core.debug('Waiting for session to end');

    let waitTimeoutSeconds = parseInt(core.getInput('wait-timeout-minutes') || '10', 10) * 60;
    if (isNaN(waitTimeoutSeconds) || waitTimeoutSeconds <= 0) {
      waitTimeoutSeconds = 10 * 60; // Default 10 minutes
    }

    let anyoneConnected = false;

    for (let seconds = waitTimeoutSeconds; seconds > 0; ) {
      const poll = await pollSession();
      const connected = poll.kind === 'session' ? guestPresence(poll.session) : null;
      if (connected === true) anyoneConnected = true;

      // Prove, in the log, that this fresh post process resolved the SAME named
      // session that main published - the only visible evidence that XDG state
      // was restored across the process boundary.
      if (poll.kind === 'session') core.info(`Session ${poll.session.name} (${poll.session.status})`);

      console.log(`${anyoneConnected ? 'Waiting for session to end' : `Waiting for client to connect (at most ${seconds} more second(s))`}\n${message}`);

      if (continueFileExists()) {
        core.info("Exiting debugging session because '/continue' file was created");
        break;
      }

      if (poll.kind === 'gone') {
        core.info("Exiting debugging session: 'upterm' quit");
        break;
      }
      if (poll.kind === 'session' && isTerminal(poll.session.status)) {
        logSessionEnded(poll.session);
        break;
      }
      // poll.kind === 'unknown' falls through: a failed lookup is not a
      // finished session.

      await sleep(5000);
      // Only spend the countdown on a CONFIRMED "nobody here". `null` means
      // upterm could not tell us, and treating that as "nobody" would shut down
      // a session someone is attached to.
      if (!anyoneConnected && connected === false) seconds -= 5;
      if (seconds <= 0) core.warning(`Timed out waiting for client to connect (after ${waitTimeoutSeconds})`);
    }
  } finally {
    await finalizeSession();
  }
}
