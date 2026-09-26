# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `action-upterm`, a GitHub Action that enables SSH debugging of GitHub Actions workflows using [upterm](https://upterm.dev/). It allows developers to connect via SSH to the runner environment for real-time debugging.

## Development Commands

- **Build**: `yarn build` - Compiles TypeScript and bundles with ncc to `lib/` directory
- **Lint**: `yarn lint` - Runs prettier check and eslint with zero warnings policy  
- **Format**: `yarn format` - Auto-fixes prettier and eslint issues
- **Test**: `yarn test` - Runs Jest test suite
- **Single test**: `yarn test -- --testNamePattern="test name"` - Run specific test
- **Start**: `yarn start` - Runs the compiled action locally

## Architecture

See ARCHITECTURE.md for the full picture (the four `upterm` calls, the wait loop's join latch, teardown order, how the daemon survives the launching step and gets reaped, and cross-platform path handling).

### Core Files
- `src/main.ts` - Entry point that calls the main `run()` function
- `src/index.ts` - Main application logic: installs upterm, starts the session, runs the wait loop, and tears down in post
- `src/session.ts` - Session types and helpers: parses `upterm session info -o json`, `isNoSuchSession()` (upterm's exit 4), `hasGuestJoined()`, `waitStatusLine()`, the upterm version gate
- `src/helpers.ts` - Contains `execShellCommand()` (runs every shell command through bash, `C:\msys64\usr\bin\bash.exe -lc` on Windows) and `shellEscape()`; a non-zero exit rejects with `ShellCommandError`, which carries `exitCode`
- `action.yml` / `detached/action.yml` - GitHub Action metadata and input definitions (kept in sync by CI; the latter's `main`/`post` point at `../lib/index.js` and `detached` defaults to `"true"`)

### Main Flow (src/index.ts `run()`)
1. **Post-step detection** - `core.getState('isPost') === 'true'` routes straight to `runPost()` (teardown) instead of re-running main
2. **Input validation** - `validateInputs()` checks `wait-timeout-minutes` and requires `upterm-server`
3. **Install upterm** - `installDependencies()` downloads the platform binary; on Windows it's also copied into MSYS2's `/usr/bin` so it's on the hosted login shell's PATH
4. **Version gate** - `assertSupportedUptermVersion()` refuses upterm `< v0.32.0`, including an unparseable version string
5. **Start the session** - `launchSession()` runs `upterm host --detach --accept --output json --name gha-XXXXXXXX --skip-host-key-check --server <server> [--authorized-user github:NAME ...] [--join-timeout Nm, attached mode only] [-- bash -l on Windows]`; its JSON stdout is the ready session, so there is no separate readiness poll
6. **Detached or attached** - detached mode publishes the SSH command/notice and returns immediately, letting the job's remaining steps run; the post step then runs `armJoinTimeout()` (`upterm session set <name> --join-timeout Nm`, default 10) and the same wait loop. Attached mode calls the wait loop directly.
7. **Wait** - `waitForSession()` polls `upterm session info` every 5s, logging the time left before upterm's join deadline, until the continue file appears, the session reaches a terminal status, or upterm reports no such session (exit 4). upterm itself ends a session nobody joined; the wait never stops a session. The post step's teardown runs `upterm session stop <name>`.

### Key Architecture Decisions
- upterm hosts the session itself via `upterm host --detach`, with no external session manager or process-launch trampoline; the runner's own orphan sweep reaps the daemon at "Complete job" on every OS
- **All upterm calls go through `execShellCommand`** (src/helpers.ts) - there is no direct `spawn` of `upterm` anywhere else, so every call gets the same bash launch and the same Windows MSYS2 environment
- Sessions are addressed by name (`gha-<8 hex>`, minted once and saved via `core.saveState`), never by discovering a socket path on disk
- **upterm owns the join deadline** (v0.32.0+): attached mode passes `--join-timeout` at launch, and detached mode's post step runs `upterm session set --join-timeout` once the job's regular steps are done. The action only observes - no client-side countdown, no read-then-stop - so a guest can never be kicked between a read and a stop. The log's join latch is `firstGuestJoinedAt` (`hasGuestJoined()`), **never `guestCount`**, for two binding reasons: `guestCount` counts forwarding-only presence, which is not a qualifying join, and it is a current count rather than an event, so it misses a guest who joined and left again between two polls. Once a join has been seen the countdown line never returns, and join state upterm read from its record (`joinStateSource` not `daemon`) is logged as unconfirmed.
- **"Gone" is upterm's exit code 4** (`isNoSuchSession()`), never text matched in stderr. Any other lookup failure is "unknown" and never ends the wait.
- **No `upterm session wait`**: its exit cannot end the wait by itself (125 on its own lookup failures; never returns for `disconnected`), and on Windows killing it through bash leaves upterm.exe holding Node's pipes. The 5 s poll is enough.
- Deterministic XDG directories (`XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`) are minted per run and exported to `process.env` by `exportXdgEnvironment()`, called by both main and post, so every `upterm` call in either process resolves the same session record

## Testing

- Test files: `src/*.test.ts` (notably `src/index.test.ts` and `src/session.test.ts`)
- Jest configuration with TypeScript support
- Mocked @actions/core and @actions/github modules for isolated testing
- Coverage collection excludes main.ts (entry point)
- Tests mock filesystem operations and shell commands for reliability

## Build Output

- Compiled code goes to `lib/` directory
- Uses @vercel/ncc for bundling into a single file
- GitHub Actions runs `lib/index.js` as specified in action.yml

## Inputs (action.yml)

- `limit-access-to-actor`: Restrict to workflow triggerer's SSH keys
- `limit-access-to-users`: Comma-separated list of authorized GitHub users
- `upterm-server`: Server address (required, default: ssh://uptermd.upterm.dev:22)
- `wait-timeout-minutes`: Join timeout: upterm ends the session if no guest has joined by then; in detached mode, it starts after all regular steps finish
- `upterm-version`: Version/tag to install; requires v0.32.0 or newer
- `detached`: If `true`, the workflow continues after the session starts, and the wait moves to the post step

## Critical Implementation Details

### The version gate exists because the deadline lives in upterm
`assertSupportedUptermVersion()` refuses upterm `< v0.32.0` (and any version string it cannot parse) because v0.32.0 is the first release with `upterm session set`, the daemon-owned join deadline and its `joinDeadline`/`joinStateSource` fields, and exit 4 for "no session named". Without them the post step could not open the join window, and a gone session would read as a failed lookup for ever - guessing at an unknown version is exactly as unsafe as running an old one, so both are refused, not warned about.

### Error Diagnostics
`collectDiagnostics()` (src/index.ts) reports the run's private directories, the session's status and reason/exit code/signal, upterm's own log (read from `session.logPath` under `XDG_STATE_HOME`), and an `upterm version` check - with a link to the issue tracker for anything not covered above.
