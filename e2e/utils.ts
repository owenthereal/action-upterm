import {spawn, execSync, ChildProcess} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Ceiling for the SSH command line to appear in act's output: act's image
 * pull plus upterm's own release download, both of which can be slow under
 * load. Exported so e2e.test.ts can budget every watcher that causally
 * depends on the SSH line against the same number instead of a copy that can
 * drift out of sync with it.
 */
export const SSH_COMMAND_TIMEOUT_MS = 240000; // 4 minutes

/**
 * Run act to start an e2e-fixture workflow locally
 * Returns the process handle and a promise that resolves with the SSH command
 */
export function runActWorkflow(options?: {workflowFile?: string; job?: string}): {
  process: ChildProcess;
  sshCommandPromise: Promise<string>;
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  killProcess: () => void;
} {
  const workflowFile = options?.workflowFile ?? '.github/workflows/e2e-fixture.yml';
  const job = options?.job ?? 'upterm';
  const actProcess = spawn(
    'act',
    // '-' disables bind-mounting the host's docker.sock into the job container.
    // None of the fixtures run docker; the bind-mount itself fails under
    // colima's virtiofs-shared socket (mkdir over a socket node, ENOTSUP),
    // which would otherwise fail every job at container creation.
    ['workflow_dispatch', '-W', workflowFile, '-j', job, '--container-architecture', 'linux/amd64', '--container-daemon-socket', '-'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    }
  );

  const sshCommandPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timeout waiting for SSH command in act output'));
      }
    }, SSH_COMMAND_TIMEOUT_MS);

    actProcess.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      console.log('[act stdout]', chunk);

      // Look for SSH command in upterm output - matches upterm.dev domain specifically
      // Example: "SSH command available as output: ssh IYPwJpVLifTKRNowOUuV@uptermd.upterm.dev"
      const sshMatch = chunk.match(/SSH command[^:]*:[^\n]*?(ssh\s+\S+@uptermd\.upterm\.dev)/i);
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
      forceKillTimeout.unref();
    } else if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
    }
  };

  const waitForOutput = (pattern: RegExp, timeoutMs = 180000): Promise<RegExpMatchArray> => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timeout waiting for pattern ${pattern} in act output`));
        }
      }, timeoutMs);

      actProcess.stdout?.on('data', (data: Buffer) => {
        const m = data.toString().match(pattern);
        if (m && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(m);
        }
      });
    });
  };

  return {process: actProcess, sshCommandPromise, waitForOutput, killProcess};
}

let guestIdentityPath: string | null = null;

/**
 * A throwaway ed25519 keypair for the guest's ssh connections, generated once
 * per test process and reused by every joinAsGuest call.
 *
 * The fixtures set no access limits (open sessions), so any key
 * authenticates - but the host running the tests may have no default
 * identity at all (a fresh GitHub-hosted runner has no ~/.ssh/id_*, unlike a
 * developer's machine), in which case ssh's own default-identity search
 * finds nothing to offer and the relay replies "Permission denied
 * (publickey)". Generating our own removes that dependency on whatever (if
 * anything) happens to already be under ~/.ssh on the host.
 */
function ensureGuestIdentity(): string {
  if (guestIdentityPath) return guestIdentityPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-guest-identity-'));
  const keyPath = path.join(dir, 'id_ed25519');
  execSync(`ssh-keygen -q -t ed25519 -N "" -f ${JSON.stringify(keyPath)}`);
  guestIdentityPath = keyPath;
  return keyPath;
}

/**
 * Join the session as a guest for holdMs, then leave without ending it.
 *
 * -tt allocates a pty with no local terminal, which is an accepted session
 * channel - a qualifying join for upterm's firstGuestJoinedAt. Leaving by
 * killing ssh (not by typing exit) leaves the shared shell running.
 * Resolves with everything the guest saw; rejects loudly if the guest never
 * actually authenticated, rather than resolving with a transcript nobody
 * checks (both callers that only wait for firstGuestJoinedAt to appear, not
 * for a specific string in the guest's own output, would otherwise see a
 * failed join only as a much harder to diagnose pattern timeout minutes
 * later - the post step polling for a join that can never come).
 */
export async function joinAsGuest(sshCommand: string, holdMs: number, input = ''): Promise<string> {
  const target = (sshCommand.match(/ssh\s+(\S+)/) ?? [])[1];
  if (!target) throw new Error(`Invalid SSH command format: ${sshCommand}`);
  const identity = ensureGuestIdentity();
  return new Promise((resolve, reject) => {
    // IdentitiesOnly and IdentityAgent=none restrict ssh to exactly this key,
    // so behavior doesn't vary with whatever else - another default
    // identity, a developer's own agent - the host running the test happens
    // to have.
    const proc = spawn('ssh', ['-tt', '-i', identity, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', target], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let seen = '';
    let holdElapsed = false;
    proc.stdout.on('data', d => (seen += d.toString()));
    proc.stderr.on('data', d => (seen += d.toString()));
    if (input) setTimeout(() => proc.stdin.write(input), 1000);
    const timer = setTimeout(() => {
      holdElapsed = true;
      proc.kill('SIGTERM');
    }, holdMs);
    proc.on('close', code => {
      clearTimeout(timer);
      // A successful join is only ever closed by us, once holdMs elapses.
      // Anything that closes on its own first - especially with "Permission
      // denied" in its output, or ssh's own auth-failure exit code 255 -
      // never joined at all.
      if (!holdElapsed && (/Permission denied/i.test(seen) || code === 255)) {
        reject(new Error(`Guest failed to authenticate to the relay: ${seen}`));
        return;
      }
      resolve(seen);
    });
    proc.on('error', reject);
  });
}

export function dockerExec(container: string, cmd: string): string {
  return execSync(`docker exec ${container} sh -c ${JSON.stringify(cmd)}`, {encoding: 'utf8'});
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find a running Docker container whose name matches the given substring.
 */
export function findContainer(nameSubstring: string): string {
  const out = execSync(`docker ps --filter "name=${nameSubstring}" --format "{{.Names}}"`, {encoding: 'utf8'}).trim();
  const names = out.split('\n').filter(Boolean);
  if (names.length !== 1) {
    throw new Error(`Expected exactly one container matching "${nameSubstring}", found ${names.length}: ${names.join(', ')}`);
  }
  return names[0];
}
