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
const UPTERM_SOCKET_POLL_INTERVAL = 1000;
const UPTERM_READY_MAX_RETRIES = 10;
const SESSION_STATUS_POLL_INTERVAL = 5000;
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

/**
 * Root for this run's temporary directories.
 *
 * RUNNER_TEMP is short enough for upterm's 103-byte socket budget AND is reaped
 * by the runner per job. A hardcoded /tmp is neither - never cleaned, and
 * unwritable on hardened or containerized runners.
 */
function tempRoot(): string {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

function createPrivateDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tempRoot(), prefix));
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

  const base = savedBase || createPrivateDir('upterm-action-');
  const runtime = savedRuntime || createPrivateDir('upterm-runtime-');

  if (!savedBase) core.saveState('uptermBaseDir', base);
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

/**
 * Export XDG_* to this process so the action's own `upterm session info` calls
 * resolve the same session record the host published to.
 *
 * upterm finds a session's record through XDG_STATE_HOME
 * (cmd/upterm/command/session.go:425). Until now the action only set these
 * inside tmux.conf, because every query passed --admin-socket explicitly.
 * execShellCommand inherits process.env on both platforms (helpers.ts:26-34),
 * so one assignment covers every call site, in main and in post alike.
 */
function exportXdgEnvironment(): void {
  const dirs = getUptermDirs();
  const convert = process.platform === 'win32' ? toMsys2Path : toShellPath;
  process.env.XDG_RUNTIME_DIR = convert(dirs.runtime);
  process.env.XDG_STATE_HOME = convert(dirs.state);
  process.env.XDG_CONFIG_HOME = convert(dirs.config);
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
  exportXdgEnvironment();
  core.debug(`Created upterm directories under ${dirs.base}`);

  // Remove any stale timeout flag left in a reused temp directory (e.g. on a
  // self-hosted runner, or a second invocation in the same job). Otherwise
  // monitorSession() would read the old flag via the native path and report a
  // timeout for this fresh session before its timer has even been armed.
  fs.rmSync(dirs.timeoutFlag, {force: true});

  // On Windows, upterm.exe expects POSIX-style paths in XDG vars (e.g., /c/Users/... not C:/Users/...)
  const xdgPathConverter = process.platform === 'win32' ? toMsys2Path : toShellPath;
  const xdgRuntimeDir = xdgPathConverter(dirs.runtime);
  const xdgStateHome = xdgPathConverter(dirs.state);
  const xdgConfigHome = xdgPathConverter(dirs.config);

  // Create custom tmux config that sets XDG environment variables globally
  // Using a custom config file ensures both outer and inner tmux sessions get the same config
  const tmuxConf = `# Set XDG directories for upterm
set-environment -g XDG_RUNTIME_DIR "${xdgRuntimeDir}"
set-environment -g XDG_STATE_HOME "${xdgStateHome}"
set-environment -g XDG_CONFIG_HOME "${xdgConfigHome}"

# Allow UPTERM_ADMIN_SOCKET to be inherited from client environment
# This enables 'upterm session current' to work without --admin-socket flag
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
    const tmuxCmd = `tmux ${tmuxConfFlagOuter} new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --name ${getSessionName()} --skip-host-key-check --accept --server ${shellEscape(uptermServer)} ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux ${tmuxConfFlagInner} new -s upterm -f read-only -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee ${shellEscape(getUptermCommandLogPath())}" 2>${shellEscape(getTmuxErrorLogPath())}`;

    // Evidence for the post step that process teardown is warranted. isPost is
    // saved before installDependencies(), so without this a failed download or
    // a rejected upterm version would reach finalizeSession() and kill the
    // shared default tmux server.
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
      launchOutsideJobObject(tmuxCmd, {
        PATH: process.env.PATH || '',
        HOME: process.env.USERPROFILE || os.homedir()
      });
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

async function collectDiagnostics(): Promise<string> {
  const dirs = getUptermDirs();
  const name = getSessionName();
  let diagnostics = 'Upterm did not become ready after maximum retries.\n\nDiagnostics:\n';

  diagnostics += `- Upterm data directory: ${dirs.base}\n`;
  diagnostics += `- Session name: ${name}\n`;

  const session = await getSession(name).catch(error => {
    diagnostics += `- Session lookup failed: ${error}\n`;
    return null;
  });

  diagnostics += `- Session status: ${session ? session.status : 'no session record found'}\n`;
  if (session && !session.hasLiveDetail) diagnostics += '- Upterm answered from its record only; its admin query did not succeed\n';
  if (session?.reason) diagnostics += `- Reason: ${session.reason}\n`;

  // upterm writes its log under XDG_STATE_HOME, not the runtime dir - the old
  // path never existed, so this section was always silently omitted.
  if (session?.logPath && fs.existsSync(session.logPath)) {
    diagnostics += `- Upterm log:\n${fs.readFileSync(session.logPath, 'utf8')}\n`;
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
 * One lookup per poll.
 *
 * Three outcomes, deliberately distinct. Collapsing 'unknown' into 'gone'
 * would make a transient registry hiccup end a live debugging session - the
 * exact failure this whole change exists to remove.
 */
type PollResult = {kind: 'session'; session: SessionInfo} | {kind: 'gone'} | {kind: 'unknown'};

async function pollSession(): Promise<PollResult> {
  try {
    const session = await getSession(getSessionName());
    return session ? {kind: 'session', session} : {kind: 'gone'};
  } catch (error) {
    core.debug(`Session lookup failed, treating as unknown: ${error}`);
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

  while (tries-- > 0) {
    core.info(`Waiting for upterm to be ready... (${UPTERM_READY_MAX_RETRIES - tries}/${UPTERM_READY_MAX_RETRIES})`);
    const poll = await pollSession();

    if (poll.kind === 'session') {
      if (poll.session.status === 'ready' && poll.session.hasLiveDetail) return poll.session;
      if (isTerminal(poll.session.status)) break;
    }
    // 'gone' (the record is not published this early) and 'unknown' (the lookup
    // itself failed) both mean "not ready YET", never "failed": burn a retry,
    // exactly as a `starting` status does. An unguarded lookup here would let
    // one hiccup abandon the remaining retries and fail the job - and would
    // skip collectDiagnostics(), the report written for precisely this case.

    await sleep(UPTERM_SOCKET_POLL_INTERVAL);
  }

  throw new Error(await collectDiagnostics());
}

async function outputSshCommand(session: SessionInfo): Promise<string | null> {
  const sshCommand = session.sshCommand;
  if (!sshCommand) {
    core.warning('Upterm reported a session without an SSH command');
    return null;
  }

  core.setOutput('ssh-command', sshCommand);
  await core.summary.addHeading('Upterm SSH Connection').addCodeBlock(sshCommand, 'bash').addRaw(`\n\nConnect with: <code>${sshCommand}</code>`).write();
  core.info(`SSH command available as output: ${sshCommand}`);
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

async function hasAnyoneConnectedYet(): Promise<boolean> {
  try {
    // The upterm host's tmux client is marked read-only (via `-f read-only`
    // on `tmux new -s upterm`), so filtering for non-read-only clients
    // gives us exactly the user SSH connections.
    const result = await execShellCommand("tmux list-clients -t upterm -f '#{?client_readonly,,1}'");
    return result.trim() !== '';
  } catch {
    return false;
  }
}

async function runPost(): Promise<void> {
  const message = core.getState('message');
  if (!message) {
    // Not in detached mode or session wasn't started properly
    return;
  }
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
    const connected = await hasAnyoneConnectedYet();
    if (connected) anyoneConnected = true;

    console.log(`${anyoneConnected ? 'Waiting for session to end' : `Waiting for client to connect (at most ${seconds} more second(s))`}\n${message}`);

    if (continueFileExists()) {
      core.info("Exiting debugging session because '/continue' file was created");
      break;
    }

    const session = await getSession(getSessionName());
    if (!session || isTerminal(session.status)) {
      if (session) logSessionEnded(session);
      else core.info("Exiting debugging session: 'upterm' quit");
      break;
    }

    await sleep(5000);
    if (!anyoneConnected) seconds -= 5;
    if (seconds <= 0) core.warning(`Timed out waiting for client to connect (after ${waitTimeoutSeconds})`);
  }

  // Clean up
  try {
    await execShellCommand('tmux kill-server 2>/dev/null || true');
  } catch {
    // Ignore cleanup errors
  }
}
