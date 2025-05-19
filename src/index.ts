import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { execShellCommand } from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run() {
  try {
    if (process.platform === 'win32') {
      core.info('Windows is not supported by upterm, skipping...');
      return;
    }

    core.debug('Installing dependencies');
    if (process.platform === 'linux') {
      let uptermArch: string;
      switch (process.arch) {
        case 'x64':
          uptermArch = 'amd64';
          break;
        case 'arm64':
          uptermArch = 'arm64';
          break;
        default:
          core.error(`Unsupported architecture for upterm: ${process.arch}. Only x64 and arm64 are supported.`);
          return;
      }

      await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_${uptermArch}.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`);
      await execShellCommand('if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    } else {
      await execShellCommand('brew install owenthereal/upterm/upterm tmux');
    }
    core.debug('Installed dependencies successfully');

    // SSH key setup
    const sshPath = path.join(os.homedir(), '.ssh');
    const idRsaPath = path.join(sshPath, 'id_rsa');
    if (!fs.existsSync(idRsaPath)) {
      core.debug('Generating SSH keys');
      fs.mkdirSync(sshPath, { recursive: true });
      try {
        await execShellCommand(`ssh-keygen -q -t rsa -N "" -f ~/.ssh/id_rsa; ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519`);
      } catch (error) {
        core.error(`Error running ssh-keygen: ${error}`);
        throw error;
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
    const sshKnownHosts = core.getInput('ssh-known-hosts');
    if (sshKnownHosts && sshKnownHosts !== '') {
      core.info('Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:');
      fs.appendFileSync(knownHostsPath, sshKnownHosts);
      core.info(await execShellCommand('cat ~/.ssh/known_hosts'));
    } else {
      core.info('Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
      try {
        await execShellCommand('ssh-keyscan uptermd.upterm.dev 2> /dev/null >> ~/.ssh/known_hosts');
      } catch (error) {
        core.error(`Error running ssh-keyscan: ${error}`);
        throw error;
      }
      // Add @cert-authority entry
      try {
        await execShellCommand(`cat <(cat ~/.ssh/known_hosts | awk '{ print "@cert-authority * " $2 " " $3 }') >> ~/.ssh/known_hosts`);
      } catch (error) {
        core.error(`Error generating cert-authority entry: ${error}`);
        throw error;
      }
    }

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
      authorizedKeysParameter += `--github-user "${allowedUser}"`;
    }

    // Upterm session
    const uptermServer = core.getInput('upterm-server');
    const waitTimeoutMinutes = core.getInput('wait-timeout-minutes');
    core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);
    await execShellCommand(`tmux new -d -s upterm-wrapper -x 132 -y 43 "upterm host --accept --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x 132 -y 43"`);
    // Resize terminal for largest client by default
    await execShellCommand('tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest');
    core.debug('Created new session successfully');

    // Wait timeout logic
    if (waitTimeoutMinutes) {
      const timeout = parseInt(waitTimeoutMinutes, 10);
      if (isNaN(timeout)) {
        core.error(`wait-timeout-minutes must be set to an integer.`);
        throw new Error('Invalid wait-timeout-minutes value');
      }
      await execShellCommand(`( sleep $(( ${timeout} * 60 )); if ! pgrep -f '^tmux attach ' &>/dev/null; then tmux kill-server; fi ) & disown`);
      core.info(`wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`);
    }

    // Wait for upterm socket to be ready
    let tries = 10;
    while (tries-- > 0) {
      core.info('Waiting for upterm to be ready...');
      if (uptermSocketExists()) break;
      await sleep(1000);
    }
    if (!uptermSocketExists()) {
      throw new Error('Failed to start upterm');
    }

    core.debug('Entering main loop');
    // Main loop: wait for /continue file or upterm exit
    /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
    while (true) {
      if (continueFileExists()) {
        core.info("Exiting debugging session because '/continue' file was created");
        break;
      }
      if (!uptermSocketExists()) {
        core.info("Exiting debugging session: 'upterm' quit");
        break;
      }
      try {
        core.info(await execShellCommand('upterm session current --admin-socket ~/.upterm/*.sock'));
      } catch (error) {
        core.error(`Error getting upterm session: ${error}`);
        throw error;
      }
      await sleep(5000);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

function uptermSocketExists(): boolean {
  const uptermDir = path.join(os.homedir(), '.upterm');
  if (!fs.existsSync(uptermDir)) return false;
  return fs.readdirSync(uptermDir).some(file => file.endsWith('.sock'));
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? 'C:/msys64/continue' : '/continue';
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}
