import {when} from 'jest-when';
import path from 'path';

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
  writeFileSync: jest.fn(() => true),
  readdirSync: jest.fn(() => ['id_rsa', 'id_ed25519', 'hello.sock']),
  readFileSync: jest.fn(() => '{}'),
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

// Helper to get expected paths based on mocked os.tmpdir()
const UPTERM_DATA_DIR = '/mock-tmp/upterm-data';
const TIMEOUT_FLAG_PATH = path.join(UPTERM_DATA_DIR, 'timeout-flag');

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
    // Reset fs mocks - by default return false for SSH key files to trigger generation
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      // SSH key files don't exist initially, so they get generated
      if (pathStr.includes('id_rsa') || pathStr.includes('id_ed25519')) {
        return false;
      }
      // Everything else exists (directories, socket, etc.)
      return true;
    });
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
      expect(getUptermDownloadUrl('win32', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_amd64.tar.gz');
    });

    it('builds download url for specific release when version provided', () => {
      when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.20.0');
      expect(getUptermDownloadUrl('linux', 'x64')).toBe('https://github.com/owenthereal/upterm/releases/download/v0.20.0/upterm_linux_amd64.tar.gz');
      expect(getUptermDownloadUrl('win32', 'arm64')).toBe('https://github.com/owenthereal/upterm/releases/download/v0.20.0/upterm_windows_arm64.tar.gz');
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      // outputSshCommand() calls upterm session current to get SSH command
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    // Check dependency installation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('tmux -f'));
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('/mock-tmp/upterm-data/tmux.conf'));

    // Check that tmux config file was written
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(path.join(UPTERM_DATA_DIR, 'tmux.conf'), expect.stringContaining('set-environment -g XDG_RUNTIME_DIR'));

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('tmux -f'));

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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
    when(core.getInput).calledWith('upterm-version').mockReturnValue('v0.20.0');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/download/v0.20.0/upterm_windows_amd64.tar.gz');
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('tmux -f'));

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_arm64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('tmux -f'));

    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    expect(mockedToolCache.downloadTool).toHaveBeenCalledWith('https://github.com/owenthereal/upterm/releases/latest/download/upterm_darwin_amd64.tar.gz');
    expect(mockedToolCache.extractTar).toHaveBeenCalledWith(DOWNLOAD_PATH);
    expect(core.addPath).toHaveBeenCalledWith(EXTRACT_DIR);
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'brew install tmux');

    // Check SSH key generation
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, expect.stringContaining('ssh-keygen -q -t rsa'));

    // Check upterm session creation with tmux config
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(3, expect.stringContaining('tmux -f'));
    expect(core.info).toHaveBeenNthCalledWith(1, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(3, expect.stringContaining('SSH command available as output'));
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
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
    // Note: Even on Windows, the timeout flag path uses os.tmpdir() which is mocked to /mock-tmp
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    // Verify the timeout flag path is now based on os.tmpdir()
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('/mock-tmp/upterm-data/timeout-flag'));
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

    // Mock session status command
    // First call is from outputSshCommand() - should succeed
    // Second call is from monitorSession() - should fail with connection refused
    let sessionStatusCallCount = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        sessionStatusCallCount++;
        if (sessionStatusCallCount === 1) {
          // First call from outputSshCommand - return session info
          return Promise.resolve('ssh test@upterm.dev\nSession: test123');
        }
        if (sessionStatusCallCount === 2) {
          // Second call from monitorSession - fail with connection refused
          return Promise.reject(
            new Error(
              "Command failed with exit code 1: upterm session current\nStderr: rpc error: code = Unavailable desc = connection error: desc = 'transport: Error while dialing: dial unix /home/runner/.upterm/JGxpTKJ8jsJHPxiFWggH.sock: connect: connection refused'"
            )
          );
        }
        // Subsequent calls succeed
        return Promise.resolve('ssh test@upterm.dev\nSession: test123');
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

    // Mock session status command
    // First call is from outputSshCommand() - should succeed
    // Second call is from monitorSession() - should fail with connection refused
    let sessionStatusCallCount = 0;
    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        sessionStatusCallCount++;
        if (sessionStatusCallCount === 1) {
          // First call from outputSshCommand - return session info
          return Promise.resolve('ssh test@upterm.dev\nSession: test123');
        }
        // Second call from monitorSession - fail with connection refused
        return Promise.reject(new Error('Command failed with exit code 1: connection refused'));
      }
      return Promise.resolve('success');
    });

    // Mock fs.existsSync to handle different paths correctly
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
      const pathStr = filePath.toString();
      // Normalize paths for comparison (convert backslashes to forward slashes)
      const normalizedPath = pathStr.replace(/\\/g, '/');
      const normalizedTimeoutPath = TIMEOUT_FLAG_PATH.replace(/\\/g, '/');
      if (normalizedPath === normalizedTimeoutPath) {
        return false; // Never return true for timeout flag (no timeout)
      }
      // Be specific about continue file paths to avoid matching unintended paths on Windows
      if (pathStr === '/continue' || pathStr.endsWith('/continue') || pathStr.endsWith('\\continue')) {
        return false; // Don't exit via continue file
      }
      return true; // Default for other paths (SSH keys, socket dir, etc.)
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

    mockedExecShellCommand.mockImplementation((cmd: string) => {
      if (cmd.includes('upterm session current')) {
        return Promise.resolve('ssh test@upterm.dev');
      }
      return Promise.resolve('foobar');
    });
    await run();

    // Check that timeout script was created with correct timeout value
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('sleep $(( 10 * 60 ))'));
    // Timeout flag path now uses os.tmpdir() which is mocked to /mock-tmp
    expect(mockedExecShellCommand).toHaveBeenCalledWith(expect.stringContaining('echo "UPTERM_TIMEOUT_REACHED" > \'/mock-tmp/upterm-data/timeout-flag\''));
    expect(core.info).toHaveBeenCalledWith('wait-timeout-minutes set - will wait for 10 minutes for someone to connect, otherwise shut down');
  });
});
