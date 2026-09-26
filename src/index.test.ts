import {when} from 'jest-when';
import path from 'path';

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
  readFileSync: jest.fn(() => '{}'),
  rmSync: jest.fn(() => undefined),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}abc123`),
  chmodSync: jest.fn(),
  promises: {
    access: jest.fn()
  }
}));

// Mock os.tmpdir() to return a consistent path for testing
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  tmpdir: jest.fn(() => '/mock-tmp'),
  homedir: jest.fn(() => '/mock-home')
}));

// Partial mock: shellEscape is a pure string function that the assertions
// below depend on producing real output. Automocking it would make every
// command string contain "undefined".
jest.mock('./helpers', () => ({
  ...jest.requireActual('./helpers'),
  execShellCommand: jest.fn(),
  sleep: jest.fn()
}));

// Kept for fs.PathLike type annotations below; the runtime handle is mockFs.
import fs from 'fs';

const DOWNLOAD_PATH = '/tmp/upterm.tar.gz';
const EXTRACT_DIR = '/tmp/upterm-unique-a1b2c3d4';

const RUNNER_TEMP = '/runner/_temp';

// Helper to get expected paths. Both dirs come from the mocked mkdtempSync,
// which appends 'abc123' to whatever prefix path.join() gave it. Built with
// path.join() rather than a hardcoded forward-slash literal: Node's path
// module uses the REAL host's separators regardless of any mocked
// process.platform, so on an actual Windows runner path.join() yields
// backslashes here too - matching the raw value production derives the same
// way (RUNNER_TEMP has no drive letter, so this is the ONLY shape difference
// to worry about for these two).
const UPTERM_DATA_DIR = path.join(RUNNER_TEMP, 'upterm-action-') + 'abc123';
const UPTERM_RUNTIME_DIR = path.join(RUNNER_TEMP, 'upterm-rt-') + 'abc123';

process.env.RUNNER_TEMP = RUNNER_TEMP;

const READY_SESSION = {name: 'gha-3f9a1c05', status: 'ready', sessionId: 's1', sshCommand: 'ssh user@session123.upterm.dev', guestCount: 0};

function readySession(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({...READY_SESSION, ...overrides});
}

// "ready" straight from upterm's record: the admin query failed, so there is no
// sshCommand and nothing to connect to yet.
const noDetail = JSON.stringify({name: 'gha-3f9a1c05', status: 'ready', sessionId: 's1'});
const endedResponse = JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'session_ended'});

function sessionInfoCalls(): number {
  return mockedExecShellCommand.mock.calls.filter(c => c[0].includes('session info')).length;
}

// Everything the action imports is re-acquired here. resetModules() hands the
// re-required action new mock instances; any handle captured at module scope
// would point at the old ones and see zero calls.
let core: jest.Mocked<typeof import('@actions/core')>;
let mockFs: jest.Mocked<typeof import('fs')>;
let mockedToolCache: jest.Mocked<typeof import('@actions/tool-cache')>;
let mockedExecShellCommand: jest.MockedFunction<typeof import('./helpers').execShellCommand>;
let mockedSleep: jest.MockedFunction<typeof import('./helpers').sleep>;
let ShellCommandError: typeof import('./helpers').ShellCommandError;
let run: typeof import('.').run;
let getUptermArchitecture: typeof import('.').getUptermArchitecture;
let getUptermDownloadUrl: typeof import('.').getUptermDownloadUrl;

function loadAction(): void {
  jest.resetModules();

  core = require('@actions/core');
  mockFs = require('fs');
  mockedToolCache = require('@actions/tool-cache');

  const helpers = require('./helpers');
  mockedExecShellCommand = helpers.execShellCommand;
  mockedSleep = helpers.sleep;
  ShellCommandError = helpers.ShellCommandError;

  ({run, getUptermArchitecture, getUptermDownloadUrl} = require('.'));
}

function baselineInputs(): void {
  when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
  when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
  when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
  when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
  when(core.getInput).calledWith('upterm-version').mockReturnValue('');
  when(core.getInput).calledWith('detached').mockReturnValue('false');
}

/**
 * Default shell responses. `upterm version` must satisfy the gate, and both
 * `upterm host` (the launch itself) and `session info` must return JSON - a
 * bare 'foobar' would make parseSessionInfo() throw rather than exercise the
 * path under test.
 *
 * Responses are consumed one per lookup, first by the launch and then by each
 * monitoring poll; the last one repeats forever, so a sequence ending in a
 * terminal status keeps waitForSession() bounded.
 */
function baselineShell(...sessionResponses: string[]): void {
  const queue = sessionResponses.length ? [...sessionResponses] : [readySession()];
  mockedExecShellCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
    if (cmd.includes('upterm host') || cmd.includes('session info')) return queue.length > 1 ? (queue.shift() as string) : queue[0];
    return 'foobar';
  });
}

/**
 * Filesystem baseline for LIFECYCLE tests.
 *
 * The default existsSync returns true for everything, which makes
 * continueFileExists() true on the first poll - so a lifecycle test would exit
 * with "'/continue' file was created" before ever consuming its session
 * response. Any test asserting on ready/ended/disconnected must use this.
 */
// Opt-in, not part of the shared beforeEach: every test that relies on the
// default '/continue' file to end the monitoring loop would break.
function fsWithoutExitFiles(): void {
  mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
    const p = filePath.toString();
    // CONTINUE_FILE_PATHS: '/continue' (unix), 'C:/msys64/continue' (win32),
    // plus $GITHUB_WORKSPACE/continue.
    if (p.endsWith('continue')) return false;
    return true;
  });
}

/**
 * State the POST action needs to see itself as the post half of a run main
 * already started. Shared by the POST action tests and the countdown tests,
 * both of which exercise runPost().
 */
function postState(overrides: Record<string, string> = {}): void {
  when(core.getState).calledWith('isPost').mockReturnValue('true');
  when(core.getState).calledWith('message').mockReturnValue('SSH: ssh user@session.upterm.dev');
  when(core.getState).calledWith('sessionName').mockReturnValue('gha-3f9a1c05');
  when(core.getState).calledWith('uptermBaseDir').mockReturnValue('/runner/_temp/upterm-action-abc');
  when(core.getState).calledWith('uptermRuntimeDir').mockReturnValue('/runner/_temp/upterm-rt-abc');
  when(core.getState).calledWith('sessionStarted').mockReturnValue('true');
  for (const [k, v] of Object.entries(overrides)) when(core.getState).calledWith(k).mockReturnValue(v);
}

describe('upterm GitHub integration', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    loadAction();

    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch
    });

    mockedSleep.mockResolvedValue(undefined);
    mockedToolCache.downloadTool.mockResolvedValue(DOWNLOAD_PATH);
    mockedToolCache.extractTar.mockResolvedValue(EXTRACT_DIR);
    // Reset fs mocks - everything exists by default (directories, the /continue file, etc.)
    mockFs.existsSync.mockImplementation(() => true);

    baselineInputs();
    baselineShell();

    // exportXdgEnvironment() writes to the real process.env; these survive
    // between tests and would mask a missing assignment.
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch
    });
  });

  describe('upterm helpers', () => {
    it('maps supported architectures correctly', () => {
      expect(getUptermArchitecture('x64')).toBe('amd64');
      expect(getUptermArchitecture('arm64')).toBe('arm64');
      expect(getUptermArchitecture('ppc64le')).toBeNull();
    });

    it('builds download url for latest release when version unset', () => {
      when(core.getInput).calledWith('upterm-version').mockReturnValue('');
      expect(getUptermDownloadUrl('linux', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz');
      expect(getUptermDownloadUrl('darwin', 'arm64')).toBe('https://github.com/owenthereal/upterm/releases/latest/download/upterm_darwin_arm64.tar.gz');
      expect(getUptermDownloadUrl('win32', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_amd64.tar.gz');
    });

    it('builds download url for specific release when version provided', () => {
      when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.30.0');
      expect(getUptermDownloadUrl('linux', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/download/v0.30.0/upterm_linux_amd64.tar.gz');
      expect(getUptermDownloadUrl('win32', 'arm64')).toBe('https://github.com/owenthereal/upterm/releases/download/v0.30.0/upterm_windows_arm64.tar.gz');
    });
  });

  describe('upterm version gate', () => {
    it('fails with an actionable message when the pinned upterm is too old', async () => {
      when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.30.0');
      mockedExecShellCommand.mockImplementation(async (cmd: string) => (cmd.includes('upterm version') ? 'Upterm version 0.30.0\n' : ''));

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('requires upterm >= v0.31.0'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('owenthereal/action-upterm@v1'));
    });

    it('refuses a version string it cannot read instead of guessing', async () => {
      mockedExecShellCommand.mockImplementation(async (cmd: string) => (cmd.includes('upterm version') ? 'upterm dev build\n' : ''));

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Could not determine the installed upterm version'));
      expect(mockedExecShellCommand).not.toHaveBeenCalledWith(expect.stringContaining('upterm host'));
    });

    it('fails with a contextual message when the version check itself cannot run', async () => {
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) {
          throw new Error('Command failed with exit code 127: upterm version\nStderr: bash: upterm: command not found');
        }
        return '';
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to check the installed upterm version'));
    });
  });

  it('should handle the main loop for windows x64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    // Check dependency installation: upterm is copied onto the MSYS2 PATH (/usr/bin).
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, `cp '${EXTRACT_DIR}/upterm.exe' /usr/bin/upterm.exe`);

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  it('copies upterm into /usr/bin so it stays on PATH inside interactive MSYS2 sessions (windows)', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    // core.addPath(extractDir) only reaches the Node process and subsequent
    // (non-MSYS2) steps via GITHUB_PATH. The interactive SSH session spawns bash
    // login shells that re-source /etc/profile with the default
    // MSYS2_PATH_TYPE=minimal, which rebuilds PATH and drops the tool-cache dir.
    // /usr/bin is always on the minimal MSYS2 PATH (it's where bash lives), so
    // copying upterm.exe there keeps it reachable once the user connects.
    expect(mockedExecShellCommand).toHaveBeenCalledWith(`cp '${EXTRACT_DIR}/upterm.exe' /usr/bin/upterm.exe`);
  });

  it('should handle the main loop for linux x64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  it('uses specified upterm version for linux downloads', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.30.0');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/download/v0.30.0/upterm_linux_amd64.tar.gz');
  });

  it('uses specified upterm version for windows downloads', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.30.0');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/download/v0.30.0/upterm_windows_amd64.tar.gz');
  });

  it('should handle the main loop for linux arm64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'arm64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  it('should handle the main loop for windows arm64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'arm64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, `cp '${EXTRACT_DIR}/upterm.exe' /usr/bin/upterm.exe`);

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  it('error handling for unsupported linux arch', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'unknown'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to install dependencies on linux: Error: Unsupported architecture for upterm: unknown. Only x64 and arm64 are supported.'));
  });

  it('error handling for unsupported windows arch', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'unknown'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to install dependencies on win32: Error: Unsupported architecture for upterm: unknown. Only x64 and arm64 are supported.'));
  });

  it('downloads and installs the upterm tarball on macos (no Homebrew), then starts a session', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_darwin_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  it('should handle invalid wait-timeout-minutes', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('invalid');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('wait-timeout-minutes must be a valid positive integer not exceeding 1440 (24 hours)');
  });

  it('should handle wait-timeout-minutes exceeding 24 hours', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1500'); // > 24 hours
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('wait-timeout-minutes must be a valid positive integer not exceeding 1440 (24 hours)');
  });

  it('should handle missing upterm-server', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('upterm-server').mockReturnValue('');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('upterm-server is required');
  });

  it('should handle shell command failures during installation', async () => {
    // Only Windows still shells out during installDependencies (copying
    // upterm.exe onto the MSYS2 PATH); linux/darwin install nothing else, so
    // there is nothing left there for a shell command to fail.
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');

    mockedExecShellCommand.mockRejectedValueOnce(new Error('Installation failed'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to install dependencies on win32: Error: Installation failed'));
  });

  it('keeps polling when the session lookup keeps failing instead of ending the session', async () => {
    // A lookup that throws is UNKNOWN, not "gone". Ending the session here
    // would let a transient registry hiccup kill a live debugging session -
    // the exact failure this change exists to remove. The loop must exit by
    // another signal (here, the continue file) instead.
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    // The launch succeeds; every monitoring lookup after it fails.
    let polls = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm version')) return Promise.resolve('Upterm version v0.31.0\n');
      if (cmd.includes('upterm host')) return Promise.resolve(readySession());
      if (cmd.includes('session info')) {
        polls++;
        return Promise.reject(new Error('Command failed with exit code 1: connection refused'));
      }
      return Promise.resolve('success');
    });

    // The continue file appears only once several lookups have failed, so the
    // loop has to have survived them to reach it.
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr.endsWith('continue')) return polls >= 4;
      return true;
    });

    await run();

    expect(polls).toBeGreaterThanOrEqual(4);
    expect(core.info).not.toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
  });

  describe('session lifecycle', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      Object.defineProperty(process, 'arch', {value: 'x64'});
    });

    it('names the upterm session and saves it for the post process', async () => {
      baselineShell(readySession(), endedResponse);

      await run();

      const launchCmd = mockedExecShellCommand.mock.calls.map(c => c[0]).find(c => c.includes('upterm host'));
      expect(launchCmd).toMatch(/--name gha-[0-9a-f]{8}/);
      expect(core.saveState).toHaveBeenCalledWith('sessionName', expect.stringMatching(/^gha-[0-9a-f]{8}$/));
    });

    it('ends monitoring on ended, including after a crash', async () => {
      // Ready first so startup succeeds, then ended - a terminal status supplied
      // during startup would fail readiness instead of exercising monitoring.
      // Without this the continue-file shortcut ends the loop before the terminal
      // response is ever read.
      fsWithoutExitFiles();
      baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'unknown', signal: 'SIGKILL'}));

      await run();

      expect(core.info).toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
      expect(core.info).toHaveBeenCalledWith('Signal: SIGKILL');
    });

    it('ends monitoring on ending, separately from ended', async () => {
      // `ending` is the brief transitional state while the host still holds the
      // name. The sequence continues to `ended` so that, were `ending` not
      // terminal, the loop would still stop - and the lookup count shows which
      // response actually ended it.
      fsWithoutExitFiles();
      baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'ending', sessionId: 's1'}), endedResponse);

      await run();

      expect(core.info).toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
      // The launch itself consumes the ready response; one monitoring lookup
      // sees `ending` and stops there.
      expect(sessionInfoCalls()).toBe(1);
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('reports the exit code when monitoring sees the session end', async () => {
      fsWithoutExitFiles();
      baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'exited', exitCode: 1}));

      await run();

      expect(core.info).toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
      expect(core.info).toHaveBeenCalledWith('Exit code: 1');
    });

    it('does not fail startup when the job summary cannot be written', async () => {
      // write() throws when GITHUB_STEP_SUMMARY is unset (older GHES, some
      // runner setups). The summary is a convenience; the session is already up.
      (core.summary.write as jest.Mock).mockRejectedValueOnce(new Error('Unable to find environment variable for $GITHUB_STEP_SUMMARY'));

      await run();

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith('ssh-command', 'ssh user@session123.upterm.dev');
      expect(core.info).toHaveBeenCalledWith('SSH command available as output: ssh user@session123.upterm.dev');
      // Monitoring (waitForSession()) was reached and ended via the default continue file.
      expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
    });

    it('says the session ended, with its exit code, when the launch itself reports it ended', async () => {
      // What a misconfigured upterm-server produces: the session has already
      // ended by the time `upterm host --detach` returns. "did not start a
      // usable session" would send the user looking for the wrong problem.
      baselineShell(JSON.stringify({name: 'gha-3f9a1c05', status: 'ended', reason: 'connect_failed', exitCode: 1}));

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Upterm session ended before it became ready (status: ended)'));
      expect(core.setFailed).not.toHaveBeenCalledWith(expect.stringContaining('did not start a usable session'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('- Reason: connect_failed'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('- Exit code: 1'));
      // A terminal session has no admin socket to query; saying its admin query
      // "did not succeed" would contradict the headline.
      expect(core.setFailed).not.toHaveBeenCalledWith(expect.stringContaining('answered from its record only'));
      // The report describes the session the launch itself observed, not a
      // separate lookup that could disagree with it.
      expect(sessionInfoCalls()).toBe(0);
    });

    it('keeps the rest of the diagnostics when the upterm log cannot be read', async () => {
      // An unreadable log must cost only its own section. Unguarded, the fs
      // error escapes collectDiagnostics() and replaces the whole report.
      const logPath = '/runner/_temp/upterm-action-abc123/state/upterm/upterm.log';
      baselineShell(JSON.stringify({name: 'gha-3f9a1c05', status: 'ready', sessionId: 's1', logPath}));
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === logPath) throw new Error(`EACCES: permission denied, open '${logPath}'`);
        return '{}';
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(`- Could not read upterm log (${logPath}): Error: EACCES: permission denied`));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Upterm did not start a usable session.'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('- Session status: ready'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('=== Troubleshooting Steps ==='));
    });

    it('ends monitoring on disconnected with its own message', async () => {
      fsWithoutExitFiles();
      baselineShell(readySession(), JSON.stringify({name: 'gha-3f9a1c05', status: 'disconnected', sessionId: 's1'}));

      await run();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('lost its connection to the server'));
      // Distinct from the ordinary quit path on purpose: an unreachable session
      // and a session that exited are different things, and the logs have to
      // say which happened.
      expect(core.info).not.toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
    });

    it('reuses the readiness result in detached mode instead of re-querying', async () => {
      // A transient admin-query failure straight after readiness must not fail a
      // healthy session.
      when(core.getInput).calledWith('detached').mockReturnValue('true');
      // Detached mode returns before monitoring, so no terminal response is needed.
      baselineShell(readySession(), noDetail);

      await run();

      expect(core.saveState).toHaveBeenCalledWith('message', 'SSH: ssh user@session123.upterm.dev');
      expect(core.setFailed).not.toHaveBeenCalled();
    });
  });

  describe('detached mode', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'linux'
      });
      Object.defineProperty(process, 'arch', {
        value: 'x64'
      });
      when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
      when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
      when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
      when(core.getState).calledWith('isPost').mockReturnValue('');
    });

    it('should save state and set outputs then exit early', async () => {
      when(core.getInput).calledWith('detached').mockReturnValue('true');

      baselineShell(readySession());

      await run();

      expect(core.saveState).toHaveBeenCalledWith('isPost', 'true');
      expect(core.saveState).toHaveBeenCalledWith('message', expect.stringContaining('ssh user@session123.upterm.dev'));
      expect(core.setOutput).toHaveBeenCalledWith('ssh-command', 'ssh user@session123.upterm.dev');
      expect(core.info).toHaveBeenCalledWith('Detached mode: workflow will continue while upterm session is active');
    });

    it('should enter normal monitoring loop when detached is false', async () => {
      when(core.getInput).calledWith('detached').mockReturnValue('false');

      await run();

      expect(core.saveState).toHaveBeenCalledWith('isPost', 'true');
      // Detached mode is the only thing that saves a message for the post step.
      expect(core.saveState).not.toHaveBeenCalledWith('message', expect.anything());
      expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
    });

    it('should fail when the session never becomes usable', async () => {
      when(core.getInput).calledWith('detached').mockReturnValue('true');

      // "ready" straight from the record, with no connect string - never usable,
      // so the launch must fail with diagnostics rather than hand detached mode
      // a session nobody can reach.
      baselineShell(noDetail);

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Upterm did not start a usable session.'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Session name: gha-'));
      // Non-terminal and detail-less: the admin query should have answered, so
      // the report says it did not.
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('- Upterm answered from its record only; its admin query did not succeed'));
      expect(core.saveState).not.toHaveBeenCalledWith('message', expect.anything());
      // The launch's own output is what failed; no separate lookup was needed.
      expect(sessionInfoCalls()).toBe(0);
    });
  });

  describe('POST action', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'linux'
      });
      Object.defineProperty(process, 'arch', {
        value: 'x64'
      });
    });

    it('keeps waiting when a lookup throws instead of reporting the session gone', async () => {
      // 'unknown' must not collapse into 'gone': a transient registry hiccup
      // ending a live debugging session is the failure this change removes.
      postState();
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        throw new Error('Command failed with exit code 2\nStderr: registry unavailable');
      });
      mockFs.existsSync.mockImplementation(() => polls >= 5);

      await run();

      expect(core.info).not.toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
    });

    it('warns about a persistently failing lookup without spending the countdown', async () => {
      // 'unknown' skips every break AND the countdown, so a lookup that fails on
      // every iteration leaves the loop with no exit at all. core.debug is
      // invisible at default verbosity, so the only symptom was a number that
      // never moved. The deferral stays (spending the countdown could kill a
      // session someone attached to before any poll succeeded) - the failure
      // just has to be VISIBLE.
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');

      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        throw new Error('Command failed with exit code 2\nStderr: registry unavailable');
      });
      // Run past the 12 waits a 1-minute timeout would take, so the countdown
      // assertion below is a real one, and past the 12th consecutive failure so
      // the periodic repeat fires too.
      mockFs.existsSync.mockImplementation(() => polls >= 18);

      await run();

      expect(polls).toBeGreaterThanOrEqual(18);
      // Loud, and it names the actual error rather than just "unknown".
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Could not query the upterm session (attempt 1)'));
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('registry unavailable'));
      const lookupWarnings = core.warning.mock.calls.filter(c => String(c[0]).includes('Could not query the upterm session'));
      // First failure, then periodically - not once per poll, which would bury
      // the log it exists to make readable.
      expect(lookupWarnings.length).toBeGreaterThanOrEqual(2);
      expect(lookupWarnings.length).toBeLessThan(polls);
      // The countdown still does NOT advance on an unknown.
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for client to connect'));
    });

    it('reaches teardown via the normal exit when the post-step lookup keeps failing', async () => {
      // pollSession() swallows the lookup failure into 'unknown', so this loop
      // exits normally (via the continue file), not via an exception. It does
      // NOT exercise the finally - see the next test for that.
      postState();
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        throw new Error('Command failed with exit code 2\nStderr: registry unavailable');
      });
      // A thrown lookup is UNKNOWN, which defers the countdown - so the loop needs
      // the continue file to end, or this test would never return.
      mockFs.existsSync.mockImplementation(() => polls >= 3);

      await run();

      expect(mockFs.rmSync).toHaveBeenCalledWith('/runner/_temp/upterm-action-abc', {recursive: true, force: true});
    });

    it('tears down even when the post loop throws', async () => {
      // Unlike pollSession(), which swallows a lookup failure into 'unknown',
      // continueFileExists() calls fs.existsSync unguarded - a real fs error
      // there (e.g. an intermittent read failure) escapes the try untouched.
      // This is the case the try/finally exists for: without it, deleting the
      // finally and simply appending finalizeSession() after the loop would
      // never run, because the loop itself never returns normally.
      postState();
      mockFs.existsSync.mockImplementation(() => {
        throw new Error("EIO: i/o error, stat '/continue'");
      });

      await run();

      expect(mockFs.rmSync).toHaveBeenCalledWith('/runner/_temp/upterm-action-abc', {recursive: true, force: true});
      expect(mockFs.rmSync).toHaveBeenCalledWith('/runner/_temp/upterm-rt-abc', {recursive: true, force: true});
    });

    it('does not fail the job when cleanup cannot remove a directory', async () => {
      // On Windows the upterm process can still be releasing its own open
      // handle on state/upterm/upterm.log a moment after stop; rmSync
      // defaults to maxRetries 0, so EBUSY must not turn a successful debug
      // session into a failed job.
      postState();
      mockFs.rmSync.mockImplementation(() => {
        throw new Error('EBUSY: resource busy or locked');
      });

      await run();

      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should wait for session and exit when the session ends', async () => {
      when(core.getState).calledWith('isPost').mockReturnValue('true');
      when(core.getState).calledWith('message').mockReturnValue('SSH: ssh user@session.upterm.dev');
      when(core.getState).calledWith('sessionName').mockReturnValue('gha-3f9a1c05');
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');

      mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
        const pathStr = path.toString();
        if (pathStr === '/continue' || pathStr.includes('continue')) {
          return false;
        }
        return true;
      });
      baselineShell(endedResponse);

      await run();

      expect(core.info).toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
      expect(core.info).toHaveBeenCalledWith('Reason: session_ended');
    });

    it('should return early when not in detached mode', async () => {
      when(core.getState).calledWith('isPost').mockReturnValue('true');
      when(core.getState).calledWith('message').mockReturnValue('');

      await run();

      expect(core.debug).not.toHaveBeenCalledWith('Waiting for session to end');
      expect(mockedExecShellCommand).not.toHaveBeenCalled();
    });

    it('should exit when continue file is created', async () => {
      when(core.getState).calledWith('isPost').mockReturnValue('true');
      when(core.getState).calledWith('message').mockReturnValue('SSH: ssh user@session.upterm.dev');
      when(core.getState).calledWith('sessionName').mockReturnValue('gha-3f9a1c05');
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('10');

      mockFs.existsSync.mockReturnValue(true);
      baselineShell(readySession());

      await run();

      expect(core.info).toHaveBeenCalledWith("Exiting debugging session because '/continue' file was created");
    });
  });

  describe('launch', () => {
    const launchCall = () => mockedExecShellCommand.mock.calls.map(c => c[0]).find(c => c.includes('upterm host'));

    beforeEach(() => {
      fsWithoutExitFiles();
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) return readySession();
        if (cmd.includes('session info')) return endedResponse;
        return '';
      });
    });

    it('starts the session with upterm host --detach and nothing else', async () => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      await run();
      const cmd = launchCall();
      expect(cmd).toMatch(/^upterm host --detach --accept --output json --name gha-[0-9a-f]{8} --skip-host-key-check --server 'ssh:\/\/myserver:22'$/);
      const all = mockedExecShellCommand.mock.calls.map(c => c[0]).join('\n');
      expect(all).not.toMatch(/tmux|ssh-keygen|Invoke-CimMethod/);
      expect(mockFs.appendFileSync).not.toHaveBeenCalledWith(expect.stringContaining('.ssh'), expect.anything());
    });

    it('authorizes each allowed user as github:NAME', async () => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      when(core.getInput).calledWith('limit-access-to-users').mockReturnValue("alice, o'brien");
      when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('true');
      await run();
      const cmd = launchCall() as string;
      expect(cmd).toContain("--authorized-user 'github:alice'");
      expect(cmd).toContain("--authorized-user 'github:o'\\''brien'");
      expect(cmd).not.toContain('--github-user');
    });

    it('hosts MSYS2 login bash on Windows, as v1 did', async () => {
      Object.defineProperty(process, 'platform', {value: 'win32'});
      Object.defineProperty(process, 'arch', {value: 'x64'});
      await run();
      expect(launchCall()).toMatch(/ -- bash -l$/);
    });

    it('publishes the ssh command from the launch output without polling for readiness', async () => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      await run();
      expect(core.setOutput).toHaveBeenCalledWith('ssh-command', 'ssh user@session123.upterm.dev');
      const launchIndex = mockedExecShellCommand.mock.calls.findIndex(c => c[0].includes('upterm host'));
      const firstInfo = mockedExecShellCommand.mock.calls.findIndex(c => c[0].includes('session info'));
      expect(firstInfo).toBeGreaterThan(launchIndex);
    });

    it('reports upterm’s own error and the session diagnostics when the launch fails', async () => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) throw new Error('Command failed with exit code 1\nStderr: Error: session gha-x could not start: dial tcp: connection refused');
        if (cmd.includes('session info')) return JSON.stringify({name: 'gha-x', status: 'ended', reason: 'startup_failed'});
        return '';
      });
      await run();
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('startup_failed'));
      expect(core.setFailed).not.toHaveBeenCalledWith(expect.stringMatching(/tmux/i));
    });

    it('fails when upterm reports a session with no ssh command', async () => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) return noDetail;
        if (cmd.includes('session info')) return noDetail;
        return '';
      });
      await run();
      expect(core.setFailed).toHaveBeenCalled();
    });

    it('fails when the launch itself reports a terminal status, even with an ssh command, and never publishes it', async () => {
      // upterm's printStarted can report "disconnected" (the record's status
      // the instant the tunnel dropped) alongside a claim that still carries
      // an sshCommand (host/api response captured moments earlier) -
      // spawned.go:298-327. A connect string for a session already gone can
      // never connect, so a terminal status must fail the run even though
      // sshCommand is non-empty.
      Object.defineProperty(process, 'platform', {value: 'linux'});
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) return JSON.stringify({name: 'gha-x', status: 'disconnected', sshCommand: 'ssh x@y'});
        if (cmd.includes('session info')) return JSON.stringify({name: 'gha-x', status: 'disconnected', sshCommand: 'ssh x@y'});
        return '';
      });
      await run();
      expect(core.setFailed).toHaveBeenCalled();
      expect(core.setOutput).not.toHaveBeenCalledWith('ssh-command', expect.anything());
    });
  });

  describe('teardown', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      fsWithoutExitFiles();
    });

    it('stops the session by name, then removes its directories, and never mints new ones', async () => {
      postState();
      mockedExecShellCommand.mockImplementation(async (cmd: string) => (cmd.includes('session info') ? endedResponse : ''));
      await run();
      const stopIndex = mockedExecShellCommand.mock.calls.findIndex(c => c[0].includes('upterm session stop gha-3f9a1c05'));
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(mockedExecShellCommand.mock.invocationCallOrder[stopIndex]).toBeLessThan(mockFs.rmSync.mock.invocationCallOrder[0]);
      expect(mockFs.mkdtempSync).not.toHaveBeenCalled();
    });

    it('exports the saved XDG directories before stopping, in attached mode too', async () => {
      // Attached mode saves no message; its post step goes straight to teardown,
      // and session stop resolves the session through XDG_STATE_HOME.
      postState({message: ''});
      mockedExecShellCommand.mockImplementation(async () => '');
      delete process.env.XDG_STATE_HOME;
      await run();
      expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('upterm session stop gha-3f9a1c05'), expect.anything());
      expect(process.env.XDG_STATE_HOME).toBeDefined();
    });

    it('on windows, with a drive-letter RUNNER_TEMP, XDG_STATE_HOME is already MSYS-form when session stop is called', async () => {
      // A drive-letter RUNNER_TEMP (e.g. C:\runner\_temp), as a real Windows
      // runner sets it - not the POSIX-style RUNNER_TEMP the rest of this
      // suite uses. Pins two things at once: the win32 conversion
      // (XDG_STATE_HOME must be /c/... for upterm.exe's own child processes,
      // never C:/...) and that exportXdgEnvironment() runs before stopSession()
      // - captured from inside the mock, at the moment the command is built,
      // not after run() resolves, so a regression in either would be caught.
      Object.defineProperty(process, 'platform', {value: 'win32'});
      postState({
        uptermBaseDir: 'C:\\runner\\_temp\\upterm-action-abc',
        uptermRuntimeDir: 'C:\\runner\\_temp\\upterm-rt-abc',
        message: ''
      });
      let capturedXdgStateHome: string | undefined;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('session stop')) capturedXdgStateHome = process.env.XDG_STATE_HOME;
        return '';
      });
      await run();
      expect(capturedXdgStateHome).toBe('/c/runner/_temp/upterm-action-abc/state');
    });

    it('does not stop anything when this run never started a session, but still removes its directories', async () => {
      postState({sessionStarted: '', message: ''});
      await run();
      expect(mockedExecShellCommand).not.toHaveBeenCalledWith(expect.stringContaining('session stop'), expect.anything());
      expect(mockFs.rmSync).toHaveBeenCalledWith('/runner/_temp/upterm-action-abc', {recursive: true, force: true});
    });

    it('treats exit 4 from session stop as a quiet no-op, like getSession does for lookups', async () => {
      // A launch that failed part-way (sessionStarted saved, but the record
      // never got written) leaves nothing for `session stop` to find; upterm
      // says so with exit 4. Warning about it every time is noise for an
      // expected case - debug only, same treatment getSession() gives a
      // "not found" lookup.
      postState({message: ''});
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('session stop')) throw new ShellCommandError('Command failed with exit code 4: upterm session stop gha-3f9a1c05\nStderr: no session named "gha-3f9a1c05"', 4);
        return '';
      });
      await run();
      expect(core.warning).not.toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.debug).toHaveBeenCalledWith(expect.stringContaining('no session named'));
    });

    it('warns when session stop fails any other way, even with "no session named" in its text', async () => {
      postState({message: ''});
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('session stop')) throw new ShellCommandError('Command failed with exit code 1: upterm session stop gha-3f9a1c05\nStderr: no session named "gha-3f9a1c05"', 1);
        return '';
      });
      await run();
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Could not stop upterm session gha-3f9a1c05'));
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('stops the session through bash when the post step is interrupted', async () => {
      postState();
      mockedExecShellCommand.mockImplementation(async (cmd: string) => (cmd.includes('session info') ? readySession() : ''));
      // Park the wait loop at its first sleep, so the signal arrives mid-wait
      // rather than racing a loop that mocked sleeps would spin through.
      mockedSleep.mockImplementation(() => new Promise<void>(() => {}));
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const listeners: Array<() => Promise<void> | void> = [];
      const on = jest.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
        if (event === 'SIGINT') listeners.push(fn);
        return process;
      }) as never);
      try {
        void run(); // never settles: the loop is parked; not awaited on purpose
        await new Promise(r => setImmediate(r));
        expect(listeners).toHaveLength(1);
        await listeners[0]();
        expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('upterm session stop gha-3f9a1c05'), expect.anything());
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        on.mockRestore();
        exit.mockRestore();
      }
    });
  });

  describe('countdown (both modes)', () => {
    const sessionStops = () => mockedExecShellCommand.mock.calls.filter(c => c[0].includes('session stop')).length;

    // Collect console.log lines: the loop reports progress there, not via core.*.
    function captureLog(): {lines: string[]; restore: () => void} {
      const lines: string[] = [];
      const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
      return {lines, restore: () => spy.mockRestore()};
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', {value: 'linux'});
      Object.defineProperty(process, 'arch', {value: 'x64'});
      fsWithoutExitFiles();
    });

    it('detached: with nobody ever joining, stops the session when the countdown runs out', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // Backstop: a regression that stops the countdown from firing must
        // fail an assertion below, not hang the suite forever.
        return polls < 500 ? readySession() : endedResponse;
      });

      await run();

      expect(sessionStops()).toBeGreaterThanOrEqual(1);
      expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('upterm session stop gha-3f9a1c05'), expect.anything());
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for client to connect'));
    });

    it('detached: a join published before the post step disarms the countdown for good', async () => {
      // A guest joined during the build and left before the post step: guestCount
      // is 0 now, but upterm recorded the join.
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // Far past the 12 waits a 1-minute countdown would need, then end.
        return polls < 30 ? readySession({guestCount: 0, firstGuestJoinedAt: '2026-09-23T04:12:15Z'}) : endedResponse;
      });
      const log = captureLog();
      try {
        await run();
      } finally {
        log.restore();
      }

      expect(polls).toBeGreaterThanOrEqual(30);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      expect(log.lines.some(l => l.startsWith('Waiting for session to end'))).toBe(true);
      expect(log.lines.some(l => l.includes('Waiting for client to connect'))).toBe(false);
    });

    it('detached: a guest who came and went between two polls still disarms it', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        if (polls <= 3) return readySession({guestCount: 0});
        // Never observed present (guestCount 0 on every poll), only recorded.
        if (polls < 40) return readySession({guestCount: 0, firstGuestJoinedAt: '2026-09-23T04:12:15Z'});
        return endedResponse;
      });

      await run();

      expect(polls).toBeGreaterThanOrEqual(40);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('A guest joined'));
    });

    it('never treats guestCount as a join', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // Forwarding-only presence: counted, never a qualifying join. Backstop
        // at 500 so a regression fails an assertion instead of hanging.
        return polls < 500 ? readySession({guestCount: 1}) : endedResponse;
      });

      await run();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for client to connect'));
    });

    it('re-checks right before stopping, and does not stop a session a guest just joined', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // 12 no-guest polls spend the minute; the 13th regular poll still sees
        // nobody and finds the countdown at zero; the 14th lookup is the final
        // re-check, and it is the one that sees the join. (Were the 13th to see
        // it, the ordinary poll would disarm and this would not test the re-check.)
        if (polls <= 13) return readySession();
        if (polls < 20) return readySession({firstGuestJoinedAt: '2026-09-23T04:13:00Z'});
        return endedResponse;
      });

      await run();

      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      // Exactly one: teardown's own unconditional stop, never a second one from
      // the countdown itself - the re-check saw the join and disarmed it.
      expect(sessionStops()).toBe(1);
      expect(polls).toBeGreaterThanOrEqual(20);
    });

    it('does not stop when the final re-check itself fails, and tries again once a later lookup succeeds', async () => {
      // A failed lookup never spends the countdown and never ends the wait -
      // that includes the final re-check right before stopping. A regular poll
      // that fails is already covered elsewhere; this is the re-check specifically.
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // 12 no-guest polls spend the minute; the 13th (regular) and 14th
        // (re-check) both fail; a guest is then seen joined, then the session ends.
        if (polls <= 12) return readySession();
        if (polls <= 14) throw new Error('Command failed with exit code 2\nStderr: registry unavailable');
        if (polls < 20) return readySession({firstGuestJoinedAt: '2026-09-23T04:14:00Z'});
        return endedResponse;
      });

      await run();

      // Exactly one: teardown's own unconditional stop, never a second one from
      // the countdown itself - the re-check's retry saw the join and disarmed it.
      expect(sessionStops()).toBe(1);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      expect(polls).toBeGreaterThanOrEqual(20);
    });

    it('does not stop or warn when the final re-check finds the session already ended', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // 12 no-guest polls spend the minute; the 13th regular poll still sees
        // nobody and finds the countdown at zero; the 14th lookup is the final
        // re-check, and it is the one that finds the session already ended.
        if (polls <= 13) return readySession();
        return endedResponse;
      });

      await run();

      // Exactly one: teardown's own unconditional stop, never a second one from
      // the countdown itself - the re-check found the session already ended.
      expect(sessionStops()).toBe(1);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      expect(core.info).toHaveBeenCalledWith("Exiting debugging session: 'upterm' quit");
      expect(polls).toBe(14);
    });

    it('does not spend the countdown on lookups that fail', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        if (polls < 30) throw new Error('Command failed with exit code 2\nStderr: registry unavailable');
        return endedResponse;
      });

      await run();

      expect(polls).toBeGreaterThanOrEqual(30);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
    });

    it('detached: defaults to 10 minutes when wait-timeout-minutes is unset', async () => {
      postState();
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('session info')) return '';
        polls++;
        // Backstop: a regression that stops the countdown from firing must
        // fail an assertion below, not hang the suite forever.
        return polls < 500 ? readySession() : endedResponse;
      });

      await run();

      // 120 polls spend 10 minutes at 5 s each; the 121st finds the countdown
      // at zero; the 122nd is the final re-check before stopping.
      expect(polls).toBe(122);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for client to connect'));
    });

    it('attached: counts down from readiness only when wait-timeout-minutes is set', async () => {
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('1');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) return readySession();
        if (!cmd.includes('session info')) return '';
        polls++;
        // Backstop: a regression that stops the countdown from firing must
        // fail an assertion below, not hang the suite forever.
        return polls < 500 ? readySession() : endedResponse;
      });

      await run();

      expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('upterm session stop gha-'), expect.anything());
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for client to connect'));
    });

    it('attached: without wait-timeout-minutes, waits for the session to end and never stops it itself', async () => {
      when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
      let polls = 0;
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version 0.31.0\n';
        if (cmd.includes('upterm host')) return readySession();
        if (!cmd.includes('session info')) return '';
        polls++;
        return polls < 200 ? readySession() : endedResponse;
      });

      await run();

      expect(polls).toBe(200);
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      expect(sessionStops()).toBe(0);
    });
  });

  describe('private per-run directories', () => {
    afterEach(() => {
      // Some tests below point RUNNER_TEMP elsewhere; the rest of the file
      // assumes the module-level value.
      process.env.RUNNER_TEMP = RUNNER_TEMP;
    });

    it('creates private per-run directories rooted at RUNNER_TEMP', async () => {
      await run();

      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join('/runner/_temp', 'upterm-action-'));
      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join('/runner/_temp', 'upterm-rt-'));
      expect(mockFs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('upterm-rt-'), 0o700);
      // RUNNER_TEMP fit, so nothing fell back and there is nothing to explain.
      expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining("for upterm's runtime directory"));
    });

    it('keeps the runtime directory under a self-hosted RUNNER_TEMP that fits the socket budget', async () => {
      // GitHub's default self-hosted layout. With the old `upterm-runtime-`
      // prefix the socket path here was 105 bytes and upterm refused it; the
      // shorter prefix brings it to 100, inside the 103-byte limit.
      const selfHosted = '/home/azureuser/actions-runner/_work/_temp';
      process.env.RUNNER_TEMP = selfHosted;

      await run();

      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join(selfHosted, 'upterm-rt-'));
      expect(core.saveState).toHaveBeenCalledWith('uptermRuntimeDir', path.join(selfHosted, 'upterm-rt-') + 'abc123');
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('falls back to os.tmpdir() for the runtime directory when RUNNER_TEMP is too long for upterm', async () => {
      // 47 bytes: the socket path under it would be 105, over upterm's 103, and
      // `upterm host --name` would exit before creating any session.
      const longRunnerTemp = '/Users/administrator/actions-runner/_work/_temp';
      process.env.RUNNER_TEMP = longRunnerTemp;

      await run();

      // Runtime under os.tmpdir() (mocked to /mock-tmp); the base dir holds no
      // sockets, so it stays under RUNNER_TEMP.
      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join('/mock-tmp', 'upterm-rt-'));
      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join(longRunnerTemp, 'upterm-action-'));
      expect(mockFs.mkdtempSync).not.toHaveBeenCalledWith(path.join(longRunnerTemp, 'upterm-rt-'));
      // The post step restores and removes whatever was saved, wherever it is.
      expect(core.saveState).toHaveBeenCalledWith('uptermRuntimeDir', path.join('/mock-tmp', 'upterm-rt-') + 'abc123');
      expect(process.env.XDG_RUNTIME_DIR).toBe((path.join('/mock-tmp', 'upterm-rt-') + 'abc123').replace(/\\/g, '/'));
      // A self-hosted user can see where the sockets went, and why.
      const fallbackInfo = core.info.mock.calls.map(c => String(c[0])).filter(m => m.includes("for upterm's runtime directory"));
      expect(fallbackInfo).toHaveLength(1);
      expect(fallbackInfo[0]).toContain('/mock-tmp');
      expect(fallbackInfo[0]).toContain('105 bytes');
      expect(fallbackInfo[0]).toContain('103-byte');
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('fails with an actionable message, before launching upterm, when no candidate fits the socket budget', async () => {
      // Windows has no /tmp fallback, so a long RUNNER_TEMP and a long TEMP
      // leave nowhere to put the sockets.
      Object.defineProperty(process, 'platform', {value: 'win32'});
      Object.defineProperty(process, 'arch', {value: 'x64'});
      process.env.RUNNER_TEMP = 'C:/Users/administrator/actions-runner/_work/_temp';
      // Re-acquired after loadAction(): resetModules() recreated the os mock.
      const os = require('os');
      (os.tmpdir as jest.Mock).mockReturnValue('C:/Users/a-very-long-user-name/AppData/Local/Temp');

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('103-byte limit'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('TMP/TEMP'));
      // Names each measured path and its length.
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('107 bytes'));
      expect(mockedExecShellCommand).not.toHaveBeenCalledWith(expect.stringContaining('upterm host'));
      expect(core.saveState).not.toHaveBeenCalledWith('sessionStarted', 'true');
      expect(mockFs.mkdtempSync).not.toHaveBeenCalledWith(expect.stringContaining('upterm-rt-'));
    });

    it('exports XDG_STATE_HOME so session lookups find the record', async () => {
      await run();

      // session info resolves the record through XDG_STATE_HOME; if the action's
      // own shell disagrees with the host, a live session reports as missing.
      // Assert the EXACT values: state and config both live under the base dir,
      // so a substring match on 'upterm-action-' cannot tell them apart - and
      // would not notice the two being swapped, or config never being set.
      //
      // exportXdgEnvironment() always converts through toShellPath/toMsys2Path
      // before assigning these - Shape B, forward slashes only - unlike the raw
      // UPTERM_DATA_DIR/UPTERM_RUNTIME_DIR constants, which are Shape A.
      expect(process.env.XDG_STATE_HOME).toBe(path.join(UPTERM_DATA_DIR, 'state').replace(/\\/g, '/'));
      expect(process.env.XDG_CONFIG_HOME).toBe(path.join(UPTERM_DATA_DIR, 'config').replace(/\\/g, '/'));
      expect(process.env.XDG_RUNTIME_DIR).toBe(UPTERM_RUNTIME_DIR.replace(/\\/g, '/'));
    });

    it('saves the directories for the post process', async () => {
      await run();

      expect(core.saveState).toHaveBeenCalledWith('uptermBaseDir', UPTERM_DATA_DIR);
      expect(core.saveState).toHaveBeenCalledWith('uptermRuntimeDir', UPTERM_RUNTIME_DIR);
    });
  });
});
