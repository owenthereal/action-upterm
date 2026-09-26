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

This action installs [upterm](https://upterm.dev/) v0.32.0 or newer automatically. If you pin an older release with `upterm-version`, the action refuses to start (including a version string it cannot parse) — pin `owenthereal/action-upterm@v2.0.0` to keep using upterm v0.31, or `owenthereal/action-upterm@v1` for anything older.

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

By default, the action downloads the latest Upterm release directly from GitHub. To pin a specific release (for example, `v0.32.0`), provide the optional `upterm-version` input:

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
        upterm-version: v0.32.0
```

- Works on all platforms (Linux, macOS, and Windows).
- **Upterm versions below `v0.32.0` are refused.** v0.32.0 is the first release whose daemon enforces a join timeout set after the session started (`upterm session set`), which the timeout behavior below depends on; the action fails fast at startup against an older (or unparseable) version. For upterm v0.31, pin `owenthereal/action-upterm@v2.0.0`; for anything older, `@v1`.

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

upterm itself enforces the timeout: it ends the session when the time is up unless a guest has joined. The first guest to join — even one who joined and left again at once, or (in detached mode) joined and left while the rest of the job was still running — claims the session for good: the timeout is disabled, and the session stays up until it ends on its own or the job finishes. The log shows the time left, and says `A guest joined at …; automatic join timeout disabled` once someone has.

Unset or `0` means no timeout in attached mode; in detached mode it means the default of 10 minutes.

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

By default, detached mode's timeout starts after all regular steps finish: that is when the post step gives it to upterm (`upterm session set`). If no guest joins within the timeout period (default 10 minutes), upterm ends the session. If the job is cancelled, the post step does not run at all — the runner's own orphan sweep ends the session once the job finishes.

As this mode has turned out to be so useful as to having the potential for being the default mode once time travel becomes available, it is also available as `owenthereal/action-upterm/detached` for convenience.

## Continue a Workflow

To resume your workflow within an `upterm` session, create a file named `continue` in one of these locations:

```bash
# In the workflow workspace (recommended, no sudo required)
cd $GITHUB_WORKSPACE && touch continue

# Or at the filesystem root (may require sudo)
sudo touch /continue
```

How you leave the SSH connection matters:

- ssh's own `~.` escape sequence (or just closing your terminal window) only disconnects your terminal — the session itself keeps running and waiting for a client, and the workflow does not resume. Reconnect with the same SSH command to pick up where you left off.
- Typing `exit` or pressing `Ctrl-D` sends EOF to the session's shell, which quits. That ends the session, and the workflow resumes immediately as a result.
- Touching the continue file resumes the workflow the same way `exit`/`Ctrl-D` does, but without ending the session: it keeps running, reachable over SSH, until the job's post step stops it at the end of the job — the same cleanup that stops any session still up when the job finishes.

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

- **No more tmux.** v1 hosted the session inside a nested tmux, with its own keybindings (`C-b` prefix) for detaching and resizing. v2 lets upterm host the session directly: there is no tmux prefix, the shared terminal follows the connecting guest's size (v1 pinned it to 132x43), and ssh's own escape sequence (or closing the terminal window) is how you detach without resuming the workflow — see [Continue a Workflow](#continue-a-workflow) above for how that differs from ending the session.
- **The hosted shell is now upterm's own default, not tmux's login shell.** v1's tmux started a login shell; v2 runs `$SHELL` directly (non-login), falling back to `/bin/sh` if `SHELL` is unset — which some self-hosted runners don't set. On Windows the hosted command is unchanged: MSYS2's login bash (`bash -l`).
- **Requires upterm v0.32.0 or newer** (action-upterm v2.1.0 and later; v2.0.0 required v0.31.0). See [Requirements](#requirements) above.
- **`upterm session current` works inside the session** — upterm itself injects `UPTERM_ADMIN_SOCKET` and `UPTERM_SESSION_NAME`, so no wrapper configuration is needed for it to resolve.
- **Windows no longer uses WMI to launch the session.** See [ARCHITECTURE.md](ARCHITECTURE.md#why-no-wmi) for why.

## Maintainers: Acceptance Tests

`yarn test:e2e` (act) proves the action's behavior on Linux, but act has no orphan-process sweep and cannot run Windows or macOS jobs. Cancellation — before and after a guest joins — and the long-build and guest-leaves-before-post cases on Windows and macOS can only be proven against real GitHub-hosted runners.

`.github/workflows/acceptance.yml` is a `workflow_dispatch` workflow (inputs: `runs-on`, `scenario`) that starts a detached session and either sleeps through a long "build" or a cancellable one. `script/acceptance` drives it end to end: dispatch, download the published `ssh-command` artifact, join as a guest over SSH, cancel the run when the scenario calls for it, then fetch the completed job's log and assert specific lines appear (or don't).

```bash
script/acceptance ubuntu-latest cancel                 # cancel with no guest
script/acceptance --with-guest windows-latest cancel    # cancel after a guest joins
script/acceptance macos-latest long-build
script/acceptance macos-latest guest-before-post
```

Every scenario's guest join uses the operator's own default SSH identity/agent (no `-i`, no `-o IdentityAgent=none`) — the fixture sets `limit-access-to-actor: true`, so only the GitHub account that dispatched the run, at its own keyboard, can join as the actor. This is the one place a real personal identity is used, by the maintainer's choice; the e2e fixtures instead generate a throwaway keypair because their sessions are open to anyone.

`workflow_dispatch` only triggers a workflow file that's on the repo's default branch, so pre-merge validation runs a copy of the workflow pushed to a throwaway branch of a scratch repo, and `script/acceptance --run-id <id> …` (which skips the dispatch) attaches to the run it produced. Because cancellation is run-level, cancel scenarios run in their own runs, separate from the non-cancel ones.
