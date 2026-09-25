import * as core from '@actions/core';
import {spawn} from 'child_process';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executes a shell command and returns the output as a Promise.
 *
 * @param cmd - The shell command to execute
 * @param options.quiet - Send the command's output to core.debug instead of the
 *   job log. For commands polled on a timer, whose output would otherwise fill
 *   the log. Only where the output goes changes: stdout is still returned, and
 *   stderr is still included in the rejection.
 * @returns Promise that resolves with the command's stdout output
 * @throws Error if the command fails or if cmd is empty
 */
export function execShellCommand(cmd: string, options: {quiet?: boolean} = {}): Promise<string> {
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
    const logStdout = options.quiet ? core.debug : console.log;
    const logStderr = options.quiet ? core.debug : console.error;

    proc.stdout.on('data', data => {
      const output = data.toString();
      logStdout(output);
      stdout += output;
    });

    proc.stderr.on('data', data => {
      const output = data.toString();
      logStderr(output);
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

/**
 * Escape a string for safe use in single-quoted shell arguments.
 * Handles paths that may contain single quotes by using the '\'' escape pattern.
 *
 * Use this for:
 * - User-provided strings (server URLs, GitHub usernames)
 * - File paths in shell commands
 * - Any value passed through nested command layers
 *
 * @example
 * shellEscape("hello world")           // => "'hello world'"
 * shellEscape("user's file")           // => "'user'\''s file'"
 * shellEscape("ssh://server:22")       // => "'ssh://server:22'"
 *
 * @param value - The string to escape
 * @returns Single-quoted string safe for shell use
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
