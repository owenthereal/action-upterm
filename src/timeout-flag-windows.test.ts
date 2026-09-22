// Regression test for Windows timeout-flag detection.
//
// On Windows the timeout flag is written by bash (in setupSessionTimeout) using
// the MSYS "/c/..." path form, which bash resolves to "C:\...". It is then read
// back by Node's fs in isTimeoutReached(). Node cannot resolve the "/c/..." form
// (it maps to "C:\c\..."), so isTimeoutReached() must check the *native* path
// instead -- the same one the flag actually lives at.
//
// This lives in its own file (rather than index.test.ts) because getUptermDirs()
// caches its result module-wide, and we need a fresh module whose os.tmpdir()
// returns a real Windows drive-letter path. The "/mock-tmp" path used elsewhere
// has no drive letter, so toMsys2Path() is a no-op there and cannot reproduce
// the bug.

jest.mock('@actions/core');

jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn(),
  extractTar: jest.fn()
}));

jest.mock('fs', () => ({
  mkdirSync: jest.fn(() => true),
  existsSync: jest.fn(() => true),
  appendFileSync: jest.fn(() => true),
  writeFileSync: jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  readFileSync: jest.fn(() => '{}'),
  rmSync: jest.fn(),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}abc123`),
  chmodSync: jest.fn(),
  promises: {access: jest.fn()}
}));

// A real Windows tmpdir has a drive letter (C:\...). This is essential:
// toMsys2Path() only produces the buggy "/c/..." form when the input path
// starts with a drive letter.
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  tmpdir: jest.fn(() => 'C:/Users/runneradmin/AppData/Local/Temp'),
  homedir: jest.fn(() => 'C:/Users/runneradmin')
}));

// Partial mock: shellEscape is a pure string function that the assertions
// below depend on producing real output. Automocking it would make every
// command string contain "undefined".
jest.mock('./helpers', () => ({
  ...jest.requireActual('./helpers'),
  execShellCommand: jest.fn(),
  launchOutsideJobObject: jest.fn(),
  sleep: jest.fn()
}));

// Kept for fs.PathLike type annotations below; the runtime handle is mockFs.
import fs from 'fs';
import path from 'path';

// Build expected paths with path.join so assertions match the runtime
// separator on every OS (backslashes on Windows, forward slashes elsewhere).
const WINDOWS_TMPDIR = 'C:/Users/runneradmin/AppData/Local/Temp';
const NATIVE_TIMEOUT_FLAG = path.join(WINDOWS_TMPDIR, 'upterm-action-abc123', 'timeout-flag');

const TIMEOUT_MESSAGE = 'Upterm session timed out - no client connected within the specified wait-timeout-minutes';

process.env.RUNNER_TEMP = WINDOWS_TMPDIR;

const READY_SESSION = {name: 'gha-3f9a1c05', status: 'ready', sessionId: 's1', sshCommand: 'ssh user@session123.upterm.dev', guestCount: 0};

function readySession(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({...READY_SESSION, ...overrides});
}

// Everything the action imports is re-acquired here. resetModules() hands the
// re-required action new mock instances; any handle captured at module scope
// would point at the old ones and see zero calls.
let core: jest.Mocked<typeof import('@actions/core')>;
let mockFs: jest.Mocked<typeof import('fs')>;
let mockedToolCache: jest.Mocked<typeof import('@actions/tool-cache')>;
let mockedExecShellCommand: jest.MockedFunction<typeof import('./helpers').execShellCommand>;
let mockedLaunchOutsideJobObject: jest.MockedFunction<typeof import('./helpers').launchOutsideJobObject>;
let mockedSleep: jest.MockedFunction<typeof import('./helpers').sleep>;
let run: typeof import('.').run;

function loadAction(): void {
  jest.resetModules();

  core = require('@actions/core');
  mockFs = require('fs');
  mockedToolCache = require('@actions/tool-cache');

  const helpers = require('./helpers');
  mockedExecShellCommand = helpers.execShellCommand;
  mockedLaunchOutsideJobObject = helpers.launchOutsideJobObject;
  mockedSleep = helpers.sleep;

  ({run} = require('.'));
}

/**
 * Default shell responses. `upterm version` must satisfy the gate, and
 * `session info` must return JSON - a bare 'foobar' would make getSession()
 * throw a JSON parse error rather than exercise the path under test.
 *
 * Responses are consumed one per lookup; the last one repeats forever, so a
 * sequence ending in a terminal status keeps monitorSession() bounded.
 */
function baselineShell(...sessionResponses: string[]): void {
  const queue = sessionResponses.length ? [...sessionResponses] : [readySession()];
  mockedExecShellCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('upterm version')) return 'Upterm version v0.30.0\n';
    if (cmd.includes('session info')) return queue.length > 1 ? (queue.shift() as string) : queue[0];
    return 'foobar';
  });
}

describe('isTimeoutReached on Windows', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    loadAction();

    Object.defineProperty(process, 'platform', {value: 'win32'});
    Object.defineProperty(process, 'arch', {value: 'x64'});

    mockedToolCache.downloadTool.mockResolvedValue('/mock/upterm.tar.gz');
    mockedToolCache.extractTar.mockResolvedValue('/mock/upterm-extract');
    mockedLaunchOutsideJobObject.mockReturnValue(undefined);
    mockedSleep.mockResolvedValue(undefined);

    baselineShell();

    // Both tests below install their own existsSync implementation, so there is
    // deliberately no shared filesystem baseline here. This getInput
    // implementation replaces the mock wholesale, so a jest-when baseline would
    // be discarded and only look live.
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'upterm-server':
          return 'ssh://myserver:22';
        case 'wait-timeout-minutes':
          return '5';
        default:
          return '';
      }
    });
    (core.getState as jest.Mock).mockReturnValue('');

    // exportXdgEnvironment() writes to the real process.env; these survive
    // between tests and would mask a missing assignment.
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {value: originalPlatform});
    Object.defineProperty(process, 'arch', {value: originalArch});
  });

  it('detects the timeout flag that bash wrote at the native path', async () => {
    // The flag file exists on disk. Node can only see it via the native
    // drive-letter path (C:/...); the MSYS "/c/..." form resolves to a
    // different, non-existent location and must therefore appear absent.
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes('id_rsa') || s.includes('id_ed25519')) return false; // force SSH key generation
      if (s.endsWith('upterm.exe')) return true; // downloaded binary is present
      if (s.includes('continue')) return false; // no /continue file
      if (s.includes('timeout-flag')) return !s.startsWith('/c/'); // visible only via the native path
      return true; // directories, logs, etc.
    });
    // Terminal fallback. The timeout check should end the loop on its first
    // iteration, so this is never reached - but without it a regression in
    // timeout detection would hang the monitoring loop and OOM the worker
    // instead of failing the assertion below.
    baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'session_ended'}));

    await run();

    // With the buggy "/c/..." path this is never logged; the session stays
    // "ready" forever and the timeout is never reported.
    expect(core.info).toHaveBeenCalledWith(TIMEOUT_MESSAGE);
  });

  it('clears a stale timeout flag from a reused temp dir instead of timing out immediately', async () => {
    // A reused temp directory (self-hosted runner, or a second invocation in
    // the same job) can still hold a timeout-flag from an earlier run. It must
    // be removed during session setup; otherwise monitorSession() would read
    // the stale flag and report a timeout before this session's timer is armed.
    let flagCleared = false;
    (mockFs.rmSync as jest.Mock).mockImplementation((p: fs.PathLike) => {
      if (p.toString().includes('timeout-flag')) flagCleared = true;
    });
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes('id_rsa') || s.includes('id_ed25519')) return false;
      if (s.endsWith('upterm.exe')) return true;
      if (s.includes('continue')) return false;
      if (s.includes('timeout-flag')) return !flagCleared && !s.startsWith('/c/'); // stale until cleared
      return true;
    });
    // The loop needs some other way out, so end the session after readiness.
    baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'session_ended'}));

    await run();

    // The stale flag is removed at the native path, and no timeout is reported
    // (the run exits via "'upterm' quit" when the session reports it ended).
    expect(mockFs.rmSync).toHaveBeenCalledWith(NATIVE_TIMEOUT_FLAG, expect.objectContaining({force: true}));
    expect(core.info).not.toHaveBeenCalledWith(TIMEOUT_MESSAGE);
  });
});
