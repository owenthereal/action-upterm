import * as core from '@actions/core';
import {spawn} from 'child_process';

export function execShellCommand(cmd: string): Promise<string> {
  core.debug(`Executing shell command: [${cmd}]`);

  return new Promise<string>((resolve, reject) => {
    const process = spawn(cmd, [], {shell: '/bin/bash'});
    let stdout = '';
    process.stdout.on('data', data => {
      console.log(data.toString());
      stdout += data.toString();
    });

    process.stderr.on('data', data => {
      console.error(data.toString());
    });

    process.on('exit', code => {
      if (code !== 0) {
        reject(new Error(code ? code.toString() : undefined));
      }
      resolve(stdout);
    });
  });
}
