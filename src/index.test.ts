import {when} from 'jest-when';

import * as core from '@actions/core';
jest.mock('@actions/core');
jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn(),
  extractTar: jest.fn()
}));

jest.mock('fs', () => ({
  mkdirSync: jest.fn(() => true),
  existsSync: jest.fn(() => true),
  appendFileSync: jest.fn(() => true),
  readdirSync: jest.fn(() => ['id_rsa', 'id_ed25519', 'hello.sock']),
  readFileSync: jest.fn(() => '{}'),
  promises: {
    access: jest.fn()
  }
}));

import {execShellCommand} from './helpers';
jest.mock('./helpers');
const mockedExecShellCommand = jest.mocked(execShellCommand);

import * as toolCache from '@actions/tool-cache';
const mockedToolCache = jest.mocked(toolCache);

import {getUptermArchitecture, getUptermDownloadUrl, run} from '.';
import fs from 'fs';
const mockFs = fs as jest.Mocked<typeof fs>;
const DOWNLOAD_PATH = '/tmp/upterm.tar.gz';
const EXTRACT_DIR = '/tmp/upterm-unique-a1b2c3d4';

describe('upterm GitHub integration', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch
    });
    mockedToolCache.downloadTool.mockResolvedValue(DOWNLOAD_PATH);
    mockedToolCache.extractTar.mockResolvedValue(EXTRACT_DIR);
    // Reset fs mocks
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readdirSync as jest.Mock).mockReturnValue(['id_rsa', 'id_ed25519', 'hello.sock']);
    when(core.getInput).calledWith('upterm-version').mockReturnValue('');
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
    });

    it('builds download url for specific release when version provided', () => {
      when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.20.0');
      expect(getUptermDownloadUrl('linux', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/download/v0.20.0/upterm_linux_amd64.tar.gz');
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, "Exiting debugging session because '/continue' file was created");
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
    when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.20.0');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/download/v0.20.0/upterm_linux_amd64.tar.gz');
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, "Exiting debugging session because '/continue' file was created");
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

    expect(core.setFailed).toHaveBeenCalledWith('Failed to install dependencies on linux: Error: Unsupported architecture for upterm: unknown. Only x64 and arm64 are supported.');
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

    expect(core.setFailed).toHaveBeenCalledWith('Failed to install dependencies on win32: Error: Unsupported architecture for upterm: unknown. Only x64 and arm64 are supported.');
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_darwin_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'brew install tmux');
    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, "Exiting debugging session because '/continue' file was created");
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

    expect(core.setFailed).toHaveBeenCalledWith('Failed to install dependencies on linux: Error: Installation failed');
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
    mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
      const pathStr = path.toString();
      if (pathStr === '/tmp/upterm-timeout-flag') {
        monitoringLoopCalls++;
        // Return true on second call (first call is in monitoring loop)
        return monitoringLoopCalls >= 2;
      }
      if (pathStr === '/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths (SSH keys, .upterm dir, etc.)
    });

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
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
    let monitoringLoopCalls = 0;
    mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
      const pathStr = path.toString();
      if (pathStr === 'C:/msys64/tmp/upterm-timeout-flag') {
        monitoringLoopCalls++;
        // Return true on second call (first call is in monitoring loop)
        return monitoringLoopCalls >= 2;
      }
      if (pathStr === 'C:/msys64/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths (SSH keys, .upterm dir, etc.)
    });

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('C:/msys64/tmp/upterm-timeout-flag'));
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

    // Mock session status command to fail with connection refused, then succeed
    let sessionStatusCallCount = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        sessionStatusCallCount++;
        if (sessionStatusCallCount === 1) {
          return Promise.reject(
            new Error(
              "Command failed with exit code 1: upterm session current\nStderr: rpc error: code = Unavailable desc = connection error: desc = 'transport: Error while dialing: dial unix /home/runner/.upterm/JGxpTKJ8jsJHPxiFWggH.sock: connect: connection refused'"
            )
          );
        }
      }
      return Promise.resolve('success');
    });

    // Mock fs.existsSync to handle different paths correctly
    let timeoutCheckCount = 0;
    mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
      const pathStr = path.toString();
      if (pathStr === '/tmp/upterm-timeout-flag') {
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

    expect(core.info).toHaveBeenCalledWith('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
    expect(core.info).toHaveBeenCalledWith('The session was automatically shut down to prevent unnecessary resource usage');
  });

  it('should handle connection refused error without timeout flag (unexpected termination)', async () => {
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

    // Mock session status command to fail with connection refused
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.reject(new Error('Command failed with exit code 1: connection refused'));
      }
      return Promise.resolve('success');
    });

    // Mock fs.existsSync to handle different paths correctly
    mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
      const pathStr = path.toString();
      if (pathStr === '/tmp/upterm-timeout-flag') {
        return false; // Never return true for timeout flag (no timeout)
      }
      if (pathStr === '/continue' || pathStr.includes('continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths
    });

    await run();

    expect(core.error).toHaveBeenCalledWith('Upterm session appears to have ended unexpectedly');
    expect(core.error).toHaveBeenCalledWith('Connection error: Error: Command failed with exit code 1: connection refused');
    expect(core.info).toHaveBeenCalledWith('This may indicate the upterm process crashed or was terminated externally');
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

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    // Check that timeout script was created with correct timeout value
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('sleep $(( 10 * 60 ))'));
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('echo "UPTERM_TIMEOUT_REACHED" > /tmp/upterm-timeout-flag'));
    expect(core.info).toHaveBeenCalledWith('wait-timeout-minutes set - will wait for 10 minutes for someone to connect, otherwise shut down');
  });
});
