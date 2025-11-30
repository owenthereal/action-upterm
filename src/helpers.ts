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
    const proc =
      process.platform !== 'win32'
        ? spawn(cmd, [], {shell: 'bash'})
        : spawn('C:\\msys64\\usr\\bin\\bash.exe', ['-lc', cmd], {
            env: {
              ...process.env,
              MSYS2_PATH_TYPE: 'inherit' /* Inherit previous path */,
              CHERE_INVOKING: '1' /* do not `cd` to home */,
              MSYSTEM: 'MINGW64' /* include the MINGW programs in C:/msys64/mingw64/bin/ */
            }
          });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      const output = data.toString();
      console.log(output);
      stdout += output;
    });

    proc.stderr.on('data', data => {
      const output = data.toString();
      console.error(output);
      stderr += output;
    });

    proc.on('exit', code => {
      if (code !== 0) {
        const errorMsg = `Command failed with exit code ${code}: ${cmd}`;
        const fullError = stderr ? `${errorMsg}\nStderr: ${stderr}` : errorMsg;
        reject(new Error(fullError));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', error => {
      reject(new Error(`Process error: ${error.message}`));
    });
  });
}
