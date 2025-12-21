import {Octokit} from '@octokit/rest';
import {spawn, execSync} from 'child_process';

// GitHub repo info - can be overridden via env vars
const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'owenthereal';
const REPO_NAME = process.env.GITHUB_REPOSITORY_NAME || 'action-upterm';

/**
 * Get GitHub token from environment
 */
function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN environment variable is required');
  }
  return token;
}

/**
 * Create Octokit client
 */
export function createOctokit(): Octokit {
  return new Octokit({auth: getGitHubToken()});
}

/**
 * Get current git branch name
 */
export function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {encoding: 'utf8'}).trim();
  } catch {
    throw new Error('Failed to get current git branch');
  }
}

/**
 * Trigger the e2e-fixture workflow
 */
export async function triggerFixtureWorkflow(octokit: Octokit, ref: string): Promise<void> {
  await octokit.actions.createWorkflowDispatch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    workflow_id: 'e2e-fixture.yml',
    ref
  });
}

/**
 * Get the most recent workflow run for e2e-fixture
 * Note: We use listWorkflowRunsForRepo and filter by name because
 * listWorkflowRuns with workflow_id doesn't work for workflows that
 * only exist on feature branches (not yet merged to default branch).
 */
export async function getLatestFixtureRun(octokit: Octokit, branch: string): Promise<number | null> {
  const {data} = await octokit.actions.listWorkflowRunsForRepo({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch,
    per_page: 20
  });

  // Filter by workflow name since workflow_id lookup doesn't work for feature-branch-only workflows
  const fixtureRun = data.workflow_runs.find(run => run.name === 'E2E Fixture');
  return fixtureRun?.id ?? null;
}

/**
 * Get workflow run status
 */
export async function getWorkflowRunStatus(octokit: Octokit, runId: number): Promise<{status: string; conclusion: string | null}> {
  const {data} = await octokit.actions.getWorkflowRun({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    run_id: runId
  });

  return {status: data.status || 'unknown', conclusion: data.conclusion};
}

/**
 * Get workflow run logs
 */
export async function getWorkflowLogs(octokit: Octokit, runId: number): Promise<string> {
  try {
    // Get jobs for the run
    const {data: jobs} = await octokit.actions.listJobsForWorkflowRun({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      run_id: runId
    });

    // Get logs for each job
    let allLogs = '';
    for (const job of jobs.jobs) {
      try {
        const {data: logs} = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          job_id: job.id
        });
        allLogs += logs as string;
      } catch {
        // Job logs might not be available yet
      }
    }
    return allLogs;
  } catch {
    return '';
  }
}

/**
 * Parse SSH connection string from upterm output in logs
 * Example: ssh abcd1234:token@uptermd.upterm.dev
 */
export function parseSshCommand(logs: string): string | null {
  // Match SSH command pattern from upterm session output
  const sshMatch = logs.match(/ssh\s+(\S+@\S*upterm\S*)/i);
  if (sshMatch) {
    return `ssh ${sshMatch[1]}`;
  }
  return null;
}

/**
 * Poll until a condition is met or timeout
 */
export async function pollUntil<T>(fn: () => Promise<T | null>, options: {timeoutMs: number; intervalMs: number; description?: string}): Promise<T> {
  const {timeoutMs, intervalMs, description = 'condition'} = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    console.log(`Waiting for ${description}... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    await sleep(intervalMs);
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute SSH command on remote host
 */
export function sshExec(sshCommand: string, remoteCommand: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Parse the ssh command to extract user@host
    const match = sshCommand.match(/ssh\s+(\S+)/);
    if (!match) {
      reject(new Error(`Invalid SSH command format: ${sshCommand}`));
      return;
    }
    const target = match[1];

    const proc = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', target, remoteCommand], {stdio: ['pipe', 'pipe', 'pipe']});

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`SSH command failed with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Wait for a new workflow run to appear after triggering
 */
export async function waitForNewRun(octokit: Octokit, branch: string, afterRunId: number | null, timeoutMs = 60000): Promise<number> {
  return pollUntil(
    async () => {
      const runId = await getLatestFixtureRun(octokit, branch);
      if (runId && runId !== afterRunId) {
        return runId;
      }
      return null;
    },
    {
      timeoutMs,
      intervalMs: 3000,
      description: 'new workflow run'
    }
  );
}

/**
 * Wait for SSH connection string to appear in workflow logs
 */
export async function waitForSshCommand(octokit: Octokit, runId: number, timeoutMs = 180000): Promise<string> {
  return pollUntil(
    async () => {
      const logs = await getWorkflowLogs(octokit, runId);
      return parseSshCommand(logs);
    },
    {
      timeoutMs,
      intervalMs: 5000,
      description: 'SSH connection string in logs'
    }
  );
}

/**
 * Wait for workflow to complete
 */
export async function waitForWorkflowComplete(octokit: Octokit, runId: number, timeoutMs = 300000): Promise<string> {
  return pollUntil(
    async () => {
      const {status} = await getWorkflowRunStatus(octokit, runId);
      if (status === 'completed') {
        return status;
      }
      return null;
    },
    {
      timeoutMs,
      intervalMs: 10000,
      description: 'workflow completion'
    }
  );
}

/**
 * Cancel a workflow run
 */
export async function cancelWorkflowRun(octokit: Octokit, runId: number): Promise<void> {
  try {
    await octokit.actions.cancelWorkflowRun({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      run_id: runId
    });
  } catch {
    // Ignore errors (run might already be completed)
  }
}
