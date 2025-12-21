# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `action-upterm`, a GitHub Action that enables SSH debugging of GitHub Actions workflows using [upterm](https://upterm.dev/) and tmux. It allows developers to connect via SSH to the runner environment for real-time debugging.

## Development Commands

- **Build**: `yarn build` - Compiles TypeScript and bundles with ncc to `lib/` directory
- **Lint**: `yarn lint` - Runs prettier check and eslint with zero warnings policy  
- **Format**: `yarn format` - Auto-fixes prettier and eslint issues
- **Test**: `yarn test` - Runs Jest test suite
- **Single test**: `yarn test -- --testNamePattern="test name"` - Run specific test
- **Start**: `yarn start` - Runs the compiled action locally

## Architecture

### Core Files
- `src/main.ts` - Entry point that calls the main `run()` function
- `src/index.ts` - Main application logic with the `run()` function that orchestrates the entire flow
- `src/helpers.ts` - Contains `execShellCommand()` utility for running shell commands
- `action.yml` - GitHub Action metadata and input definitions

### Main Flow (src/index.ts)
The application follows this sequence:
1. **Platform check** - Skips Windows (unsupported)
2. **Input validation** - Validates timeout and server inputs
3. **Install dependencies** - Downloads upterm binary and installs tmux
4. **Setup SSH** - Generates keys, configures SSH client, sets up known_hosts
5. **Start upterm session** - Creates tmux session with upterm host
6. **Monitor session** - Waits for `/continue` file or upterm exit

### Key Architecture Decisions
- Uses tmux for session management with nested sessions (`upterm-wrapper` → `upterm`)
- Platform-specific dependency installation (Linux: curl/tar, macOS: brew)
- SSH key generation and configuration for secure connections
- Socket-based upterm readiness detection
- Timeout mechanism for unattended sessions

## Testing

- Test files: `src/*.test.ts`
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
- `ssh-known-hosts`: Custom known_hosts content
- `wait-timeout-minutes`: Auto-shutdown timeout if no connections

## Critical Implementation Details

### SSH Known Hosts Handling
The action auto-generates SSH known_hosts by scanning uptermd.upterm.dev and creates @cert-authority entries. **Critical**: Only process uptermd.upterm.dev entries when generating @cert-authority lines to prevent known_hosts corruption.

### Shell Command Execution
Uses nested tmux sessions with complex shell quoting. **Critical**: Use single quotes for GitHub usernames in shell commands to prevent syntax errors in nested contexts.

### Error Diagnostics
Enhanced error reporting includes directory listings, log file contents, and links to GitHub issue tracker for better user debugging experience.