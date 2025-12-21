import {createOctokit, getCurrentBranch, triggerFixtureWorkflow, getLatestFixtureRun, waitForNewRun, waitForSshCommand, sshExec, waitForWorkflowComplete, getWorkflowRunStatus, cancelWorkflowRun} from './utils';

/**
 * E2E test that triggers a real GitHub Actions workflow and SSHs into it.
 *
 * Prerequisites:
 * - GITHUB_TOKEN env var with repo and actions permissions
 * - Current branch must be pushed to the remote (workflow_dispatch requires it)
 * - SSH key registered with your GitHub account (for limit-access-to-actor)
 *
 * Run locally: GITHUB_TOKEN=xxx yarn test:e2e
 */
describe('E2E: SSH into GitHub Actions runner', () => {
  const octokit = createOctokit();
  let runId: number;
  let branch: string;

  beforeAll(async () => {
    // Get current branch (must be pushed to remote for workflow_dispatch)
    branch = getCurrentBranch();
    console.log(`Running e2e test on branch: ${branch}`);

    // Get current latest run ID (to detect new run)
    const beforeRunId = await getLatestFixtureRun(octokit, branch);
    console.log(`Latest run ID before trigger: ${beforeRunId}`);

    // Trigger the fixture workflow
    console.log('Triggering e2e-fixture workflow...');
    await triggerFixtureWorkflow(octokit, branch);
    console.log('Workflow triggered, waiting for run to appear...');

    // Wait for the new run to appear
    runId = await waitForNewRun(octokit, branch, beforeRunId);
    console.log(`New workflow run ID: ${runId}`);
  }, 120000); // 2 min timeout for setup

  afterAll(async () => {
    // Cancel the workflow if still running
    if (runId) {
      console.log('Cleaning up: cancelling workflow run if still active...');
      await cancelWorkflowRun(octokit, runId);
    }
  });

  it('should connect via SSH and execute commands', async () => {
    // 1. Wait for the SSH connection string to appear in logs
    console.log('Waiting for SSH connection string in workflow logs...');
    const sshCommand = await waitForSshCommand(octokit, runId, 180000); // 3 min timeout
    console.log(`Found SSH command: ${sshCommand}`);

    // 2. Connect via SSH and run a test command
    console.log('Connecting via SSH and running test command...');
    const echoResult = await sshExec(sshCommand, 'echo E2E_TEST_SUCCESS');
    expect(echoResult.trim()).toContain('E2E_TEST_SUCCESS');
    console.log('Successfully executed command via SSH');

    // 3. Verify we can access environment info
    console.log('Verifying environment access...');
    const envResult = await sshExec(sshCommand, 'echo $GITHUB_ACTIONS');
    expect(envResult.trim()).toBe('true');
    console.log('Confirmed running in GitHub Actions environment');

    // 4. Create continue file to signal the action to exit gracefully
    console.log('Creating continue file to exit session...');
    await sshExec(sshCommand, 'touch /continue || touch $GITHUB_WORKSPACE/continue');
    console.log('Continue file created');

    // 5. Wait for the workflow to complete
    console.log('Waiting for workflow to complete...');
    await waitForWorkflowComplete(octokit, runId, 60000); // 1 min to complete after continue

    // 6. Verify workflow completed successfully
    const {status, conclusion} = await getWorkflowRunStatus(octokit, runId);
    console.log(`Workflow final status: ${status}, conclusion: ${conclusion}`);
    expect(status).toBe('completed');
    expect(conclusion).toBe('success');
  }, 300000); // 5 min test timeout
});
