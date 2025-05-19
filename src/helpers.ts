import * as core from '@actions/core';
import { spawn } from 'child_process';

export function execShellCommand(cmd: string): Promise<string> {
  core.debug(`Executing shell command: [${cmd}]`);

  return new Promise<string>((resolve, reject) => {
    const process = spawn(cmd, [], { shell: '/bin/bash' });
    let stdout = '';
    let stderr = '';

    process.stdout.on('data', data => {
      const text = data.toString();
      console.log(text);
      stdout += text;
    });

    process.stderr.on('data', data => {
      const text = data.toString();
      console.error(text);
      stderr += text;
    });

    process.on('exit', code => {
      if (code !== 0) {
        const message = `Command failed with exit code ${code}: ${cmd}\n\nstderr:\n${stderr}`;
        reject(new Error(message));
      } else {
        resolve(stdout);
      }
    });
  });
}
