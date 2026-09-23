# Debug [GitHub Actions](https://github.com/features/actions) With SSH

This GitHub Action enables direct interaction with the host system running your GitHub Actions via SSH, utilizing [upterm](https://upterm.dev/). This setup facilitates real-time GitHub Actions debugging and allows seamless workflow continuation.

## Features

- **Interactive Debugging**: Gain SSH access to the GitHub Actions runner to diagnose and resolve real-time issues.
- **Workflow Control**: Resume workflows post-debugging without complete restarts, saving time and preserving state.

## Supported Operating Systems

- **Linux** - Fully supported
- **macOS** - Fully supported
- **Windows** - Supported (requires MSYS2, automatically installed on GitHub Actions Windows runners)

## Requirements

This action installs [upterm](https://upterm.dev/) v0.31.0 or newer automatically. If you pin an older release with `upterm-version`, the action refuses to start (including a version string it cannot parse) — pin `owenthereal/action-upterm@v1` instead if you need an older upterm.

## Getting Started

To set up an `upterm` session within your GitHub Actions workflow, use this example:

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
```

Access the SSH connection string in the `Checks` tab of your Pull Request.

## Use Registered Public SSH Keys

To enhance security, you can restrict access to the `upterm` session to specific authorized GitHub profiles. First, ensure you have [added an SSH key to your GitHub profile](https://docs.github.com/en/github/authenticating-to-github/adding-a-new-ssh-key-to-your-github-account).

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
      with:
        limit-access-to-actor: true # Restrict to the user who triggered the workflow
        limit-access-to-users: githubuser1,githubuser2 # Specific authorized users only
```

If your registered public SSH key differs from your default private SSH key, specify the path manually: `ssh -i <path-to-private-key> <upterm-connection-string>`.

## Use Custom Upterm Server

To host your own Upterm server, follow the instructions for [deployment across various cloud providers](https://github.com/owenthereal/upterm?tab=readme-ov-file#hammer_and_wrench-deployment).
Configure the Upterm server with the `upterm-server` input parameter:

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
      with:
        ## Use the deployed Upterm server via Websocket or SSH
        upterm-server: wss://YOUR_HEROKU_APP_URL
```

## Pin a Specific Upterm Version

By default, the action downloads the latest Upterm release directly from GitHub. To pin a specific release (for example, `v0.31.0`), provide the optional `upterm-version` input:

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
      with:
        upterm-version: v0.31.0
```

- Works on all platforms (Linux, macOS, and Windows).
- **Upterm versions below `v0.31.0` are refused.** v0.31.0 is the first release that reports whether a guest has joined a session, which the timeout behavior below depends on; the action fails fast at startup against an older (or unparseable) version. If you need an older Upterm, pin `owenthereal/action-upterm@v1` instead of `@v2`.

## Shut Down the Server if No User Connects

If no guest ever joins, the session shuts down after a specified time. This feature is handy for deploying `action-upterm` to provide a debug shell on job failure without unnecessarily prolonging pipeline operation.

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
      if: ${{ failure() }}
      with:
        ## Shut down the server if unconnected after 5 minutes.
        wait-timeout-minutes: 5
```

The countdown is disarmed the moment upterm records that a guest has joined — even a guest who joined and left again between polls, or (in detached mode) joined and left while the rest of the job was still running. Once that has happened, the countdown does not run again: the session stays up until it ends on its own.

## Detached Mode

By default, this Action starts an `upterm` session and waits for it to end. In detached mode, the Action starts the session, prints the connection details, and continues with the next step(s) of the workflow's job. At the end of the job, the Action waits for the session to exit.

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v2
      with:
        detached: true
    - name: Run tests with debug session available
      run: npm test
```

By default, detached mode's countdown starts after all regular steps finish, and waits for a guest to join before terminating the session. If no guest joins within the timeout period (default 10 minutes), it terminates the session gracefully. If the job is cancelled, the post step that runs this countdown does not run at all — the runner's own orphan sweep ends the session once the job finishes.

As this mode has turned out to be so useful as to having the potential for being the default mode once time travel becomes available, it is also available as `owenthereal/action-upterm/detached` for convenience.

## Continue a Workflow

To resume your workflow within an `upterm` session, create a file named `continue` in one of these locations:

```bash
# In the workflow workspace (recommended, no sudo required)
cd $GITHUB_WORKSPACE && touch continue

# Or at the filesystem root (may require sudo)
sudo touch /continue
```

Closing the SSH connection (for example with `Ctrl-D`, or just closing your terminal) disconnects without resuming the workflow — only the continue file resumes it.

## Usage Tips

### Inside the Session

- Run `upterm session current` to see this session's own connection details from inside the SSH session.
- Run `touch $GITHUB_WORKSPACE/continue` (see [Continue a Workflow](#continue-a-workflow)) to resume the workflow from inside the session, without needing another shell on the runner.

### Windows Support

Windows runners are fully supported through MSYS2 (pre-installed on GitHub Actions Windows runners). The action automatically:
- Downloads the Windows build of upterm
- Runs the session as an MSYS2 login bash shell (`bash -l`)
- Handles Windows/POSIX path format conversions internally

**Continue file locations on Windows:**
```bash
# In the workflow workspace (recommended, no sudo/admin required)
cd $GITHUB_WORKSPACE && touch continue

# Or at the MSYS2 root (may require elevation)
touch /c/msys64/continue
```

## Migrating from v1

- **No more tmux.** v1 hosted the session inside a nested tmux, with its own keybindings (`C-b` prefix) for detaching and resizing. v2 lets upterm host the session directly: there is no tmux prefix, the shared terminal follows the connecting guest's size (v1 pinned it to 132x43), and closing the SSH connection is how you detach without resuming the workflow.
- **Requires upterm v0.31.0 or newer.** See [Requirements](#requirements) above; pin `@v1` if you need an older upterm.
- **`upterm session current` works inside the session** — upterm itself injects `UPTERM_ADMIN_SOCKET` and `UPTERM_SESSION_NAME`, so no wrapper configuration is needed for it to resolve.
- **Windows no longer uses WMI to launch the session.** See [ARCHITECTURE.md](ARCHITECTURE.md#why-no-wmi) for why.
