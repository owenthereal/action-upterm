# Architecture

This document explains the technical architecture of action-upterm, with a focus on the nested command execution flow and cross-platform path handling.

## Table of Contents

- [Command Execution Flow](#command-execution-flow)
- [Path Handling Strategy](#path-handling-strategy)
- [Platform-Specific Considerations](#platform-specific-considerations)
- [Environment Variables](#environment-variables)
- [Session Management](#session-management)

## Command Execution Flow

action-upterm uses a nested command structure to create an interactive debugging session. Understanding this flow is crucial for troubleshooting and maintenance.

### Execution Layers

```
GitHub Actions Runner
  ↓
bash (Node.js child process)
  ↓ spawns
tmux outer session (upterm-wrapper)
  ↓ spawns
upterm host process
  ↓ spawns (via --force-command)
tmux inner session (upterm)
  ↓ user connects here
User's shell
```

### Detailed Flow

1. **Node.js Process** (src/index.ts)
   - Runs in GitHub Actions runner
   - Orchestrates the entire setup
   - Creates configuration files and directories

2. **Bash Shell** (via execShellCommand in src/helpers.ts)
   - On Windows: Explicitly uses `C:\msys64\usr\bin\bash.exe`
   - On Unix: Uses system's default bash
   - Executes the outer tmux command

3. **Outer Tmux Session** (`upterm-wrapper`)
   - Created in detached mode (`-d`)
   - Loads custom tmux config with `-f` flag
   - Path format: **Windows (C:/) or Unix (/home/...)**
   - Sets up environment variables globally
   - Spawns the upterm host process

4. **Upterm Host Process**
   - Native binary (upterm.exe on Windows, upterm on Unix)
   - Connects to upterm server
   - Reads XDG environment variables
   - Path format for XDG vars: **POSIX on Windows (/c/...), Unix unchanged**
   - Uses `--force-command` to spawn inner tmux

5. **Inner Tmux Session** (`upterm`)
   - Created by upterm's --force-command
   - Also loads custom tmux config with `-f` flag
   - Path format: **POSIX on Windows (/c/...), Unix unchanged**
   - This is the session users connect to
   - Inherits XDG environment from config

6. **User Shell**
   - Users SSH into the inner tmux session
   - Full access to the GitHub Actions workspace
   - Can run commands, debug issues, etc.

### Why Nested Sessions?

The nested tmux architecture serves several purposes:

1. **Wrapper Session**: Captures upterm's stdout/stderr for logging
2. **Inner Session**: Provides the actual interactive debugging environment
3. **Separation**: Allows the wrapper to continue even if inner session exits
4. **Monitoring**: The action can monitor the wrapper session status

## Path Handling Strategy

Cross-platform path handling is one of the most complex aspects of action-upterm, especially on Windows with MSYS2.

### Path Formats

Three path formats are used depending on the context:

| Format | Example | Use Case |
|--------|---------|----------|
| **Windows** | `C:/Users/foo/bar` | Native Windows executables, bash commands |
| **POSIX** | `/c/Users/foo/bar` | MSYS2 utilities, XDG environment variables, spawned processes |
| **Backslash** | `C:\Users\foo\bar` | Node.js path.join() output (converted before use) |

### Path Conversion Functions

#### `toShellPath(filePath: string): string`

Converts backslashes to forward slashes while preserving Windows drive letter format.

**Use for:**
- Paths passed to native Windows executables (upterm.exe)
- Paths used in MSYS2 bash commands (works with both formats)
- SSH key generation paths
- Outer tmux config path (invoked from bash)

**Examples:**
```typescript
toShellPath('C:\\Users\\foo') // => 'C:/Users/foo'
toShellPath('/home/foo')      // => '/home/foo' (unchanged)
```

#### `toMsys2Path(filePath: string): string`

Converts Windows paths to MSYS2/Cygwin POSIX-style paths.

**Use for:**
- XDG environment variables (XDG_RUNTIME_DIR, XDG_STATE_HOME, XDG_CONFIG_HOME)
- Shell redirects and pipes (`>`, `2>`, `|`)
- MSYS2 utilities (cat, tee, echo)
- Inner tmux config path (spawned by upterm.exe)
- Timeout flag file path

**Examples:**
```typescript
toMsys2Path('C:\\Users\\foo') // => '/c/Users/foo'
toMsys2Path('C:/Users/foo')   // => '/c/Users/foo'
toMsys2Path('/home/foo')      // => '/home/foo' (unchanged on Unix)
```

#### `shellEscape(value: string): string`

Wraps strings in single quotes and escapes internal single quotes.

**Use for:**
- User-provided strings (server URLs, GitHub usernames)
- File paths in shell commands
- Any value passed through nested command layers

**Examples:**
```typescript
shellEscape("hello world")    // => "'hello world'"
shellEscape("user's file")    // => "'user'\''s file'"
```

### Decision Tree for Path Conversion

```
Need to convert a path?
│
├─ Is it for a native Windows executable? (upterm.exe)
│  └─ Use toShellPath() for arguments, toMsys2Path() for XDG environment variables
│
├─ Is it for bash/tmux invoked from bash?
│  └─ Use toShellPath() (bash accepts both formats on Windows)
│
├─ Is it for a process spawned BY a native Windows executable?
│  └─ Use toMsys2Path() (spawned processes expect POSIX on Windows)
│
├─ Is it for shell redirection (>, 2>, |) or MSYS2 utilities (cat, tee)?
│  └─ Use toMsys2Path()
│
└─ Is it a user-provided string going into a shell command?
   └─ Use shellEscape()
```

## Platform-Specific Considerations

### Linux

**Characteristics:**
- Native POSIX paths
- tmux and SSH tools readily available
- Sockets live under the per-run runtime directory, rooted at `RUNNER_TEMP` whenever that fits upterm's socket path limit (see [File Structure](#file-structure))

**Installation:**
- Downloads pre-built upterm binary
- Installs tmux via apt-get (if not present)

**Path Handling:**
- Minimal conversion needed
- toShellPath() and toMsys2Path() are essentially no-ops

### macOS

**Characteristics:**
- Native POSIX paths (similar to Linux)
- Uses Homebrew for package management
- May have restrictive permissions in /tmp

**Installation:**
- Installs both upterm and tmux via Homebrew

**Path Handling:**
- Same as Linux - minimal conversion needed

### Windows

**Characteristics:**
- Native Windows paths with backslashes
- Uses MSYS2 environment for Unix-like tools
- Complex path format requirements
- Two execution contexts: native Windows and MSYS2

**Installation:**
- Downloads Windows-native upterm.exe
- Installs tmux via pacman (MSYS2 package manager)

**Path Handling:**
- Most complex due to mixed execution contexts
- Requires careful path format selection
- See "Path Handling Strategy" above

**MSYS2 Environment:**
```bash
# Environment variables for MSYS2 bash
MSYS2_PATH_TYPE=inherit  # Don't convert paths automatically
CHERE_INVOKING=1         # Don't cd to home directory
MSYSTEM=MINGW64          # Include MINGW64 binaries in PATH
```

## Environment Variables

### XDG Base Directory Specification

action-upterm follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html) to ensure predictable file locations across platforms.

**Variables Set:**

| Variable | Purpose | Example (Unix) | Example (Windows) |
|----------|---------|----------------|-------------------|
| `XDG_RUNTIME_DIR` | Runtime files, sockets | `{RUNNER_TEMP}/upterm-rt-XXXXXX` (root chosen by socket budget - see [File Structure](#file-structure)) | `/c/.../Temp/upterm-rt-XXXXXX` |
| `XDG_STATE_HOME` | State data, logs | `{RUNNER_TEMP}/upterm-action-XXXXXX/state` | `/c/.../Temp/upterm-action-XXXXXX/state` |
| `XDG_CONFIG_HOME` | Configuration files | `{RUNNER_TEMP}/upterm-action-XXXXXX/config` | `/c/.../Temp/upterm-action-XXXXXX/config` |

**Why XDG Variables:**
- Platform defaults may not exist in CI environments
- Ensures consistent, writable locations
- upterm uses XDG_RUNTIME_DIR for socket placement and XDG_STATE_HOME to locate a session's record - main and post must agree on both, or a healthy session reports as missing to post
- Logs go to XDG_STATE_HOME for easy diagnostics
- Exported to the action's own Node process (`process.env`), not just into tmux.conf - the action's own `upterm session info` calls need to resolve the same session record the host published to

### Tmux Configuration

A custom tmux configuration file is generated at runtime:

**Location:** `{RUNNER_TEMP}/upterm-action-XXXXXX/tmux.conf`

**Contents:**
```tmux
# Set XDG directories for upterm
set-environment -g XDG_RUNTIME_DIR "/path/to/runtime"
set-environment -g XDG_STATE_HOME "/path/to/state"
set-environment -g XDG_CONFIG_HOME "/path/to/config"

# Allow UPTERM_ADMIN_SOCKET to be inherited from client environment
set-option -ga update-environment " UPTERM_ADMIN_SOCKET"

# Enable aggressive window resizing for better multi-client support
setw -g aggressive-resize on
```

**Why Custom Config:**
- Ensures both outer and inner tmux sessions have consistent environment
- Sets XDG variables globally for all sessions
- Allows `upterm session current` to work without `--admin-socket` flag
- Enables better multi-client support

## Session Management

### Session Lifecycle

1. **Creation** (`createUptermSession()`)
   - Generate tmux config file
   - Create directory structure
   - Spawn outer tmux with custom config
   - Wait for upterm to initialize (2 second delay)

2. **Readiness Check** (`waitForUptermReady()`)
   - Polls `upterm session info <name> -o json`, addressing the session by the
     `--name` passed to `upterm host` (no filesystem discovery)
   - Ready requires BOTH `status === 'ready'` AND a usable `sshCommand`: when
     upterm's admin query fails, it can return the record's view with status
     still `ready` but no `sshCommand`, which is not something anyone can
     connect to
   - Maximum 30 retries with 1 second intervals. Wider than the old socket-file
     check needed, because readiness now waits on upterm's second, unlocked
     admin round-trip; the loop returns on its first success, so the budget only
     costs anything on a run that was going to be slow
   - Collects diagnostics on failure

3. **SSH Command Output** (`outputSshCommand()`)
   - Retrieves SSH connection string
   - Sets GitHub Actions output and logs the SSH command
   - Writes to job summary - best effort: if the write fails (e.g. `GITHUB_STEP_SUMMARY` is unset), the error is logged at debug level and the action carries on

4. **Monitoring** (`monitorSession()`)
   - Polls session status every 5 seconds
   - Checks for continue file
   - Checks for timeout
   - Handles connection errors gracefully

5. **Termination**
   - User creates `/continue` file
   - Timeout reached (if configured)
   - Session exits naturally
   - External termination (error case)

6. **Post-Step Teardown** (`finalizeSession()`, run inside a `finally` in `runPost()`)
   - Stops the session by killing only this action's two tmux sessions, by exact name: `tmux kill-session -t '=upterm-wrapper'` then `-t '=upterm'` (the `=` prevents prefix-matching a user's `upterm-dev`). Never `kill-server`: the launch uses the default tmux server, which on a self-hosted runner may not be the job's - a runner started with `./run.sh` inside tmux would go offline mid-job. Killing the session closes its panes, which sends `upterm host` the same SIGHUP
   - That kill is guarded on the `sessionStarted` state key, so a run that never started a session (e.g. a failed download or a rejected upterm version) doesn't kill `upterm-wrapper`/`upterm` sessions it never created
   - Removes this run's private directories (`uptermBaseDir`, `uptermRuntimeDir`) unconditionally - they are always safe to remove, whether or not a session ever started
   - Runs on both success and failure paths, since `post-if` is `!cancelled()`

### Timeout Mechanism

When `wait-timeout-minutes` is specified:

```bash
# Background process that enforces timeout
(
  sleep $(( TIMEOUT * 60 ));
  if [ -z "$(tmux list-clients -t upterm -f '#{?client_readonly,,1}')" ]; then
    echo "UPTERM_TIMEOUT_REACHED" > {flag-file};
    tmux kill-server;
  fi
) & disown
```

**Logic:**
- Sleeps for specified duration
- Asks tmux itself whether the `upterm` session has any writable client
  (`tmux list-clients -t upterm -f '#{?client_readonly,,1}'`). The filter drops
  read-only clients, which is what the action's own inner `tmux new -f
  read-only` attaches as - so the action does not count as somebody having
  connected
- If no such client, writes flag file and kills the tmux server (`kill-server` - unlike post-step teardown; see [Concurrency](#concurrency))
- Monitoring loop detects flag and exits gracefully

### Diagnostics Collection

On startup failure, comprehensive diagnostics are collected:

- A headline saying which failure it was: "Upterm session ended before it became ready" when the session reached a terminal status (`ended`, `ending`, `disconnected`), otherwise "Upterm did not become ready after maximum retries"
- The run's private base directory and session name
- The session's status, taken from the last readiness poll when it saw a session, otherwise from a fresh `upterm session info` (or the lookup failure, if that query itself failed)
- For a non-terminal session, whether upterm answered from its record only (no live detail) rather than a successful admin query
- The session's `Reason`, `Exit code` and `Signal`, when present
- Upterm's own log, read from `session.logPath` (`{XDG_STATE_HOME}/upterm/upterm.log`) when present; if it cannot be read, the error is recorded in its place and the rest of the report is still produced
- Tmux session list
- Tmux error log
- Upterm command output log
- Binary availability check (`upterm version`)
- XDG_RUNTIME_DIR and other environment variables
- Platform information

This information helps users report issues with full context.

### State Handed From Main to Post

The main and post invocations are separate Node processes; `core.saveState()` /
`core.getState()` is the only channel between them. Keys used:

| Key | Purpose |
|-----|---------|
| `isPost` | Set before any fallible setup so a failure always routes to the post (cleanup) path instead of re-entering main. |
| `sessionName` | The `gha-<8 hex>` name minted once in main, so post addresses the same session. |
| `sessionStarted` | Saved immediately *before* the `tmux new` launch is attempted, so a launch that fails part-way is still torn down; guards the post step's `tmux kill-session` teardown so a failed download or rejected upterm version - neither of which reaches session creation - doesn't kill `upterm-wrapper`/`upterm` sessions this run never created. |
| `uptermBaseDir` | Path to the per-run `upterm-action-XXXXXX` directory, so post restores rather than mints new directories. |
| `uptermRuntimeDir` | Path to the per-run `upterm-rt-XXXXXX` directory (`XDG_RUNTIME_DIR`), wherever its root was chosen - post restores and removes it from here. |
| `message` | The SSH connection message, saved only in detached mode; its absence tells post there is nothing to wait on. |

There is no `socketPath` key - sessions are addressed by name, not by a socket path discovered on disk.

### Concurrency

Multiple concurrent `action-upterm` invocations on the same runner remain
**unsupported**. The tmux layer uses the shared default server (no `-L`/`-S`)
with fixed session names (`upterm-wrapper`, `upterm`). `finalizeSession()`
kills only those two sessions by exact name, but because the names are fixed,
two runs would still kill each other's; and the wait-timeout script and the
post step's SIGINT/SIGTERM handler still run an unscoped `tmux kill-server`
that stops every session on that server, not just this run's. The per-run
private directories (`upterm-action-XXXXXX`, `upterm-rt-XXXXXX`) and the
per-run upterm session name (`gha-<8 hex>`)
avoid collisions in *those* two places only - they do not make it safe to run
two instances of this action in the same job.

## File Structure

Each run creates two private directories, each `mkdtempSync`'d with mode
`0700`. The base dir goes under `RUNNER_TEMP` (falling back to `os.tmpdir()` if
`RUNNER_TEMP` is unset); the runtime dir's root is chosen by socket budget
(below), so the two are usually siblings but need not be:

```
{RUNNER_TEMP}/upterm-action-XXXXXX/    # base dir
├── tmux.conf             # Custom tmux configuration
├── state/                # XDG_STATE_HOME
│   ├── upterm/
│   │   └── upterm.log      # upterm's own log (read via session.logPath in diagnostics)
│   ├── upterm-command.log  # Our tee of the upterm host process's stdout/stderr
│   └── tmux-error.log      # Tmux stderr
├── config/               # XDG_CONFIG_HOME
└── timeout-flag          # Created when timeout is reached

{runtime root}/upterm-rt-XXXXXX/       # XDG_RUNTIME_DIR
└── upterm/
    └── sessions/
        └── {session-name}/    # e.g. gha-3f9a1c05
            ├── admin.sock     # upterm's admin socket
            └── attach.sock    # upterm's attach socket
```

The two directories are split - rather than one parent with subdirectories -
so upterm's own hard limit of `maxSocketPath = 103` bytes on **every**
platform stays reachable: the runtime dir is a short, dedicated mkdtemp path
with nothing else competing for its budget. This is also why the session name
minted for `--name` (`gha-<8 hex>`) and the `upterm-rt-` prefix are
deliberately short rather than descriptive.

upterm measures `$XDG_RUNTIME_DIR/upterm/sessions/<name>/attach.sock` and
refuses an over-long one while validating `upterm host --name`, so the host
exits before any session exists. The runtime root is therefore the first of
these whose socket path fits in 103 bytes: `RUNNER_TEMP`, `os.tmpdir()`, then
`/tmp` (not on Windows). With the `upterm-rt-` prefix that path is
`len(root) + 58` bytes, so `RUNNER_TEMP` fits up to 45 bytes - hosted runners,
and the default self-hosted `~/actions-runner/_work/_temp` for user names up to
12 characters on Linux (11 on macOS). A fallback is announced with one
`core.info` line naming the root used and the too-long path; if nothing fits
(in practice only on Windows, which has no `/tmp` fallback), the run fails with
the measured paths and how to shorten them.

## Error Handling

### Error Categories

1. **Installation Errors**
   - Platform not supported
   - Architecture not supported (only x64 and arm64)
   - Package manager failures
   - Network issues downloading upterm

2. **Session Creation Errors**
   - Tmux not available
   - Upterm not available
   - Unsupported upterm version (`< v0.30.0`), caught by `assertSupportedUptermVersion()` before a session is even attempted
   - Network connectivity to upterm server
   - Permission issues

3. **Runtime Errors**
   - Session never reaches a ready state with a usable `sshCommand` after retries
   - Connection refused (unexpected termination)
   - Timeout reached

### Error Message Design

All errors include:
- Clear description of what failed
- Common causes
- Platform-specific troubleshooting tips
- Links to documentation/issue tracker

Example:
```
Failed to create upterm session: <error details>

Common causes:
- Network connectivity issues (cannot reach upterm server)
- Upterm server unavailable or incorrect server URL
- Tmux not installed or not in PATH
- On Windows: MSYS2 environment issues

Troubleshooting:
- Check upterm-server input is correct
- Verify network connectivity
- Review logs for specific errors

For help: https://github.com/owenthereal/action-upterm/issues
```

## Testing Strategy

### Unit Tests

- Mock filesystem and shell commands
- Test platform-specific logic
- Verify error handling
- Path conversion edge cases

### Integration Tests

- Platform-specific path handling tests (src/paths.test.ts)
- Test all path conversion functions
- Verify usage patterns

### End-to-End Tests

- Use `act` (nektos/act) to run workflows locally
- Test full session creation on Linux
- Verify SSH connectivity
- Parse SSH commands from output

### CI Testing

- Matrix testing across ubuntu-latest, windows-latest, macos-latest
- Tests run on all platforms for every PR
- Catches platform-specific regressions early

## Contributing

When modifying action-upterm, keep in mind:

1. **Path Handling**: Always use appropriate conversion function
2. **Platform Support**: Test on all three platforms
3. **Error Messages**: Include troubleshooting guidance
4. **Documentation**: Update this file for architectural changes
5. **Tests**: Add tests for new path handling logic

## Further Reading

- [upterm Documentation](https://github.com/owenthereal/upterm)
- [tmux Manual](https://github.com/tmux/tmux/wiki)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html)
- [MSYS2 Documentation](https://www.msys2.org/docs/what-is-msys2/)
