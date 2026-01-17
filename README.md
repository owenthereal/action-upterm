# Debug [GitHub Actions](https://github.com/features/actions) With SSH

This GitHub Action enables direct interaction with the host system running your GitHub Actions via SSH, utilizing [upterm](https://upterm.dev/) and [tmux](https://github.com/tmux/tmux/wiki). This setup facilitates real-time GitHub Actions debugging and allows seamless workflow continuation.

## Features

- **Interactive Debugging**: Gain SSH access to the GitHub Actions runner to diagnose and resolve real-time issues.
- **Workflow Control**: Resume workflows post-debugging without complete restarts, saving time and preserving state.

## Supported Operating Systems

- **Linux** - Fully supported
- **macOS** - Fully supported
- **Windows** - Supported (requires MSYS2, automatically installed on GitHub Actions Windows runners)

## Getting Started

To set up an `upterm` session within your GitHub Actions workflow, use this example:

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
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
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
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
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
      with:
        ## Use the deployed Upterm server via Websocket or SSH
        upterm-server: wss://YOUR_HEROKU_APP_URL
```

## Pin a Specific Upterm Version

By default, the action downloads the latest Upterm release directly from GitHub. To pin a specific release (for example, `v0.20.0`), provide the optional `upterm-version` input:

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
      with:
        upterm-version: v0.20.0
```

- Works on all platforms (Linux, macOS, and Windows).
- On macOS, Upterm is installed from the GitHub release tarball (Homebrew is still used for installing `tmux` only).

## Shut Down the Server if No User Connects

If no user connects, the server automatically shuts down after a specified time. This feature is handy for deploying `action-upterm` to provide a debug shell on job failure without unnecessarily prolonging pipeline operation.

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
      if: ${{ failure() }}
      with:
        ## Shut down the server if unconnected after 5 minutes.
        wait-timeout-minutes: 5
```

## Detached Mode

By default, this Action starts an `upterm` session and waits for it to end. In detached mode, the Action starts the session, prints the connection details, and continues with the next step(s) of the workflow's job. At the end of the job, the Action waits for the session to exit.

```yaml
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v2
    - name: Setup upterm session
      uses: owenthereal/action-upterm@v1
      with:
        detached: true
    - name: Run tests with debug session available
      run: npm test
```

By default, detached mode waits at the end of the job for a user to connect and then terminate the session. If no user connects within the timeout period (default 10 minutes), it terminates the session gracefully.

As this mode has turned out to be so useful as to having the potential for being the default mode once time travel becomes available, it is also available as `owenthereal/action-upterm/detached` for convenience.

## Continue a Workflow

To resume your workflow within an `upterm` session, create a file named `continue` in one of these locations:

```bash
# In the workflow workspace (recommended, no sudo required)
cd $GITHUB_WORKSPACE && touch continue

# Or at the filesystem root (may require sudo)
sudo touch /continue
```

Press `C-b` followed by `d` (tmux detach command keys) to detach from the terminal without resuming the workflow.

## Usage Tips

### Resizing the tmux Window

After connecting via SSH:

- Press `control-b`, then type `:resize-window -A` and press `<enter>`

This will resize the console to the full width and height of the connected terminal.
([Learn more](https://unix.stackexchange.com/a/570015))

### Windows Support

Windows runners are fully supported through MSYS2 (pre-installed on GitHub Actions Windows runners). The action automatically:
- Downloads the Windows build of upterm
- Installs tmux via pacman (MSYS2 package manager)
- Handles Windows/POSIX path format conversions internally

**Continue file locations on Windows:**
```bash
# In the workflow workspace (recommended, no sudo/admin required)
cd $GITHUB_WORKSPACE && touch continue

# Or at the MSYS2 root (may require elevation)
touch /c/msys64/continue
```
