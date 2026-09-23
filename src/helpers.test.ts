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

  it('should execute command successfully', async () => {
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

    // Verify spawn was called with platform-specific arguments
    const isWindows = process.platform === 'win32';
    const expectedFirstArg = isWindows ? 'C:\\msys64\\usr\\bin\\bash.exe' : command;
    const expectedSecondArg = isWindows ? ['-lc', command] : [];

    // Verify the spawn call
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe(expectedFirstArg);
    expect(spawnCall[1]).toEqual(expectedSecondArg);
    expect(spawnCall[2]).toBeDefined();
    expect(typeof spawnCall[2]).toBe('object');

    expect(core.debug).toHaveBeenCalledWith(`Executing shell command: [${command}]`);
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

  describe('quiet mode', () => {
    let log: jest.SpyInstance;
    let error: jest.SpyInstance;

    beforeEach(() => {
      log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      log.mockRestore();
      error.mockRestore();
    });

    it('keeps stdout out of the job log but still returns it', async () => {
      // Session lookups run every few seconds for hours; printing each one's
      // JSON would bury the log.
      const json = '{"name":"gha-3f9a1c05","status":"ready"}\n';
      mockProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') callback(Buffer.from(json));
      });
      mockProcess.on.mockImplementation((event, callback) => {
        if (event === 'exit') callback(0);
      });

      await expect(execShellCommand('upterm session info x -o json', {quiet: true})).resolves.toBe(json);

      expect(log).not.toHaveBeenCalled();
      expect(core.debug).toHaveBeenCalledWith(json);
    });

    it('keeps stderr out of the job log but still includes it in the rejection', async () => {
      mockProcess.stderr.on.mockImplementation((event, callback) => {
        if (event === 'data') callback(Buffer.from('no session named "x"'));
      });
      mockProcess.on.mockImplementation((event, callback) => {
        if (event === 'exit') callback(1);
      });

      await expect(execShellCommand('upterm session info x -o json', {quiet: true})).rejects.toThrow('Command failed with exit code 1: upterm session info x -o json\nStderr: no session named "x"');

      expect(error).not.toHaveBeenCalled();
      expect(core.debug).toHaveBeenCalledWith('no session named "x"');
    });

    it('still prints output when not quiet', async () => {
      mockProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') callback(Buffer.from('hello\n'));
      });
      mockProcess.on.mockImplementation((event, callback) => {
        if (event === 'exit') callback(0);
      });

      await execShellCommand('echo hello');

      expect(log).toHaveBeenCalledWith('hello\n');
    });
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
