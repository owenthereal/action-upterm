import os from "os"
import fs from "fs"
import path from "path"
const { globSync } = require("glob");
import * as core from "@actions/core"
import * as github from "@actions/github"

import { execShellCommand } from "./helpers"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function run() {
  try {
    if (process.platform === "win32") {
      core.info("Windows is not supported by upterm, skipping...")
      return
    }

    core.debug("Installing dependencies")
    if (process.platform == "linux") {
      await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`)
      await execShellCommand("if ! command -v tmux &>/dev/null; then sudo apt-get -y install tmux; fi")
    } else {
      await execShellCommand("brew install owenthereal/upterm/upterm tmux")
    }
    core.debug("Installed dependencies successfully")

    const sshPath = path.join(os.homedir(), ".ssh")
    if (!fs.existsSync(path.join(sshPath, "id_rsa"))) {
      core.debug("Generating SSH keys")
      fs.mkdirSync(sshPath, { recursive: true })
      try {
        await execShellCommand(`ssh-keygen -q -t rsa -N "" -f ~/.ssh/id_rsa; ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519`);
      } catch { }
      core.debug("Generated SSH keys successfully")
    } else {
      core.debug("SSH key already exists")
    }

    core.debug("Configuring ssh client")
    fs.appendFileSync(path.join(sshPath, "config"), "Host *\nStrictHostKeyChecking no\nCheckHostIP no\n" +
      "TCPKeepAlive yes\nServerAliveInterval 30\nServerAliveCountMax 180\nVerifyHostKeyDNS yes\nUpdateHostKeys yes\n")
    // entry in known hosts file in mandatory in upterm. attempt ssh connection to upterm server
    // to get the host key added to ~/.ssh/known_hosts
    if (core.getInput("ssh-known-hosts") && core.getInput("ssh-known-hosts") !== "") {
      core.info("Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:")
      fs.appendFileSync(path.join(sshPath, "known_hosts"), core.getInput("ssh-known-hosts"))
      core.info(await execShellCommand('cat ~/.ssh/known_hosts'))
    } else {
      core.info("Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev")
      try {
        await execShellCommand("ssh-keyscan uptermd.upterm.dev >> ~/.ssh/known_hosts")
      } catch { }
      // @cert-authority entry is the mandatory entry. generate the entry based on the known_hosts entry key
      try {
        await execShellCommand('cat <(cat ~/.ssh/known_hosts | awk \'{ print "@cert-authority * " $2 " " $3 }\') >> ~/.ssh/known_hosts')
      } catch { }
    }


    let allowedUsers = core.getInput("limit-access-to-users").split(/[\s\n,]+/).filter(x => x !== "")
    if (core.getInput("limit-access-to-actor") === "true") {
      core.info(`Adding actor "${github.context.actor}" to allowed users.`)
      allowedUsers.push(github.context.actor)
    }
    const uniqueAllowedUsers = [...new Set(allowedUsers)]

    let authorizedKeysParameter = ""
    for (const allowedUser of uniqueAllowedUsers) {
      if (allowedUser) {
        authorizedKeysParameter += `--github-user "${allowedUser}"`
      }
    }

    const uptermServer = core.getInput("upterm-server")
    const waitTimeoutMinutes = core.getInput("wait-timeout-minutes")
    core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`)
    await execShellCommand(`tmux new -d -s upterm-wrapper -x 132 -y 43 \"upterm host --accept --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x 132 -y 43\"`)
    // resize terminal for largest client by default
    await execShellCommand("tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest")
    console.debug("Created new session successfully")
    if (waitTimeoutMinutes !== "") {
      let timeout;
      try {
        timeout = parseInt(waitTimeoutMinutes)
      } catch (error) {
        core.error(`wait-timeout-minutes must be set to an integer. Error: ${error}`)
        throw (error)
      }
      await execShellCommand(`( sleep $(( ${timeout} * 60 )); if ! pgrep -f '^tmux attach ' &>/dev/null; then tmux kill-server; fi ) & disown`)
      core.info(`wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`)
    }

    core.debug("Fetching connection strings")
    await sleep(1000)

    console.debug("Entering main loop")
    while (true) {
      if (continueFileExists()) {
        core.info("Exiting debugging session because '/continue' file was created")
        break
      }

      if (didUptermQuit()) {
        core.info("Exiting debugging session 'upterm' quit")
        break
      }

      try {
        core.info(await execShellCommand("upterm session current --admin-socket ~/.upterm/*.sock"));
      } catch (error) {
        core.info(error.message);
        break
      }

      await sleep(5000)
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

function didUptermQuit() {
  return globSync(path.join(os.homedir(), ".upterm", "*.sock")).length === 0
}

function continueFileExists() {
  const continuePath = process.platform === "win32" ? "C:/msys64/continue" : "/continue"
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE, "continue"))
}
