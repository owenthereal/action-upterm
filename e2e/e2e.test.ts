import {runActWorkflow, joinAsGuest, sleep, findContainer, dockerExec} from './utils';

/**
 * E2E tests that run GitHub Actions workflows locally via act, against the real
 * upterm relay (uptermd.upterm.dev), with a real ssh guest.
 *
 * Prerequisites:
 * - act installed (brew install act)
 * - Docker running (act uses Docker containers)
 *
 * Run locally: yarn test:e2e
 * Run a single scenario while iterating: yarn test:e2e -t '<name>'
 */

const SSH_COMMAND_PATTERN = /^ssh\s+\S+@uptermd\.upterm\.dev$/;

/**
 * Wait up to windowMs for pattern to appear; fail the test if it does. A
 * waitForOutput timeout (the pattern never appeared) is the success case here.
 */
async function assertNeverPrints(waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>, pattern: RegExp, windowMs: number): Promise<void> {
  await waitForOutput(pattern, windowMs).then(
    match => {
      throw new Error(`Expected to never see ${pattern}, but saw: ${match[0]}`);
    },
    (error: Error) => {
      if (!/Timeout waiting for pattern/.test(error.message)) throw error;
    }
  );
}

describe('E2E: attached mode against the real relay', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Longer than killProcess's 5000ms SIGKILL fallback: act must be fully
      // dead (and its stdout/stderr listeners quiet) before the test file
      // concludes, or leftover act output after teardown makes Jest report
      // "Cannot log after tests are done" and fail the run despite every
      // assertion having passed.
      await sleep(6000);
    }
  });

  it('a guest joins, leaves, and touching /continue ends the session', async () => {
    const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow();
    killActProcess = killProcess;

    // Register before it can fire.
    const sessionExited = waitForOutput(/Exiting debugging session because '\/continue' file was created/, 280000);

    const sshCommand = await sshCommandPromise;
    console.log(`Found SSH command: ${sshCommand}`);
    expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

    // Join as a guest, run a command, and leave (kill ssh, not "exit") without
    // ending the shared shell.
    const guestOutput = await joinAsGuest(sshCommand, 4000, 'echo E2E_GUEST_OK\n');
    expect(guestOutput).toContain('E2E_GUEST_OK');
    console.log('Guest saw E2E_GUEST_OK; guest left without ending the session');

    const container = findContainer('act-E2E-Fixture-upterm');
    dockerExec(container, 'touch /continue');
    console.log('Touched /continue');

    await sessionExited;
    console.log('Session exited because /continue was created');
  }, 360000);
});

describe('E2E: long build, then the post step gets the full countdown', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Longer than killProcess's 5000ms SIGKILL fallback: act must be fully
      // dead (and its stdout/stderr listeners quiet) before the test file
      // concludes, or leftover act output after teardown makes Jest report
      // "Cannot log after tests are done" and fail the run despite every
      // assertion having passed.
      await sleep(6000);
    }
  });

  it('the 90s build finishes before the post step starts counting down its full 60s', async () => {
    const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
      workflowFile: '.github/workflows/e2e-fixture-long-build.yml'
    });
    killActProcess = killProcess;

    // Register before any of these can fire.
    // act's verbose logging dumps the generated step script (containing the
    // literal text `echo "BUILD_FINISHED"`) before running it. Requiring the
    // "| " runtime-output prefix matches only the step's real stdout, not
    // that earlier script dump.
    const buildFinished = waitForOutput(/\|\s*BUILD_FINISHED\b/, 240000);
    const fullWindow = waitForOutput(/Waiting for client to connect \(at most 60 more second\(s\)\)/, 260000);
    const timedOut = waitForOutput(/Timed out waiting for client to connect/, 340000);

    const sshCommand = await sshCommandPromise;
    console.log(`Found SSH command: ${sshCommand}`);
    expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

    const buildFinishedAt = await buildFinished.then(() => Date.now());
    console.log('BUILD_FINISHED observed');

    const fullWindowAt = await fullWindow.then(() => Date.now());
    console.log('Post step started counting down with the full 60s available');

    // The whole minute is still available after the 90s build: the countdown
    // starts once the post step begins, not when the main step launched it.
    expect(buildFinishedAt).toBeLessThan(fullWindowAt);

    // Nobody joins in this scenario, so the countdown must eventually expire.
    await timedOut;
    console.log('Post step timed out waiting for a client, as expected');
  }, 420000);
});

