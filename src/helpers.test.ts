import * as core from '@actions/core';

jest.mock('@actions/core');

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

import {spawn} from 'child_process';
import {execShellCommand} from './helpers';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('execShellCommand', () => {
  let mockProcess: {
    stdout: {on: jest.Mock};
    stderr: {on: jest.Mock};
    on: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcess = {
      stdout: {
        on: jest.fn()
      },
      stderr: {
        on: jest.fn()
      },
      on: jest.fn()
    };
    mockSpawn.mockReturnValue(mockProcess as never);
  });

  it('should execute command successfully on unix', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {value: 'linux', configurable: true});

    const command = 'echo "hello"';
    const expectedOutput = 'hello\n';

    // Setup mock process behavior
    mockProcess.stdout.on.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(Buffer.from(expectedOutput));
      }
    });

    mockProcess.on.mockImplementation((event, callback) => {
      if (event === 'exit') {
        callback(0); // Success exit code
      }
    });

    const resultPromise = execShellCommand(command);
    const result = await resultPromise;

    expect(result).toBe(expectedOutput);
    expect(mockSpawn).toHaveBeenCalledWith(command, [], {shell: 'bash', env: process.env});
    expect(core.debug).toHaveBeenCalledWith(`Executing shell command: [${command}]`);

    Object.defineProperty(process, 'platform', {value: originalPlatform, configurable: true});
  });

  it('should execute command successfully on windows', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true});

    const command = 'Write-Host "hello"';
    const expectedOutput = 'hello\n';

    // Setup mock process behavior
    mockProcess.stdout.on.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(Buffer.from(expectedOutput));
      }
    });

    mockProcess.on.mockImplementation((event, callback) => {
      if (event === 'exit') {
        callback(0); // Success exit code
      }
    });

    const resultPromise = execShellCommand(command);
    const result = await resultPromise;

    expect(result).toBe(expectedOutput);
    expect(mockSpawn).toHaveBeenCalledWith('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
      windowsHide: true
    });
    expect(core.debug).toHaveBeenCalledWith(`Executing shell command: [${command}]`);

    Object.defineProperty(process, 'platform', {value: originalPlatform, configurable: true});
  });

  it('should handle command failure', async () => {
    const command = 'false'; // Command that always fails
    const stderr = 'command failed';

    mockProcess.stderr.on.mockImplementation((event, callback) => {
      if (event === 'data') {
        callback(Buffer.from(stderr));
      }
    });

    mockProcess.on.mockImplementation((event, callback) => {
      if (event === 'exit') {
        callback(1); // Error exit code
      }
    });

    await expect(execShellCommand(command)).rejects.toThrow('Command failed with exit code 1: false\nStderr: command failed');
  });

  it('should handle empty command', async () => {
    await expect(execShellCommand('')).rejects.toThrow('Command cannot be empty');
    await expect(execShellCommand('   ')).rejects.toThrow('Command cannot be empty');
  });

  it('should handle process error', async () => {
    const command = 'some-command';
    const error = new Error('Process spawn failed');

    mockProcess.on.mockImplementation((event, callback) => {
      if (event === 'error') {
        callback(error);
      }
    });

    await expect(execShellCommand(command)).rejects.toThrow('Process error: Process spawn failed');
  });
});
