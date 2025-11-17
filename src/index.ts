import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import {execShellCommand} from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Constants
const UPTERM_SOCKET_POLL_INTERVAL = 1000;
const UPTERM_READY_MAX_RETRIES = 10;
const SESSION_STATUS_POLL_INTERVAL = 5000;
const SUPPORTED_UPTERM_ARCHITECTURES = ['amd64', 'arm64'] as const;
const TMUX_DIMENSIONS = {width: 132, height: 43};
// Delay (in milliseconds) to allow upterm sufficient time to initialize before proceeding.
// This 2-second delay helps ensure the upterm server is fully started and ready for connections.
const UPTERM_INIT_DELAY = 2000;

// Platform-specific paths
const PATHS = {
  timeoutFlag: {
    win32: 'C:/msys64/tmp/upterm-timeout-flag',
    unix: '/tmp/upterm-timeout-flag'
  },
  continueFile: {
    win32: 'C:/msys64/continue',
    unix: '/continue'
  },
  logs: {
    uptermCommand: {
      win32: 'C:/msys64/tmp/upterm-command.log',
      unix: '/tmp/upterm-command.log'
    },
    tmuxError: {
      win32: 'C:/msys64/tmp/tmux-error.log',
      unix: '/tmp/tmux-error.log'
    }
  }
} as const;

// Utility Functions
function toShellPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function getUptermTimeoutFlagPath(): string {
  return process.platform === 'win32' ? PATHS.timeoutFlag.win32 : PATHS.timeoutFlag.unix;
}

function getUptermCommandLogPath(): string {
  return process.platform === 'win32' ? PATHS.logs.uptermCommand.win32 : PATHS.logs.uptermCommand.unix;
}

function getTmuxErrorLogPath(): string {
  return process.platform === 'win32' ? PATHS.logs.tmuxError.win32 : PATHS.logs.tmuxError.unix;
}

type UptermArchitecture = (typeof SUPPORTED_UPTERM_ARCHITECTURES)[number];

function getUptermArchitecture(nodeArch: string): UptermArchitecture | null {
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
      const uptermArch = validateArchitecture(process.arch);
      const archive = await tc.downloadTool(`https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_${uptermArch}.tar.gz`);
      const extractDir = await tc.extractTar(archive);
      const uptermPath = path.join(extractDir, 'upterm');

      if (!fs.existsSync(uptermPath)) {
        throw new Error(`Downloaded upterm archive does not contain binary at expected path: ${uptermPath}`);
      }

      core.addPath(extractDir);
      await execShellCommand('if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    },
    win32: async () => {
      const uptermArch = validateArchitecture(process.arch);
      const archive = await tc.downloadTool(`https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_${uptermArch}.tar.gz`);
      const extractDir = await tc.extractTar(archive);
      const uptermExePath = path.join(extractDir, 'upterm.exe');

      if (!fs.existsSync(uptermExePath)) {
        throw new Error(`Downloaded upterm archive does not contain upterm.exe at expected path: ${uptermExePath}`);
      }

      core.addPath(extractDir);
      await execShellCommand('if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');
    },
    darwin: async () => {
      await execShellCommand('brew install owenthereal/upterm/upterm tmux');
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
    throw new Error(`Failed to install dependencies on ${process.platform}: ${error}`);
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
`;
  fs.appendFileSync(path.join(sshPath, 'config'), sshConfig);
}

async function setupKnownHosts(knownHostsPath: string): Promise<void> {
  const knownHostsPathForShell = toShellPath(knownHostsPath);
  const sshKnownHosts = core.getInput('ssh-known-hosts');

  if (sshKnownHosts && sshKnownHosts !== '') {
    core.info('Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:');
    fs.appendFileSync(knownHostsPath, sshKnownHosts);
    core.info(await execShellCommand(`cat "${knownHostsPathForShell}"`));
  } else {
    core.info('Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    try {
      await execShellCommand(`ssh-keyscan uptermd.upterm.dev 2> /dev/null >> "${knownHostsPathForShell}"`);
      await execShellCommand(`grep '^uptermd.upterm.dev' "${knownHostsPathForShell}" | awk '{ print "@cert-authority * " $2 " " $3 }' >> "${knownHostsPathForShell}"`);
    } catch (error) {
      throw new Error(`Failed to setup known_hosts: ${error}`);
    }
  }
}

async function setupSSH(): Promise<void> {
  const sshPath = path.join(os.homedir(), '.ssh');
  const knownHostsPath = path.join(sshPath, 'known_hosts');

  await generateSSHKeys(sshPath);
  configureSSHClient(sshPath);
  await setupKnownHosts(knownHostsPath);
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
  return allowedUsers.map(user => `--github-user '${user}'`).join(' ') + ' ';
}

async function createUptermSession(uptermServer: string, authorizedKeysParameter: string): Promise<void> {
  core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);
  try {
    await execShellCommand(
      `tmux new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --accept --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee ${getUptermCommandLogPath()}" 2>${getTmuxErrorLogPath()}`
    );
    await execShellCommand('tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest');
    core.debug('Created new session successfully');
  } catch (error) {
    try {
      const tmuxError = await execShellCommand(`cat ${getTmuxErrorLogPath()} 2>/dev/null || echo "No tmux error log found"`);
      core.error(`Tmux error log: ${tmuxError.trim()}`);
    } catch (logError) {
      core.debug(`Could not read tmux error log: ${logError}`);
    }
    throw new Error(`Failed to create upterm session: ${error}`);
  }
}

