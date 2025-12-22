import {runActWorkflow, sshCheckConnectivity, sleep} from './utils';

/**
 * E2E test that runs GitHub Actions locally using act and SSHs into it.
 *
 * Prerequisites:
 * - act installed (brew install act)
 * - Docker running (act uses Docker containers)
 *
 * Run locally: yarn test:e2e
 */
describe('E2E: SSH into local GitHub Actions runner via act', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    // Kill the act process if still running
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Wait a bit for cleanup
      await sleep(2000);
    }
  });

  it('should connect via SSH to upterm session in act container', async () => {
    console.log('Starting act workflow...');
    const {sshCommandPromise, killProcess} = runActWorkflow();
    killActProcess = killProcess;

    // Wait for the SSH command to appear in act output
    console.log('Waiting for SSH connection string in act output...');
    const sshCommand = await sshCommandPromise;
    console.log(`Found SSH command: ${sshCommand}`);

    // Verify the SSH command format is valid
    expect(sshCommand).toMatch(/^ssh\s+\S+@uptermd\.upterm\.dev$/);
    console.log('SSH command format is valid');

    // Wait for upterm to be fully ready
    console.log('Waiting 5 seconds for upterm to be fully ready...');
    await sleep(5000);

    // Verify SSH authentication works
    // Note: We can't run arbitrary commands because upterm uses ForceCommand (tmux attach)
    // which requires a TTY. We verify that SSH authentication succeeds instead.
    console.log('Verifying SSH connectivity and authentication...');
    await sshCheckConnectivity(sshCommand);
    console.log('SSH authentication verified successfully');

    console.log('E2E test completed successfully!');
  }, 300000); // 5 min test timeout
});
