import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {execShellCommand} from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Constants
const UPTERM_SOCKET_POLL_INTERVAL = 1000;
const UPTERM_READY_MAX_RETRIES = 10;
const SESSION_STATUS_POLL_INTERVAL = 5000;
const SUPPORTED_UPTERM_ARCHITECTURES = ['amd64', 'arm64'] as const;
const TMUX_DIMENSIONS = {width: 132, height: 43};

function getUptermTimeoutFlagPath(): string {
  return process.platform === 'win32' ? 'C:/msys64/tmp/upterm-timeout-flag' : '/tmp/upterm-timeout-flag';
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
  if (process.platform === 'linux') {
    const uptermArch = getUptermArchitecture(process.arch);
    if (!uptermArch) {
      throw new Error(`Unsupported architecture for upterm: ${process.arch}. Only x64 and arm64 are supported.`);
    }
    try {
      await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_${uptermArch}.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`);
      await execShellCommand('if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    } catch (error) {
      throw new Error(`Failed to install dependencies on Linux: ${error}`);
    }
  } else if (process.platform === 'win32') {
    const uptermArch = getUptermArchitecture(process.arch);
    if (!uptermArch) {
      throw new Error(`Unsupported architecture for upterm: ${process.arch}. Only x64 and arm64 are supported.`);
    }
    try {
      // Download and install upterm for Windows
      await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_${uptermArch}.tar.gz | tar zxvf - -C /tmp upterm.exe && install /tmp/upterm.exe /usr/bin/`);
      // Check if tmux is available, install via pacman if not (MSYS2/Git Bash environment)
      await execShellCommand('if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');
    } catch (error) {
      throw new Error(`Failed to install dependencies on Windows: ${error}`);
    }
  } else {
    try {
      await execShellCommand('brew install owenthereal/upterm/upterm tmux');
    } catch (error) {
      throw new Error(`Failed to install dependencies on macOS: ${error}`);
    }
  }
  core.debug('Installed dependencies successfully');
}

async function setupSSH(): Promise<void> {
  // SSH key setup
  const sshPath = path.join(os.homedir(), '.ssh');
  const idRsaPath = path.join(sshPath, 'id_rsa');
  const idEd25519Path = path.join(sshPath, 'id_ed25519');

  if (!fs.existsSync(idRsaPath)) {
    core.debug('Generating SSH keys');
    fs.mkdirSync(sshPath, {recursive: true});
    try {
      // Use absolute paths instead of ~ to avoid MSYS2 home directory mismatch on Windows
      const rsaKeyPath = idRsaPath.replace(/\\/g, '/');
      const ed25519KeyPath = idEd25519Path.replace(/\\/g, '/');
      await execShellCommand(`ssh-keygen -q -t rsa -N "" -f "${rsaKeyPath}"; ssh-keygen -q -t ed25519 -N "" -f "${ed25519KeyPath}"`);
    } catch (error) {
      throw new Error(`Failed to generate SSH keys: ${error}`);
    }
    core.debug('Generated SSH keys successfully');
  } else {
    core.debug('SSH key already exists');
  }

  // SSH config
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

  // known_hosts setup
  const knownHostsPath = path.join(sshPath, 'known_hosts');
  const knownHostsPathForShell = knownHostsPath.replace(/\\/g, '/');
  const sshKnownHosts = core.getInput('ssh-known-hosts');
  if (sshKnownHosts && sshKnownHosts !== '') {
    core.info('Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:');
    fs.appendFileSync(knownHostsPath, sshKnownHosts);
    core.info(await execShellCommand(`cat "${knownHostsPathForShell}"`));
  } else {
    core.info('Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    try {
      await execShellCommand(`ssh-keyscan uptermd.upterm.dev 2> /dev/null >> "${knownHostsPathForShell}"`);
    } catch (error) {
      throw new Error(`Failed to scan SSH keys: ${error}`);
    }
    // Add @cert-authority entry for uptermd.upterm.dev only
    try {
      await execShellCommand(`grep '^uptermd.upterm.dev' "${knownHostsPathForShell}" | awk '{ print "@cert-authority * " $2 " " $3 }' >> "${knownHostsPathForShell}"`);
    } catch (error) {
      throw new Error(`Failed to generate cert-authority entry: ${error}`);
    }
  }
}