describe('E2E: a guest who leaves before the post step disarms the countdown', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Longer than killProcess's 5000ms SIGKILL fallback: act must be fully
      // dead (and its stdout/stderr listeners quiet) before the test file
      // concludes, or leftover act output after teardown makes Jest report
      // "Cannot log after tests are done" and fail the run despite every
      // assertion having passed.
      await sleep(6000);
    }
  });

  it('firstGuestJoinedAt survives a join that happened before the post step ever polled', async () => {
    const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
      workflowFile: '.github/workflows/e2e-fixture-detached.yml'
    });
    killActProcess = killProcess;

    // Register before any of these can fire.
    // Same reasoning as buildFinished above: require the "| " runtime-output
    // prefix so this doesn't match act's earlier dump of the step's script.
    const continued = waitForOutput(/\|\s*DETACHED_WORKFLOW_CONTINUED\b/, 180000);
    const guestJoinedMsg = waitForOutput(/A guest joined at/, 220000);
    const waitingForSessionEnd = waitForOutput(/Waiting for session to end/, 220000);
    // Since the daemon already recorded the join before the post step's first
    // poll, "Waiting for client to connect" (the counting message) must never
    // appear at all.
    const neverCounting = assertNeverPrints(waitForOutput, /Waiting for client to connect/, 240000);

    const sshCommand = await sshCommandPromise;
    console.log(`Found SSH command: ${sshCommand}`);
    expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

    await continued;
    console.log('Workflow continued past the upterm step (detached mode works)');

    // Join and leave during the 45s "Build" step, well before the post step
    // (which only starts once every regular step, including Build, finishes).
    await joinAsGuest(sshCommand, 3000);
    console.log('Guest joined and left during the build step');

    await guestJoinedMsg;
    await waitingForSessionEnd;
    console.log('Post step recognized the earlier join on its very first poll');

    const container = findContainer('act-E2E-Fixture-Detached');
    dockerExec(container, 'touch /continue');
    console.log('Touched /continue');

    await neverCounting;
  }, 360000);
});

describe('E2E: a join shorter than one poll interval still disarms the countdown', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Longer than killProcess's 5000ms SIGKILL fallback: act must be fully
      // dead (and its stdout/stderr listeners quiet) before the test file
      // concludes, or leftover act output after teardown makes Jest report
      // "Cannot log after tests are done" and fail the run despite every
      // assertion having passed.
      await sleep(6000);
    }
  });

  it('a join nobody polled while present is still recorded via firstGuestJoinedAt', async () => {
    const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
      workflowFile: '.github/workflows/e2e-fixture-detached.yml'
    });
    killActProcess = killProcess;

    // Register before any of these can fire.
    // Same reasoning as buildFinished above: require the "| " runtime-output
    // prefix so this doesn't match act's earlier dump of the step's script.
    const continued = waitForOutput(/\|\s*DETACHED_WORKFLOW_CONTINUED\b/, 180000);
    const firstCounting = waitForOutput(/Waiting for client to connect/, 220000);
    const guestJoinedMsg = waitForOutput(/A guest joined at/, 260000);

    const sshCommand = await sshCommandPromise;
    console.log(`Found SSH command: ${sshCommand}`);
    expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

    await continued;
    console.log('Workflow continued past the upterm step (detached mode works)');

    // No join during the build this time - let the post step start counting.
    await firstCounting;
    console.log('Post step began counting down; joining briefly now');

    // Shorter than the 5s poll interval: no single poll can observe the guest
    // mid-connection. Only the daemon's own recorded firstGuestJoinedAt makes
    // the next poll see the join.
    await joinAsGuest(sshCommand, 1500);
    console.log('Guest joined and left between two polls');

    await guestJoinedMsg;
    console.log('Post step picked up the join on its next poll');

    // Past the 60s countdown: it must not have timed out.
    const timedOutDuringWindow = await waitForOutput(/Timed out waiting for client to connect/, 70000).then(
      () => true,
      () => false
    );
    expect(timedOutDuringWindow).toBe(false);
    console.log('No timeout after the countdown window elapsed, as expected');

    const container = findContainer('act-E2E-Fixture-Detached');
    dockerExec(container, 'touch /continue');
    console.log('Touched /continue');
  }, 360000);
});
