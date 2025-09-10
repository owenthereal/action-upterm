import {when} from 'jest-when';

import * as core from '@actions/core';
jest.mock('@actions/core');

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

import {run} from '.';
import fs from 'fs';
const mockFs = fs as jest.Mocked<typeof fs>;

describe('upterm GitHub integration', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset fs mocks
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readdirSync as jest.Mock).mockReturnValue(['id_rsa', 'id_ed25519', 'hello.sock']);
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch
    });
  });

  it('should skip for windows', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    await run();
    expect(core.info).toHaveBeenCalledWith('Windows is not supported by upterm, skipping...');
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

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
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

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_arm64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready... (1/10)');
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

    expect(core.setFailed).toHaveBeenCalledWith('Unsupported architecture for upterm: unknown. Only x64 and arm64 are supported.');
  });

  it('should support custom known_hosts content', async () => {
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
    when(core.getInput).calledWith('ssh-known-hosts').mockReturnValueOnce('known hosts content');

    const customConnectionString = 'foobar';
    mockedExecShellCommand.mockReturnValue(Promise.resolve(customConnectionString));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    expect(core.info).toHaveBeenNthCalledWith(1, 'Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:');
    expect(core.info).toHaveBeenNthCalledWith(2, `${customConnectionString}`);
    expect(core.info).toHaveBeenNthCalledWith(3, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(4, 'Waiting for upterm to be ready... (1/10)');
    expect(core.info).toHaveBeenNthCalledWith(5, "Exiting debugging session because '/continue' file was created");
  });

  it('should install using brew on macos', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'brew install owenthereal/upterm/upterm tmux');
    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready... (1/10)');
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

    expect(core.setFailed).toHaveBeenCalledWith('Failed to install dependencies on Linux: Error: Installation failed');
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
