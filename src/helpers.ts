import * as core from '@actions/core';
import {spawn} from 'child_process';

/**
 * Executes a shell command and returns the output as a Promise.
 *
 * @param cmd - The shell command to execute
 * @returns Promise that resolves with the command's stdout output
 * @throws Error if the command fails or if cmd is empty
 */
export function execShellCommand(cmd: string): Promise<string> {
  core.debug(`Executing shell command: [${cmd}]`);

  if (!cmd.trim()) {
    return Promise.reject(new Error('Command cannot be empty'));
  }

  return new Promise<string>((resolve, reject) => {
    const process = spawn(cmd, [], {shell: '/bin/bash'});
    let stdout = '';
    let stderr = '';

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
      if (code !== 0) {
        const errorMsg = `Command failed with exit code ${code}: ${cmd}`;
        const fullError = stderr ? `${errorMsg}\nStderr: ${stderr}` : errorMsg;
        reject(new Error(fullError));
        return;
      }
      resolve(stdout);
    });

    process.on('error', error => {
      reject(new Error(`Process error: ${error.message}`));
    });
  });
}
