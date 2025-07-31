import * as core from '@actions/core';
import {spawn} from 'child_process';

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