async function startUptermSession(): Promise<void> {
  // Allowed users
  const allowedUsers = core
    .getInput('limit-access-to-users')
    .split(/[\s\n,]+/)
    .filter(Boolean);
  if (core.getInput('limit-access-to-actor') === 'true') {
    core.info(`Adding actor "${github.context.actor}" to allowed users.`);
    allowedUsers.push(github.context.actor);
  }
  const uniqueAllowedUsers = [...new Set(allowedUsers)];

  let authorizedKeysParameter = '';
  for (const allowedUser of uniqueAllowedUsers) {
    authorizedKeysParameter += `--github-user '${allowedUser}' `;
  }

  // Upterm session
  const uptermServer = core.getInput('upterm-server');
  const waitTimeoutMinutes = core.getInput('wait-timeout-minutes');
  core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);
  try {
    await execShellCommand(
      `tmux new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --accept --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee /tmp/upterm-command.log" 2>/tmp/tmux-error.log`
    );
    // Resize terminal for largest client by default
    await execShellCommand('tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest');
  } catch (error) {
    // Try to read the tmux error log if it exists
    try {
      const tmuxError = await execShellCommand('cat /tmp/tmux-error.log 2>/dev/null || echo "No tmux error log found"');
      core.error(`Tmux error log: ${tmuxError.trim()}`);
    } catch (logError) {
      core.debug(`Could not read tmux error log: ${logError}`);
    }
    throw new Error(`Failed to create upterm session: ${error}`);
  }
  core.debug('Created new session successfully');

  // Give upterm a moment to initialize before checking
  await sleep(2000);

  // Wait timeout logic
  if (waitTimeoutMinutes) {
    const timeout = parseInt(waitTimeoutMinutes, 10);
    const timeoutFlagPath = getUptermTimeoutFlagPath();
    // Input is already validated in validateInputs(), timeout is guaranteed to be safe for shell execution
    try {
      // Create a timeout script that sets our flag and kills the server
      const timeoutScript = `
        (
          sleep $(( ${timeout} * 60 ));
          if ! pgrep -f '^tmux attach ' &>/dev/null; then
            echo "UPTERM_TIMEOUT_REACHED" > ${timeoutFlagPath};
            tmux kill-server;
          fi
        ) & disown
      `;
      await execShellCommand(timeoutScript);
      core.info(`wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`);
    } catch (error) {
      throw new Error(`Failed to setup timeout: ${error}`);
    }
  }

  // Wait for upterm socket to be ready
  let tries = UPTERM_READY_MAX_RETRIES;
  while (tries-- > 0) {
    core.info(`Waiting for upterm to be ready... (${UPTERM_READY_MAX_RETRIES - tries}/${UPTERM_READY_MAX_RETRIES})`);
    if (uptermSocketExists()) break;
    await sleep(UPTERM_SOCKET_POLL_INTERVAL);
  }
  if (!uptermSocketExists()) {
    // Collect diagnostic information for user bug reports
    const uptermDir = getUptermSocketDir();
    let diagnostics = 'Failed to start upterm - socket not found after maximum retries.\n\nDiagnostics:\n';

    // Check what files exist in upterm socket directory
    diagnostics += `- Expected socket directory: ${uptermDir}\n`;
    if (fs.existsSync(uptermDir)) {
      const files = fs.readdirSync(uptermDir);
      diagnostics += `- Socket directory contains: ${files.join(', ')}\n`;

      // Read upterm.log if it exists for error details
      const logPath = path.join(uptermDir, 'upterm.log');
      if (fs.existsSync(logPath)) {
        try {
          const logContent = fs.readFileSync(logPath, 'utf8');
          diagnostics += `- Upterm log:\n${logContent}\n`;
        } catch (error) {
          diagnostics += `- Could not read upterm.log: ${error}\n`;
        }
      }

      // Read upterm command output for additional context
      try {
        const cmdLog = await execShellCommand('cat /tmp/upterm-command.log 2>/dev/null || echo "No command log"');
        if (cmdLog.trim() !== 'No command log') {
          diagnostics += `- Command output: ${cmdLog.trim()}\n`;
        }
      } catch (error) {
        // Ignore command log read errors
      }
    } else {
      diagnostics += '- Socket directory does not exist\n';
    }

    // Check if tmux sessions are running
    try {
      const tmuxList = await execShellCommand('tmux list-sessions 2>/dev/null || echo "No tmux sessions"');
      diagnostics += `- Tmux sessions: ${tmuxList.trim()}\n`;
    } catch (error) {
      diagnostics += `- Could not check tmux sessions: ${error}\n`;
    }

    diagnostics += '\nPlease report this issue with the above diagnostics at: https://github.com/owenthereal/action-upterm/issues';

    throw new Error(diagnostics);
  }
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
      const uptermSocketDir = getUptermSocketDir();
      // Find the actual socket file instead of using wildcard
      const files = fs.readdirSync(uptermSocketDir);
      const socketFile = files.find(file => file.endsWith('.sock'));
      if (!socketFile) {
        throw new Error('Socket file not found');
      }
      const socketPath = path.join(uptermSocketDir, socketFile).replace(/\\/g, '/');
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
    return path.join(process.env.LOCALAPPDATA || 'C:\\Users\\runneradmin\\AppData\\Local', 'upterm');
  }
}

function uptermSocketExists(): boolean {
  const uptermDir = getUptermSocketDir();
  if (!fs.existsSync(uptermDir)) return false;
  return fs.readdirSync(uptermDir).some(file => file.endsWith('.sock'));
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? 'C:/msys64/continue' : '/continue';
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

function isTimeoutReached(): boolean {
  return fs.existsSync(getUptermTimeoutFlagPath());
}

function logTimeoutMessage(): void {
  core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
  core.info('The session was automatically shut down to prevent unnecessary resource usage');
}
