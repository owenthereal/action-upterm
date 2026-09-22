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
  readdirSync: jest.fn(() => ['id_rsa', 'id_ed25519']),
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
  launchOutsideJobObject: jest.fn(),
  sleep: jest.fn()
}));

// Kept for fs.PathLike type annotations below; the runtime handle is mockFs.
import fs from 'fs';

const DOWNLOAD_PATH = '/tmp/upterm.tar.gz';
const EXTRACT_DIR = '/tmp/upterm-unique-a1b2c3d4';

// Helper to get expected paths. Both dirs come from the mocked mkdtempSync,
// which appends 'abc123' to whatever prefix it was given.
const UPTERM_DATA_DIR = '/runner/_temp/upterm-action-abc123';
const UPTERM_RUNTIME_DIR = '/runner/_temp/upterm-runtime-abc123';
const TIMEOUT_FLAG_PATH = path.join(UPTERM_DATA_DIR, 'timeout-flag');

process.env.RUNNER_TEMP = '/runner/_temp';

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
let mockedLaunchOutsideJobObject: jest.MockedFunction<typeof import('./helpers').launchOutsideJobObject>;
let mockedSleep: jest.MockedFunction<typeof import('./helpers').sleep>;
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
  mockedLaunchOutsideJobObject = helpers.launchOutsideJobObject;
  mockedSleep = helpers.sleep;

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

/**
 * Filesystem baseline for LIFECYCLE tests.
 *
 * The default existsSync returns true for everything but SSH keys, which makes
 * continueFileExists() true on the first poll - so a lifecycle test would exit
 * with "'/continue' file was created" before ever consuming its session
 * response. Any test asserting on ready/ended/disconnected must use this.
 */
