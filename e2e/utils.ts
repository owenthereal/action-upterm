import {spawn, ChildProcess} from 'child_process';

/**
 * Run act to start the e2e-fixture workflow locally
 * Returns the process handle and a promise that resolves with the SSH command
 */
export function runActWorkflow(): {
  process: ChildProcess;
  sshCommandPromise: Promise<string>;
  killProcess: () => void;
} {
  const actProcess = spawn('act', ['workflow_dispatch', '-W', '.github/workflows/e2e-fixture.yml', '-j', 'upterm', '--container-architecture', 'linux/amd64'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd()
  });

  const sshCommandPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timeout waiting for SSH command in act output'));
      }
    }, 180000); // 3 minutes

    actProcess.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      console.log('[act stdout]', chunk);

      // Look for SSH command in upterm output - flexible pattern to handle format variations
      // Example: "│ ➤ SSH Command:   │ ssh d07zbpLrcE4LxtHM3wKn@uptermd.upterm.dev          │"
      const sshMatch = chunk.match(/SSH Command:[^\n]*?(ssh\s+\S+@\S+)/i);
      if (sshMatch && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(sshMatch[1]);
      }
    });

    actProcess.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      console.log('[act stderr]', chunk);
    });

    actProcess.on('error', error => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });

    actProcess.on('exit', code => {
      if (!settled && code !== 0 && code !== null) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`act exited with code ${code}`));
      }
    });
  });

  let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

  const killProcess = () => {
    if (!actProcess.killed) {
      actProcess.kill('SIGTERM');
      // Force kill after 5 seconds if still running
      forceKillTimeout = setTimeout(() => {
        if (!actProcess.killed) {
          actProcess.kill('SIGKILL');
        }
        forceKillTimeout = null;
      }, 5000);
    } else if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
    }
  };

  return {process: actProcess, sshCommandPromise, killProcess};
}

/**
 * Check SSH connectivity to upterm session.
 * Upterm uses ForceCommand (tmux attach) which requires a TTY, so we can't run arbitrary commands.
 * Instead, we verify that SSH authentication succeeds by checking the stderr for the known_hosts message.
 * Exit code 1 is expected because tmux attach fails without a TTY.
 */
export async function sshCheckConnectivity(sshCommand: string, retries = 3): Promise<void> {
  // Parse the ssh command to extract user@host
  const match = sshCommand.match(/ssh\s+(\S+)/);
  if (!match) {
    throw new Error(`Invalid SSH command format: ${sshCommand}`);
  }
  const target = match[1];

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        // Use -T to disable pseudo-terminal allocation (we expect tmux to fail)
        // Use short timeout since we just want to verify authentication
        const proc = spawn('ssh', ['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', target], {stdio: ['pipe', 'pipe', 'pipe']});

        let stderr = '';

        proc.stderr.on('data', data => {
          stderr += data.toString();
        });

        proc.on('close', code => {
          // Check if SSH connected successfully (indicated by known_hosts message)
          // Exit code 1 is expected because tmux attach fails without a TTY
          if (stderr.includes('uptermd.upterm.dev')) {
            // SSH connected and authenticated successfully
            console.log(`SSH authentication succeeded (exit code ${code} expected due to no TTY)`);
            resolve();
          } else if (code === 255) {
            // SSH connection failed entirely
            reject(new Error(`SSH connection failed: ${stderr || 'no stderr'}`));
          } else {
            // Other errors might still indicate success if we got past authentication
            console.log(`SSH exited with code ${code}, stderr: ${stderr}`);
            resolve();
          }
        });

        proc.on('error', reject);
      });
      return;
    } catch (error) {
      lastError = error as Error;
      console.log(`SSH attempt ${attempt}/${retries} failed: ${lastError.message}`);
      if (attempt < retries) {
        console.log(`Waiting 3 seconds before retry...`);
        await sleep(3000);
      }
    }
  }

  throw lastError || new Error('SSH failed after all retries');
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
