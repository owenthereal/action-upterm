import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import {execShellCommand} from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

function getUptermDirs(): UptermDirs {
  if (uptermDirsCache) {
    return uptermDirsCache;
  }

  const base = path.join(os.tmpdir(), 'upterm-data');
  const state = path.join(base, 'state');
  uptermDirsCache = {
    base,
    runtime: path.join(base, 'runtime'), // XDG_RUNTIME_DIR - for sockets
    state, // XDG_STATE_HOME - for upterm's internal logs
    config: path.join(base, 'config'), // XDG_CONFIG_HOME - for config files
    logs: {
      uptermCommand: path.join(state, 'upterm-command.log'), // Our action's log of upterm stdout/stderr
      tmuxError: path.join(state, 'tmux-error.log') // Our action's log of tmux stderr
    },
    timeoutFlag: path.join(base, 'timeout-flag') // Flag file for timeout detection
  };
  return uptermDirsCache;
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

/**
 * Escape a string for safe use in single-quoted shell arguments.
 * Handles paths that may contain single quotes by using the '\'' escape pattern.
 *
 * Use this for:
 * - User-provided strings (server URLs, GitHub usernames)
 * - File paths in shell commands
 * - Any value passed through nested command layers
 *
 * @example
 * shellEscape("hello world")           // => "'hello world'"
 * shellEscape("user's file")           // => "'user'\''s file'"
 * shellEscape("ssh://server:22")       // => "'ssh://server:22'"
 *
 * @param value - The string to escape
 * @returns Single-quoted string safe for shell use
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    validateInputs();

    await installDependencies();
    await setupSSH();
    await startUptermSession();
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
  core.debug(`Created upterm directories under ${dirs.base}`);

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
    await execShellCommand(
      `tmux ${tmuxConfFlagOuter} new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --skip-host-key-check --accept --server ${shellEscape(uptermServer)} ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux ${tmuxConfFlagInner} new -s upterm -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee ${shellEscape(getUptermCommandLogPath())}" 2>${shellEscape(getTmuxErrorLogPath())}`
    );
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
      if ! pgrep -f '^tmux attach ' &>/dev/null; then
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
  const uptermDir = getUptermSocketDir();
  let diagnostics = 'Failed to start upterm - socket not found after maximum retries.\n\nDiagnostics:\n';

  diagnostics += `- Upterm data directory: ${dirs.base}\n`;
  diagnostics += `- Expected socket directory: ${uptermDir}\n`;

  if (fs.existsSync(uptermDir)) {
    const files = fs.readdirSync(uptermDir);
    diagnostics += `- Socket directory contains: ${files.join(', ')}\n`;

    const logPath = path.join(uptermDir, 'upterm.log');
    if (fs.existsSync(logPath)) {
      try {
        const logContent = fs.readFileSync(logPath, 'utf8');
        diagnostics += `- Upterm log:\n${logContent}\n`;
      } catch (error) {
        diagnostics += `- Could not read upterm.log: ${error}\n`;
      }
    }
  } else {
    diagnostics += '- Socket directory does not exist\n';
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

async function waitForUptermReady(): Promise<void> {
  let tries = UPTERM_READY_MAX_RETRIES;
  while (tries-- > 0) {
    core.info(`Waiting for upterm to be ready... (${UPTERM_READY_MAX_RETRIES - tries}/${UPTERM_READY_MAX_RETRIES})`);
    if (uptermSocketExists()) return;
    await sleep(UPTERM_SOCKET_POLL_INTERVAL);
  }

  // Socket not found after retries, collect diagnostics
  const diagnostics = await collectDiagnostics();
  throw new Error(diagnostics);
}

async function outputSshCommand(): Promise<void> {
  try {
    const socketPath = findUptermSocket();
    if (!socketPath) {
      core.warning('Could not find upterm socket to retrieve SSH command');
      return;
    }

    const sessionInfo = await execShellCommand(`upterm session current --admin-socket "${socketPath}"`);

    // Parse SSH command from session info
    const sshMatch = sessionInfo.match(/ssh\s+(\S+@\S+)/i);
    if (sshMatch) {
      const sshCommand = `ssh ${sshMatch[1]}`;
      core.setOutput('ssh-command', sshCommand);

      // Also write to job summary for easy retrieval via API
      await core.summary.addHeading('Upterm SSH Connection').addCodeBlock(sshCommand, 'bash').addRaw(`\n\nConnect with: <code>${sshCommand}</code>`).write();

      core.info(`SSH command available as output: ${sshCommand}`);
    }
  } catch (error) {
    core.debug(`Failed to extract SSH command for output: ${error}`);
  }
}

async function startUptermSession(): Promise<void> {
  const allowedUsers = getAllowedUsers();
  const authorizedKeysParameter = buildAuthorizedKeysParameter(allowedUsers);
  const uptermServer = core.getInput('upterm-server');
  const waitTimeoutMinutes = core.getInput('wait-timeout-minutes');

  await createUptermSession(uptermServer, authorizedKeysParameter);
  await sleep(UPTERM_INIT_DELAY);

  if (waitTimeoutMinutes) {
    await setupSessionTimeout(waitTimeoutMinutes);
  }

  await waitForUptermReady();
  await outputSshCommand();
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

    // Check if timeout was reached before checking socket
    if (isTimeoutReached()) {
      logTimeoutMessage();
      break;
    }

    if (!uptermSocketExists()) {
      core.info("Exiting debugging session: 'upterm' quit");
      break;
    }

    try {
      const socketPath = findUptermSocket();
      if (!socketPath) {
        throw new Error('Socket file not found');
      }
      core.info(await execShellCommand(`upterm session current --admin-socket "${socketPath}"`));
    } catch (error) {
      // Check if this error is due to timeout before throwing
      if (isTimeoutReached()) {
        logTimeoutMessage();
        break;
      }
      // For other connection issues, provide more context
      const errorMessage = String(error);
      if (errorMessage.includes('connection refused') || errorMessage.includes('No such file or directory')) {
        core.error('Upterm session appears to have ended unexpectedly');
        core.error(`Connection error: ${errorMessage}`);
        core.info('This may indicate the upterm process crashed or was terminated externally');
        break;
      }
      throw new Error(`Failed to get upterm session status: ${error}`);
    }
    await sleep(SESSION_STATUS_POLL_INTERVAL);
  }
}

function getUptermSocketDir(): string {
  // We set XDG_RUNTIME_DIR to a deterministic path in createUptermSession()
  // to ensure upterm creates sockets in a predictable, writable location
  // across all platforms. This avoids issues where platform defaults
  // (e.g., /run/user/<uid> on Linux) don't exist in CI environments.
  return path.join(getUptermDirs().runtime, 'upterm');
}

function findUptermSocket(): string | null {
  const uptermDir = getUptermSocketDir();
  if (!fs.existsSync(uptermDir)) return null;

  const socketFile = fs.readdirSync(uptermDir).find(file => file.endsWith('.sock'));
  if (!socketFile) return null;

  return toShellPath(path.join(uptermDir, socketFile));
}

function uptermSocketExists(): boolean {
  return findUptermSocket() !== null;
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? CONTINUE_FILE_PATHS.win32 : CONTINUE_FILE_PATHS.unix;
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

function isTimeoutReached(): boolean {
  return fs.existsSync(getUptermTimeoutFlagPath());
}

function logTimeoutMessage(): void {
  core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
  core.info('The session was automatically shut down to prevent unnecessary resource usage');
}
