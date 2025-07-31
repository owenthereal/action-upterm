import * as core from '@actions/core';
import {spawn} from 'child_process';

/**
 * Executes a shell command and returns the output as a Promise.
 *
 * @param cmd - The shell command to execute
 * @param options - Configuration options for the command execution
 * @param options.timeout - Optional timeout in milliseconds. If specified, the command will be terminated after this duration.
 * @returns Promise that resolves with the command's stdout output
 * @throws Error if the command fails, times out, or if cmd is empty
 */
export function execShellCommand(cmd: string, options: {timeout?: number} = {}): Promise<string> {
  core.debug(`Executing shell command: [${cmd}]`);

  if (!cmd.trim()) {
    return Promise.reject(new Error('Command cannot be empty'));
  }

  return new Promise<string>((resolve, reject) => {
    const process = spawn(cmd, [], {shell: '/bin/bash'});
    let stdout = '';
    let stderr = '';

    const timeoutId = options.timeout
      ? setTimeout(() => {
          process.kill('SIGTERM');
          // Fallback to SIGKILL after 5 seconds if SIGTERM doesn't work
          setTimeout(() => {
            if (!process.killed) {
              process.kill('SIGKILL');
            }
          }, 5000);
          reject(new Error(`Command timed out after ${options.timeout}ms: ${cmd}`));
        }, options.timeout)
      : null;

    process.stdout.on('data', data => {
      const output = data.toString();
      console.log(output);
      stdout += output;
    });

    process.stderr.on('data', data => {
      const output = data.toString();
      console.error(output);
      stderr += output;
    });

    process.on('exit', code => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (code !== 0) {
        const errorMsg = `Command failed with exit code ${code}: ${cmd}`;
        const fullError = stderr ? `${errorMsg}\nStderr: ${stderr}` : errorMsg;
        reject(new Error(fullError));
        return;
      }
      resolve(stdout);
    });

    process.on('error', error => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(new Error(`Process error: ${error.message}`));
    });
  });
}
