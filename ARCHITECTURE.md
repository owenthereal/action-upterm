# Architecture

This document explains the technical architecture of action-upterm, with a focus on the three `upterm` calls that drive a session and cross-platform path handling.

## Table of Contents

- [Command Execution Flow](#command-execution-flow)
- [Path Handling Strategy](#path-handling-strategy)
- [Platform-Specific Considerations](#platform-specific-considerations)
- [Environment Variables](#environment-variables)
- [Session Management](#session-management)
- [File Structure](#file-structure)
- [Error Handling](#error-handling)
- [Testing Strategy](#testing-strategy)

## Command Execution Flow

action-upterm's own footprint is three `upterm` invocations, all run through `execShellCommand` (bash on every platform, including Windows via `C:\msys64\usr\bin\bash.exe -lc`). Everything else - the wait loop, the countdown, teardown - is action code deciding when to make the next call.

### The three calls

1. **`upterm host --detach --accept --output json --name gha-XXXXXXXX --skip-host-key-check --server <server> [--authorized-user github:NAME ...] [-- bash -l]`** (`launchSession()`, src/index.ts)
   Starts upterm's own daemon and returns once it has started the hosted command and written its ready record - the JSON on stdout is the same shape `session info -o json` prints, so there is no separate readiness poll. On Windows, the hosted command is MSYS2's login bash (`bash -l`); everywhere else upterm runs `$SHELL` with no suffix. The daemon is not a child the launching step waits on: it detaches and outlives the step that started it.

2. **`upterm session info <name> -o json`** (`getSession()`, src/session.ts)
   Polled every 5 seconds by the wait loop (below) to read the session's status and `firstGuestJoinedAt`. A `no session named ...` error is treated as "the session is gone"; any other failure is treated as "unknown" and never spends the countdown or ends the wait, because a lookup failure says nothing about who is connected.

3. **`upterm session stop <name>`** (`stopSession()`, src/index.ts)
   Asks upterm to end this run's session. Called from three places: the countdown when it expires unanswered, the post step's normal teardown, and the post step's SIGINT/SIGTERM handler. Never throws: `session stop` itself exits 0 and reports "has already ended" for a session whose record is still there but no longer held (an ordinary completed session); it exits 1 with "no session named" only when no record exists at all (a launch that failed before any record was written, or a fully reaped session) - that case is a quiet no-op (`core.debug`), exactly like `getSession()`'s treatment of a "not found" lookup. Any other failure is only warned about; none of the three callers may fail the job over it.

### The wait loop and its `firstGuestJoinedAt` latch

`waitForSession()` (src/index.ts) is the one loop used by both attached mode and detached mode's post step; only the timeout and the log message differ. Each iteration:

1. Checks for the continue file (`/continue` or `$GITHUB_WORKSPACE/continue`) - if present, the wait ends immediately with no session lookup.
2. Polls `upterm session info`. A terminal status (`disconnected`, `ending`, `ended`) ends the wait. A live session updates the join latch.
3. **The join latch**: `hasGuestJoined()` reads `session.firstGuestJoinedAt`, a field upterm itself sets from its own join events (present only from upterm v0.31.0+, which is why older upterm is refused). Once this has been true once for a session, the loop stops spending the countdown - the countdown never re-arms, and a guest who joins and immediately disconnects still latches it, because the daemon recorded the join, not the current connection count. `guestCount` is never used for this decision, for two binding reasons: it counts forwarding-only presence, which is not a qualifying join, and it is a current count rather than an event - it misses a guest who joined and left again between two polls, exactly the case `firstGuestJoinedAt` exists to catch.
4. If the countdown is still armed (`wait-timeout-minutes` was set and no guest has ever joined) and it has reached zero, the loop does one last poll - because a guest may have joined, or the session may have ended, since the last check - and only then calls `stopSession()` and returns.

### Teardown order

`finalizeSession()`, run inside a `finally` in `runPost()`, always does two things in this order:

1. `stopSession()` (guarded by the `sessionStarted` state key, so a run that never reached `launchSession()` - a failed download, a rejected upterm version - doesn't try to stop a session it never started).
2. `cleanupUptermData()` - removes this run's private directories (`uptermBaseDir`, `uptermRuntimeDir`) unconditionally.

The order matters: the runtime directory holds the session's live sockets, so it must not be removed out from under a session that is still being asked to stop. Only detached mode's post step installs a SIGINT/SIGTERM handler that runs `stopSession()` before exiting - it is set up after the `message` state check that also gates whether there is a wait to run, so attached mode's post step (which saves no `message` and goes straight to teardown) never installs one; it has no wait to interrupt. The handler exists because the runner interrupts a post step it is cancelling, and `post-if: "!cancelled()"` already means the post step never runs at all when the *main* step was cancelled.

### Why No WMI

v1 launched the Windows session through WMI (`Invoke-CimMethod`) to detach it from the launching process tree. v2 does not: a probe ran `upterm host --detach` exactly as v2 does, on `windows-latest` and `windows-2022`, and found:

- **The daemon needs no WMI to survive.** It outlived its launching step ending, a sibling step's `timeout-minutes` firing, the cancelled step's Ctrl-C, and `if: always()` steps running after cancellation. It holds none of the launching step's pipes, so that step returns immediately once `upterm host --detach` prints its ready record.
- **The runner's own orphan sweep reaps it** at "Complete job", on every OS, after both normal completion and cancellation, whether or not a guest ever joined - on Windows it kills `upterm` and its ConPTY `conhost`; on Linux/macOS, `upterm` and the hosted shell.
- **A WMI-launched daemon escapes that sweep**: a process started via WMI carries no `RUNNER_TRACKING_ID`, the marker the sweep keys off, so "Complete job" terminates nothing. On a persistent (self-hosted) runner, a cancelled v1-style session leaked indefinitely. Dropping WMI removes a real leak, not just a layer of complexity.
- `bash -l` (MSYS2 bash under ConPTY) works directly as the Windows hosted command - a connecting guest gets a working `MINGW64` prompt with no trampoline needed.

## Path Handling Strategy

Cross-platform path handling is one of the most complex aspects of action-upterm, especially on Windows with MSYS2.

### Path Formats

Three path formats are used depending on the context:

| Format | Example | Use Case |
|--------|---------|----------|
| **Windows** | `C:/Users/foo/bar` | Native Windows executables, bash commands |
| **POSIX** | `/c/Users/foo/bar` | XDG environment variables, and any path handed to a bash command that will itself launch a native Windows child process |
| **Backslash** | `C:\Users\foo\bar` | Node.js path.join() output (converted before use) |

### Path Conversion Functions

#### `toShellPath(filePath: string): string`

Converts backslashes to forward slashes while preserving Windows drive letter format.

**Use for:**
- Paths passed to native Windows executables (upterm.exe)
- Paths used in MSYS2 bash commands (works with both formats)

**Examples:**
```typescript
toShellPath('C:\\Users\\foo') // => 'C:/Users/foo'
toShellPath('/home/foo')      // => '/home/foo' (unchanged)
```

#### `toMsys2Path(filePath: string): string`

Converts Windows paths to MSYS2/Cygwin POSIX-style paths.

**Use for:**
- XDG environment variables (XDG_RUNTIME_DIR, XDG_STATE_HOME, XDG_CONFIG_HOME)
- A path bash will hand to a native Windows child process it launches (e.g. the `cp` source path when copying upterm.exe into MSYS2's `/usr/bin`) - MSYS2's bash converts it to Windows form automatically for that child, so the value bash itself sees must be POSIX-style

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

## Platform-Specific Considerations

### Linux

**Characteristics:**
- Native POSIX paths
- Sockets live under the per-run runtime directory, rooted at `RUNNER_TEMP` whenever that fits upterm's socket path limit (see [File Structure](#file-structure))

**Installation:**
- Downloads pre-built upterm binary

**Path Handling:**
- Minimal conversion needed
- toShellPath() and toMsys2Path() are essentially no-ops

### macOS

**Characteristics:**
- Native POSIX paths (similar to Linux)
- May have restrictive permissions in /tmp

**Installation:**
- Downloads the upterm binary from the GitHub release tarball (no Homebrew dependency)

**Path Handling:**
- Same as Linux - minimal conversion needed

### Windows

**Characteristics:**
- Native Windows paths with backslashes
- Uses MSYS2 environment for Unix-like tools
- Complex path format requirements
- Two execution contexts: native Windows (upterm.exe) and MSYS2 bash

**Installation:**
- Downloads Windows-native upterm.exe
- Copies it into MSYS2's `/usr/bin` so it resolves inside the hosted MSYS2 login shell, whose minimal `PATH` would otherwise drop the tool-cache directory `core.addPath()` set up

**Path Handling:**
- Most complex due to mixed execution contexts
- Requires careful path format selection
- See "Path Handling Strategy" above

**MSYS2 Environment (for every `execShellCommand` call, including the hosted session):**
```bash
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

On Windows these are exported in MSYS-form (`/c/...`), never `C:/...`. Not because upterm.exe expects MSYS-form itself - it doesn't, being a native Windows executable - but because MSYS2's bash automatically converts POSIX-style environment values to Windows form when it launches a native (non-MSYS) executable as a child process. That automatic conversion is exactly why every upterm call, including on Windows, goes through bash rather than invoking upterm.exe directly; `process.env` is what every `execShellCommand` call inherits.

**Why XDG Variables:**
- Platform defaults may not exist in CI environments
- Ensures consistent, writable locations
- upterm uses XDG_RUNTIME_DIR for socket placement and XDG_STATE_HOME to locate a session's record - main and post must agree on both, or a healthy session reports as missing to post
- Logs go to XDG_STATE_HOME for easy diagnostics
- Exported to the action's own Node process (`process.env`) once, by `exportXdgEnvironment()`, called by both main and post - the action's own `upterm session info`/`session stop` calls need to resolve the same session record the host published to

## Session Management

### Session Lifecycle

1. **Creation** (`launchSession()`)
   - Create the per-run runtime/state/config directories, export XDG_* into `process.env`
   - Run `upterm host --detach ...` (see [Command Execution Flow](#command-execution-flow)); it returns only once the session is up, with its JSON session info on stdout - no separate readiness polling

2. **SSH Command Output** (`outputSshCommand()`)
   - Sets the `ssh-command` output and logs the SSH command
   - Writes to the job summary - best effort: if the write fails (e.g. `GITHUB_STEP_SUMMARY` is unset), the error is logged at debug level and the action carries on

3. **Monitoring** (`waitForSession()`)
   - Polls session status every 5 seconds
   - Checks for the continue file
   - Tracks `firstGuestJoinedAt` to decide whether the countdown is still armed (see [The wait loop and its firstGuestJoinedAt latch](#the-wait-loop-and-its-firstguestjoinedat-latch))
   - A failed lookup ("unknown") never ends the wait and never spends the countdown

4. **Termination** - the wait ends when:
   - The continue file is created
   - The session reaches a terminal status (`disconnected`, `ending`, `ended`)
   - The countdown expires while no guest has ever joined (`stopSession()` is called)

5. **Post-Step Teardown** (`finalizeSession()`, run inside a `finally` in `runPost()`) - see [Teardown order](#teardown-order)
   - Runs on both success and failure paths, since `post-if` is `!cancelled()`. On an outright cancellation of the main step, the post step does not run at all; the runner's orphan sweep is what ends the session (see [Why No WMI](#why-no-wmi))

### Diagnostics Collection

On startup failure, `collectDiagnostics()` reports:

- A headline saying which failure it was: "Upterm session ended before it became ready" when the session reached a terminal status, otherwise "Upterm did not start a usable session"
- The run's private base directory and session name
- The session lookup failure, if the diagnostic lookup itself failed
- The session's status (from the last observed poll, or a fresh lookup)
- For a non-terminal session, whether upterm answered from its record only (no live detail) rather than a successful admin query
- The session's `Reason`, `Exit code` and `Signal`, when present
- Upterm's own log, read from `session.logPath` (`{XDG_STATE_HOME}/upterm/upterm.log`) when present; if it cannot be read, the error is recorded in its place and the rest of the report is still produced
- Upterm binary availability check (`upterm version`)
- XDG_RUNTIME_DIR (both the form passed to upterm and the actual directory), USER, UID, and platform
- Troubleshooting steps and a link to the issue tracker

### State Handed From Main to Post

The main and post invocations are separate Node processes; `core.saveState()` /
`core.getState()` is the only channel between them. Keys used:

| Key | Purpose |
|-----|---------|
| `isPost` | Set before any fallible setup so a failure always routes to the post (cleanup) path instead of re-entering main. |
| `sessionName` | The `gha-<8 hex>` name minted once in main, so post addresses the same session. |
| `sessionStarted` | Saved immediately *before* `upterm host --detach` is attempted, so a launch that fails part-way is still torn down; guards the post step's `stopSession()` call so a failed download or rejected upterm version - neither of which reaches session creation - doesn't try to stop a session this run never created. |
| `uptermBaseDir` | Path to the per-run `upterm-action-XXXXXX` directory, so post restores rather than mints new directories. |
| `uptermRuntimeDir` | Path to the per-run `upterm-rt-XXXXXX` directory (`XDG_RUNTIME_DIR`), wherever its root was chosen - post restores and removes it from here. |
| `message` | The SSH connection message, saved only in detached mode; its absence tells post there is nothing to wait on. |

There is no separate session-manager state, and no `socketPath` key - sessions are addressed by name, not by a socket path discovered on disk.

### Concurrency

Each run mints its own session name (`gha-<8 hex>`) and its own private, `mkdtemp`'d runtime/state/config directories, so two `action-upterm` steps in the same job each address only their own session by name rather than sharing a fixed name or a stop call that would affect both. The one surface that is still process-wide is the continue file: `/continue` and `$GITHUB_WORKSPACE/continue` are shared paths, so creating either one resumes *every* `action-upterm` invocation in that job currently watching for it, not just one.

## File Structure

Each run creates two private directories, each `mkdtempSync`'d with mode
`0700`. The base dir goes under `RUNNER_TEMP` (falling back to `os.tmpdir()` if
`RUNNER_TEMP` is unset); the runtime dir's root is chosen by socket budget
(below), so the two are usually siblings but need not be:

```
{RUNNER_TEMP}/upterm-action-XXXXXX/    # base dir
├── state/                # XDG_STATE_HOME
│   └── upterm/
│       └── upterm.log      # upterm's own log (read via session.logPath in diagnostics)
└── config/               # XDG_CONFIG_HOME

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
   - Network issues downloading upterm

2. **Session Creation Errors**
   - Upterm not available
   - Unsupported upterm version (`< v0.31.0`, or an unparseable version), caught by `assertSupportedUptermVersion()` before a session is even attempted
   - Network connectivity to upterm server
   - Permission issues

3. **Runtime Errors**
   - `upterm host --detach` exits without a usable `sshCommand`
   - Connection refused (unexpected termination)
   - Timeout reached while no guest ever joined

### Error Message Design

All errors include:
- Clear description of what failed
- Common causes
- Platform-specific troubleshooting tips
- Links to documentation/issue tracker

Example:
```
Failed to start the upterm session: <error details>

Diagnostics:
- Upterm data directory: <path>
- Session name: gha-XXXXXXXX
- Session status: <status>
...

Please report this issue with the above diagnostics at: https://github.com/owenthereal/action-upterm/issues
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
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html)
- [MSYS2 Documentation](https://www.msys2.org/docs/what-is-msys2/)
