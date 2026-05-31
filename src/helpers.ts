import * as core from '@actions/core';
import {spawn, execSync} from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

/**
 * Launches a shell command outside the current process's Windows Job Object
 * by using WMI's Win32_Process::Create.  The spawned process is parented by
 * WmiPrvSE.exe (a system service), so it is not affected when the runner
 * terminates a sibling step's process tree via a timeout-minutes limit.
 *
 * This is only needed on Windows; on other platforms, use execShellCommand.
 *
 * The command is written to a temporary script file to avoid quoting issues
 * when passing complex shell commands through PowerShell and WMI.  The
 * script also re-establishes the MSYS2 environment (PATH, MSYSTEM, etc.)
 * since WMI-spawned processes inherit from WmiPrvSE, not from the action.
 *
 * @param cmd - The bash command to execute
 * @param env - Environment variables to pass to the command (PATH, etc.)
 * @throws Error if WMI launch fails
 */
export function launchOutsideJobObject(cmd: string, env?: Record<string, string>): void {
  core.debug(`Launching outside Job Object: [${cmd}]`);

  if (process.platform !== 'win32') {
    throw new Error('launchOutsideJobObject is only supported on Windows');
  }

  // Write the command to a script file to avoid quoting hell
  const scriptDir = path.join(os.tmpdir(), 'upterm-data');
  fs.mkdirSync(scriptDir, {recursive: true});
  const scriptPath = path.join(scriptDir, 'wmi-launch.sh');

  // Build environment export lines.  On Windows, paths must be converted
  // from Windows format (backslashes, semicolons) to POSIX format
  // (forward slashes, colons) for bash.  PATH uses cygpath --path --unix
  // for the full semicolon-separated list; other paths use cygpath -u.
  const envLines: string[] = [];
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      // Escape single quotes in values
      const escaped = value.replace(/'/g, "'\\''");
      if (key === 'PATH') {
        // Convert Windows PATH (semicolons, backslashes) to POSIX
        envLines.push(`export PATH="$(cygpath --path --unix '${escaped}')"`);
      } else if (key === 'HOME' || key.endsWith('DIR') || key.endsWith('HOME')) {
        // Convert single Windows path to POSIX
        envLines.push(`export ${key}="$(cygpath -u '${escaped}')"`);
      } else {
        envLines.push(`export ${key}='${escaped}'`);
      }
    }
  }

  const scriptContent = `#!/bin/bash
# WMI-launched script: re-establish MSYS2 environment.
# WMI-spawned processes have a minimal environment, so we cannot rely
# on /etc/profile to set up PATH.  Instead, we hardcode the essential
# MSYS2 directories and then append the caller's PATH (which contains
# the upterm binary directory added by installDependencies).
export MSYSTEM='MINGW64'
export CHERE_INVOKING='1'
${envLines.join('\n')}
export PATH="/mingw64/bin:/usr/bin:/usr/local/bin:\${PATH}"
${cmd}
`;

  fs.writeFileSync(scriptPath, scriptContent);
  core.debug(`Wrote WMI launch script to ${scriptPath}`);

  // Convert to the path format bash.exe expects
  const bashExe = 'C:\\msys64\\usr\\bin\\bash.exe';
  const scriptPathForward = scriptPath.replace(/\\/g, '/');

  // Use PowerShell to call WMI.  The script file avoids all inline
  // quoting issues; we just need to pass the path.
  const psCommand = [
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create',
    `-Arguments @{CommandLine='"${bashExe}" -l "${scriptPathForward}"'}`,
    '; if ($r.ReturnValue -ne 0) { throw "WMI failed: $($r.ReturnValue)" }',
    '; Write-Host "WMI PID: $($r.ProcessId)"'
  ].join(' ');

  const output = execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand.replace(/"/g, '\\"')}"`, {encoding: 'utf8'});
  core.info(`Launched tmux/upterm outside Job Object (${output.trim()})`);
}
