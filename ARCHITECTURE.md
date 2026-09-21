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
- Standard `/tmp` directory for sockets

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
| `XDG_RUNTIME_DIR` | Runtime files, sockets | `/tmp/upterm-runtime-XXXXXX` | `/c/Users/runner/AppData/Local/Temp/upterm-runtime-XXXXXX` |
| `XDG_STATE_HOME` | State data, logs | `/tmp/upterm-action-XXXXXX/state` | `/c/Users/runner/AppData/Local/Temp/upterm-action-XXXXXX/state` |
| `XDG_CONFIG_HOME` | Configuration files | `/tmp/upterm-action-XXXXXX/config` | `/c/Users/runner/AppData/Local/Temp/upterm-action-XXXXXX/config` |

**Why XDG Variables:**
- Platform defaults may not exist in CI environments
- Ensures consistent, writable locations
- upterm uses XDG_RUNTIME_DIR for socket placement
- Logs go to XDG_STATE_HOME for easy diagnostics

### Tmux Configuration

A custom tmux configuration file is generated at runtime:

**Location:** `{private-action-tempdir}/tmux.conf`

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
   - Polls the propagated `UPTERM_ADMIN_SOCKET` and validates it with `upterm session current -o json`
   - Maximum 10 retries with 1 second intervals
   - Collects diagnostics on failure

3. **SSH Command Output** (`outputSshCommand()`)
   - Retrieves SSH connection string
   - Sets GitHub Actions output
   - Writes to job summary

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

### Timeout Mechanism

When `wait-timeout-minutes` is specified:

```bash
# Background process that enforces timeout
(
  sleep $(( TIMEOUT * 60 ));
  if ! pgrep -f '^tmux attach ' &>/dev/null; then
    echo "UPTERM_TIMEOUT_REACHED" > {flag-file};
    tmux kill-server;
  fi
) & disown
```

**Logic:**
- Sleeps for specified duration
- Checks if any client is connected (`pgrep -f '^tmux attach '`)
- If no client, writes flag file and kills tmux
- Monitoring loop detects flag and exits gracefully

### Diagnostics Collection

On startup failure, comprehensive diagnostics are collected:

- Socket directory contents
- Upterm logs
- Tmux session list
- Tmux error logs
- Upterm command output
- Binary availability check
- Environment variables
- Platform information

This information helps users report issues with full context.

## File Structure

```
{private-runtime-tempdir}/
└── upterm/               # XDG_RUNTIME_DIR
    └── sessions/{name}/
        ├── admin.sock    # Admin API socket
        └── attach.sock   # Local terminal attach socket

{private-action-tempdir}/
├── state/                # XDG_STATE_HOME
│   ├── upterm-command.log  # Upterm stdout/stderr
│   └── tmux-error.log      # Tmux stderr
├── config/               # XDG_CONFIG_HOME
├── tmux.conf             # Custom tmux configuration
└── timeout-flag          # Created when timeout is reached
```

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
   - Network connectivity to upterm server
   - Permission issues

3. **Runtime Errors**
   - Socket not created after retries
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