// Opt-in, not part of the shared beforeEach: every test that relies on the
// default '/continue' file to end the monitoring loop would break.
function fsWithoutExitFiles(): void {
  mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
    const p = filePath.toString();
    if (p.includes('id_rsa') || p.includes('id_ed25519')) return false;
    // CONTINUE_FILE_PATHS: '/continue' (unix), 'C:/msys64/continue' (win32),
    // plus $GITHUB_WORKSPACE/continue.
    if (p.endsWith('continue')) return false;
    if (p.includes('timeout-flag')) return false;
    return true;
  });
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
    // Reset fs mocks - by default return false for SSH key files to trigger generation
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      // SSH key files don't exist initially, so they get generated
      if (pathStr.includes('id_rsa') || pathStr.includes('id_ed25519')) {
        return false;
      }
      // Everything else exists (directories, the /continue file, etc.)
      return true;
    });
    (mockFs.readdirSync as jest.Mock).mockReturnValue(['id_rsa', 'id_ed25519']);

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
      when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.20.0');
      mockedExecShellCommand.mockImplementation(async (cmd: string) => (cmd.includes('upterm version') ? 'Upterm version v0.20.0\n' : ''));

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('requires upterm >= v0.30.0'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('v1.15.0'));
    });

    it('proceeds with a warning when the version string is unrecognized', async () => {
      mockedExecShellCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('upterm version')) return 'Upterm version dev\n';
        // The run must actually proceed past the gate, so the session lookup
        // has to answer with real JSON rather than an empty string.
        if (cmd.includes('session info')) return readySession();
        return '';
      });

      await run();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Could not determine the installed upterm version'));
      expect(core.setFailed).not.toHaveBeenCalled();
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

    // Check dependency installation: upterm is copied onto the MSYS2 PATH
    // (/usr/bin) first, then tmux is installed.
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, `cp '${EXTRACT_DIR}/upterm.exe' /usr/bin/upterm.exe`);
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation via WMI on Windows
    expect(mockedLaunchOutsideJobObject).toHaveBeenCalledWith(expect.stringContaining('tmux -f'), expect.objectContaining({PATH: expect.any(String)}));
    expect(mockedLaunchOutsideJobObject).toHaveBeenCalledWith(expect.stringContaining(`${UPTERM_DATA_DIR}/tmux.conf`), expect.objectContaining({PATH: expect.any(String)}));

    // Check that tmux config file was written
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(path.join(UPTERM_DATA_DIR, 'tmux.conf'), expect.stringContaining('set-environment -g XDG_RUNTIME_DIR'));

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith('Waiting for upterm to be ready... (1/10)');
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
    // (non-MSYS2) steps via GITHUB_PATH. The interactive SSH/tmux login shells
    // re-source /etc/profile with the default MSYS2_PATH_TYPE=minimal, which
    // rebuilds PATH and drops the tool-cache dir. /usr/bin is always on the
    // minimal MSYS2 PATH (it's where bash and the pacman-installed tmux live),
    // so copying upterm.exe there keeps it reachable once the user connects.
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

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('tmux -f'));

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith('Waiting for upterm to be ready... (1/10)');
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

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('tmux -f'));

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith('Waiting for upterm to be ready... (1/10)');
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
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation via WMI on Windows
    expect(mockedLaunchOutsideJobObject).toHaveBeenCalledWith(expect.stringContaining('tmux -f'), expect.objectContaining({PATH: expect.any(String)}));

    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith('Waiting for upterm to be ready... (1/10)');
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

  it('should install using brew on macos', async () => {
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
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'brew install tmux');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('tmux -f'));
    expect(core.info).toHaveBeenCalledWith('Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenCalledWith('Waiting for upterm to be ready... (1/10)');
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
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');

    mockedExecShellCommand.mockRejectedValueOnce(new Error('Installation failed'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to install dependencies on linux: Error: Installation failed'));
  });

  it('should handle timeout with timeout flag detection', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('5');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    // Mock fs.existsSync to handle different paths correctly
    let monitoringLoopCalls = 0;
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr === TIMEOUT_FLAG_PATH) {
        monitoringLoopCalls++;
        // Return true on second call (first call is in monitoring loop)
        return monitoringLoopCalls >= 2;
      }
      if (pathStr === '/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths (SSH keys, .upterm dir, etc.)
    });

    await run();

    expect(core.info).toHaveBeenCalledWith('wait-timeout-minutes set - will wait for 5 minutes for someone to connect, otherwise shut down');
    expect(core.info).toHaveBeenCalledWith('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
    expect(core.info).toHaveBeenCalledWith('The session was automatically shut down to prevent unnecessary resource usage');
  }, 10000);

  it('should handle timeout with timeout flag detection on windows', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('5');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    // Mock fs.existsSync to handle different paths correctly
    // Note: Even on Windows, RUNNER_TEMP here ('/runner/_temp') has no drive letter, so
    // toMsys2Path() is a no-op and the timeout flag path matches TIMEOUT_FLAG_PATH verbatim.
    let monitoringLoopCalls = 0;
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr === TIMEOUT_FLAG_PATH) {
        monitoringLoopCalls++;
        // Return true on second call (first call is in monitoring loop)
        return monitoringLoopCalls >= 2;
      }
      if (pathStr === 'C:/msys64/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths (SSH keys, .upterm dir, etc.)
    });

    await run();

    // Verify the timeout flag path is now rooted at the private per-run directory
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining(TIMEOUT_FLAG_PATH));
    expect(core.info).toHaveBeenCalledWith('wait-timeout-minutes set - will wait for 5 minutes for someone to connect, otherwise shut down');
    expect(core.info).toHaveBeenCalledWith('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
    expect(core.info).toHaveBeenCalledWith('The session was automatically shut down to prevent unnecessary resource usage');
  }, 10000);

  it('should handle connection refused error during session monitoring with timeout detection', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('5');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    // Mock the session lookup.
    // First call is from waitForUptermReady() - should succeed
    // Second call is from monitorSession() - should fail with connection refused
    let sessionInfoCallCount = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm version')) return Promise.resolve('Upterm version v0.30.0\n');
      if (cmd.includes('session info')) {
        sessionInfoCallCount++;
        if (sessionInfoCallCount === 2) {
          // Second call from monitorSession - fail with connection refused
          return Promise.reject(
            new Error(
              "Command failed with exit code 1: upterm session info\nStderr: rpc error: code = Unavailable desc = connection error: desc = 'transport: Error while dialing: dial unix /home/runner/.upterm/sessions/gha-3f9a1c05/admin.sock: connect: connection refused'"
            )
          );
        }
        return Promise.resolve(readySession());
      }
      return Promise.resolve('success');
    });

    // Mock fs.existsSync to handle different paths correctly
    let timeoutCheckCount = 0;
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr === TIMEOUT_FLAG_PATH) {
        timeoutCheckCount++;
        // Return true after first check (after connection error) to simulate timeout
        return timeoutCheckCount > 1;
      }
      if (pathStr === '/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths
    });

    await run();

    // The failed lookup is UNKNOWN, so the loop keeps going; the next
    // iteration's timeout check is what ends it.
    expect(core.info).toHaveBeenCalledWith('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
    expect(core.info).toHaveBeenCalledWith('The session was automatically shut down to prevent unnecessary resource usage');
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

    // First lookup (readiness) succeeds; every one after it fails.
    let polls = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm version')) return Promise.resolve('Upterm version v0.30.0\n');
      if (cmd.includes('session info')) {
        polls++;
        if (polls === 1) return Promise.resolve(readySession());
        return Promise.reject(new Error('Command failed with exit code 1: connection refused'));
      }
      return Promise.resolve('success');
    });

    // The continue file appears only once several lookups have failed, so the
    // loop has to have survived them to reach it.
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr.includes('id_rsa') || pathStr.includes('id_ed25519')) return false;
      if (pathStr.includes('timeout-flag')) return false;
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

      const tmuxCmd = mockedExecShellCommand.mock.calls.map(c => c[0]).find(c => c.includes('upterm host'));
      expect(tmuxCmd).toMatch(/--name gha-[0-9a-f]{8}/);
      expect(core.saveState).toHaveBeenCalledWith('sessionName', expect.stringMatching(/^gha-[0-9a-f]{8}$/));
    });

    it('does not treat ready-without-ssh-command as ready', async () => {
      // status is "ready" but the admin query failed, so there is no usable connect
      // string yet. Declaring success here would print an empty command.
      //
      // The sequence MUST end in a terminal status. fsWithoutExitFiles() removes
      // both exit files and `detached` defaults to false, so run() proceeds into
      // monitorSession() - a sequence that stayed `ready` would never return.
      fsWithoutExitFiles();
      baselineShell(noDetail, noDetail, readySession(), endedResponse);

      await run();

      expect(core.setOutput).toHaveBeenCalledWith('ssh-command', 'ssh user@session123.upterm.dev');
      // Proves readiness actually rejected the two detail-less responses rather
      // than succeeding on the first.
      expect(sessionInfoCalls()).toBeGreaterThanOrEqual(3);
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

    it('retries readiness when the first lookup throws instead of failing the run', async () => {
      // A lookup that failed is not a session that failed. Abandoning the
      // remaining retries here would fail the job on a hiccup - and would skip
      // collectDiagnostics(), the report written for exactly this case.
      let polls = 0;
      mockedExecShellCommand.mockImplementation((cmd: string) => {
        if (cmd.includes('upterm version')) return Promise.resolve('Upterm version v0.30.0\n');
        if (cmd.includes('session info')) {
          polls++;
          if (polls === 1) return Promise.reject(new Error('Command failed with exit code 1: connection refused'));
          return Promise.resolve(readySession());
        }
        return Promise.resolve('foobar');
      });

      await run();

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith('ssh-command', 'ssh user@session123.upterm.dev');
      // The rejected lookup burned a retry rather than ending readiness.
      expect(polls).toBeGreaterThanOrEqual(2);
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
      // so readiness must exhaust its retries and fail with diagnostics rather
      // than hand detached mode a session nobody can reach.
      baselineShell(noDetail);

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Upterm did not become ready after maximum retries'));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Session name: gha-'));
      expect(core.saveState).not.toHaveBeenCalledWith('message', expect.anything());
      // One lookup per readiness retry.
      expect(sessionInfoCalls()).toBeGreaterThanOrEqual(10);
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

  it('should create timeout script when wait-timeout-minutes is specified', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('10');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('detached').mockReturnValue('false');
    when(core.getState).calledWith('isPost').mockReturnValue('');

    await run();

    // Check that timeout script was created with correct timeout value
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('sleep $(( 10 * 60 ))'));
    // Timeout flag path is now rooted at the private per-run directory
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining(`echo "UPTERM_TIMEOUT_REACHED" > '${TIMEOUT_FLAG_PATH}'`));
    expect(core.info).toHaveBeenCalledWith('wait-timeout-minutes set - will wait for 10 minutes for someone to connect, otherwise shut down');
  });

  describe('private per-run directories', () => {
    it('creates private per-run directories rooted at RUNNER_TEMP', async () => {
      await run();

      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join('/runner/_temp', 'upterm-action-'));
      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join('/runner/_temp', 'upterm-runtime-'));
      expect(mockFs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('upterm-runtime-'), 0o700);
    });

    it('exports XDG_STATE_HOME so session lookups find the record', async () => {
      await run();

      // session info resolves the record through XDG_STATE_HOME; if the action's
      // own shell disagrees with the host, a live session reports as missing.
      expect(process.env.XDG_STATE_HOME).toContain('upterm-action-');
      expect(process.env.XDG_RUNTIME_DIR).toContain('upterm-runtime-');
    });

    it('saves the directories for the post process', async () => {
      await run();

      expect(core.saveState).toHaveBeenCalledWith('uptermBaseDir', UPTERM_DATA_DIR);
      expect(core.saveState).toHaveBeenCalledWith('uptermRuntimeDir', UPTERM_RUNTIME_DIR);
    });
  });
});