async function setupSessionTimeout(waitTimeoutMinutes: string): Promise<void> {
  const timeout = parseInt(waitTimeoutMinutes, 10);
  const timeoutFlagPath = getUptermTimeoutFlagPath();

  const timeoutScript = `
    (
      sleep $(( ${timeout} * 60 ));
      if ! pgrep -f '^tmux attach ' &>/dev/null; then
        echo "UPTERM_TIMEOUT_REACHED" > ${timeoutFlagPath};
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
  const uptermDir = getUptermSocketDir();
  let diagnostics = 'Failed to start upterm - socket not found after maximum retries.\n\nDiagnostics:\n';

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

    try {
      const cmdLog = await execShellCommand(`cat ${getUptermCommandLogPath()} 2>/dev/null || echo "No command log"`);
      if (cmdLog.trim() !== 'No command log') {
        diagnostics += `- Command output: ${cmdLog.trim()}\n`;
      }
    } catch (error) {
      // Ignore command log read errors
    }
  } else {
    diagnostics += '- Socket directory does not exist\n';
  }

  try {
    const tmuxList = await execShellCommand('tmux list-sessions 2>/dev/null || echo "No tmux sessions"');
    diagnostics += `- Tmux sessions: ${tmuxList.trim()}\n`;
  } catch (error) {
    diagnostics += `- Could not check tmux sessions: ${error}\n`;
  }

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
  // Upterm uses adrg/xdg library for socket storage
  // See: https://github.com/owenthereal/upterm/pull/398
  // XDG RuntimeDir: https://pkg.go.dev/github.com/adrg/xdg#RuntimeDir
  if (process.platform === 'linux') {
    // Linux: $XDG_RUNTIME_DIR/upterm or /run/user/$(id -u)/upterm
    const uid = process.getuid ? process.getuid() : '1000';
    return process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'upterm') : `/run/user/${uid}/upterm`;
  } else if (process.platform === 'darwin') {
    // macOS: ~/Library/Application Support/upterm
    return path.join(os.homedir(), 'Library', 'Application Support', 'upterm');
  } else {
    // Windows: %LOCALAPPDATA%\upterm
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'upterm');
  }
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
  const continuePath = process.platform === 'win32' ? PATHS.continueFile.win32 : PATHS.continueFile.unix;
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

function isTimeoutReached(): boolean {
  return fs.existsSync(getUptermTimeoutFlagPath());
}

function logTimeoutMessage(): void {
  core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
  core.info('The session was automatically shut down to prevent unnecessary resource usage');
}
