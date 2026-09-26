import {SSH_COMMAND_TIMEOUT_MS, runActWorkflow, joinAsGuest, sleep, findContainer, dockerExec} from './utils';

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
 * Timeout budgeting.
 *
 * Every `waitForOutput` call below is registered at t=0 - before act has even
 * started - so its own ceiling must cover the FULL chain of events it waits
 * behind, not just the gap since the previous watcher resolved. A watcher for
 * something that happens after the SSH line and a 45s build, for instance,
 * needs SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS of budget at minimum, or a run
 * whose SSH line legitimately (if slowly) appears near that ceiling fails the
 * later watcher for a reason that has nothing to do with what it's testing.
 *
 * These constants name each link in that chain so a window's budget can be
 * read off instead of tuned by trial and error, and each `it()` timeout is
 * the same chain plus TEARDOWN_SLACK_MS, so Jest's own per-test timeout never
 * fires before an internal watcher's rejection could.
 */
const BUILD_45_MS = 45000; // e2e-fixture-detached.yml's "Build" step
const BUILD_90_MS = 90000; // e2e-fixture-long-build.yml's "Build longer than the countdown" step
const COUNTDOWN_MS = 60000; // wait-timeout-minutes: 1 on every timeout fixture used here (detached and attached)
const STEP_OVERHEAD_MS = 30000; // slack per hop: step setup/teardown, docker exec spawn, poll granularity
const TEARDOWN_SLACK_MS = 60000; // headroom between a chain's own ceiling and the it() timeout that must outlive it

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

  it(
    'a guest joins, leaves, and touching /continue ends the session',
    async () => {
      const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow();
      killActProcess = killProcess;

      // Register before it can fire. Depends only on the SSH line appearing,
      // then the guest joining/leaving and touching /continue (a few seconds).
      const sessionExited = waitForOutput(/Exiting debugging session because '\/continue' file was created/, SSH_COMMAND_TIMEOUT_MS + STEP_OVERHEAD_MS);

      const sshCommand = await sshCommandPromise;
      console.log(`Found SSH command: ${sshCommand}`);
      expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

      // Join as a guest, run a command, and leave (kill ssh, not "exit") without
      // ending the shared shell. Computed rather than a literal marker: with a
      // pty, the guest's own typed input is echoed back too, so a literal
      // 'echo E2E_GUEST_OK' would satisfy toContain() from the echoed
      // keystrokes alone, whether or not the command actually ran. Sending the
      // arithmetic and asserting on the evaluated result proves the shell
      // itself executed it.
      const guestOutput = await joinAsGuest(sshCommand, 4000, 'echo E2E_$((6*7))\n');
      expect(guestOutput).toContain('E2E_42');
      console.log('Guest saw E2E_42; guest left without ending the session');

      const container = findContainer('act-E2E-Fixture-upterm');
      dockerExec(container, 'touch /continue');
      console.log('Touched /continue');

      await sessionExited;
      console.log('Session exited because /continue was created');
    },
    SSH_COMMAND_TIMEOUT_MS + STEP_OVERHEAD_MS + TEARDOWN_SLACK_MS
  );
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

  it(
    'the 90s build finishes before the post step starts counting down its full 60s',
    async () => {
      const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
        workflowFile: '.github/workflows/e2e-fixture-long-build.yml'
      });
      killActProcess = killProcess;

      // Register before any of these can fire.
      // act's verbose logging dumps the generated step script (containing the
      // literal text `echo "BUILD_FINISHED"`) before running it. Requiring the
      // "| " runtime-output prefix matches only the step's real stdout, not
      // that earlier script dump.
      //
      // Each window's budget is the SSH ceiling plus everything that must
      // happen after the SSH line before that pattern can appear, plus one
      // STEP_OVERHEAD_MS per intervening hop.
      const buildFinished = waitForOutput(/\|\s*BUILD_FINISHED\b/, SSH_COMMAND_TIMEOUT_MS + BUILD_90_MS + STEP_OVERHEAD_MS);
      const fullWindow = waitForOutput(/Waiting for client to connect \(at most (5\d|60) more second\(s\)\)/, SSH_COMMAND_TIMEOUT_MS + BUILD_90_MS + STEP_OVERHEAD_MS * 2);
      const timedOut = waitForOutput(/Timed out waiting for client to connect/, SSH_COMMAND_TIMEOUT_MS + BUILD_90_MS + STEP_OVERHEAD_MS * 2 + COUNTDOWN_MS);

      const sshCommand = await sshCommandPromise;
      console.log(`Found SSH command: ${sshCommand}`);
      expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

      const buildFinishedAt = await buildFinished.then(() => Date.now());
      console.log('BUILD_FINISHED observed');

      const fullWindowAt = await fullWindow.then(() => Date.now());
      console.log("Post step shows (nearly) the full 60s left on upterm's deadline");

      // Nearly the whole minute is still available after the 90s build: upterm
      // counts from the post step's 'session set', not from launch (a window
      // counted from launch would have ended the session during the build).
      expect(buildFinishedAt).toBeLessThan(fullWindowAt);

      // Nobody joins in this scenario, so the countdown must eventually expire.
      await timedOut;
      console.log('Post step timed out waiting for a client, as expected');
    },
    SSH_COMMAND_TIMEOUT_MS + BUILD_90_MS + STEP_OVERHEAD_MS * 2 + COUNTDOWN_MS + TEARDOWN_SLACK_MS
  );
});

describe('E2E: a guest who leaves before the post step claims the session', () => {
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

  it(
    'session set answers claimed, and the post step never counts down',
    async () => {
      const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
        workflowFile: '.github/workflows/e2e-fixture-detached.yml'
      });
      killActProcess = killProcess;

      // Register before any of these can fire.
      // Same reasoning as buildFinished above: require the "| " runtime-output
      // prefix so this doesn't match act's earlier dump of the step's script.
      //
      // continued only needs the SSH ceiling (it's the very next step); the
      // rest also need the 45s build to finish first, plus a hop per hurdle.
      const continued = waitForOutput(/\|\s*DETACHED_WORKFLOW_CONTINUED\b/, SSH_COMMAND_TIMEOUT_MS + STEP_OVERHEAD_MS);
      const guestJoinedMsg = waitForOutput(/A guest joined at/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 2);
      const claimedBySet = waitForOutput(/session gha-[0-9a-f]{8}: a guest joined at \S+; automatic join timeout disabled/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 2);
      const waitingForSessionEnd = waitForOutput(/Waiting for session to end/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 2);
      // upterm recorded the join during the build, so 'session set' changes
      // nothing and the first poll latches: "Waiting for client to connect"
      // (the counting message) must never appear at all. Covers the whole
      // scenario, including touching /continue and the post step noticing it,
      // so one hop more than the above.
      const neverCounting = assertNeverPrints(waitForOutput, /Waiting for client to connect/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 3);

      const sshCommand = await sshCommandPromise;
      console.log(`Found SSH command: ${sshCommand}`);
      expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

      await continued;
      console.log('Workflow continued past the upterm step (detached mode works)');

      // Join and leave during the 45s "Build" step, well before the post step
      // (which only starts once every regular step, including Build, finishes).
      await joinAsGuest(sshCommand, 3000);
      console.log('Guest joined and left during the build step');

      await claimedBySet;
      await guestJoinedMsg;
      await waitingForSessionEnd;
      console.log('Post step recognized the earlier join on its very first poll');

      const container = findContainer('act-E2E-Fixture-Detached');
      dockerExec(container, 'touch /continue');
      console.log('Touched /continue');

      await neverCounting;
    },
    SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 3 + TEARDOWN_SLACK_MS
  );
});

describe('E2E: a join shorter than one poll interval still claims the session', () => {
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

  it(
    'a join nobody polled while present is still recorded via firstGuestJoinedAt',
    async () => {
      const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
        workflowFile: '.github/workflows/e2e-fixture-detached.yml'
      });
      killActProcess = killProcess;

      // Register before any of these can fire.
      // Same reasoning as buildFinished above: require the "| " runtime-output
      // prefix so this doesn't match act's earlier dump of the step's script.
      const continued = waitForOutput(/\|\s*DETACHED_WORKFLOW_CONTINUED\b/, SSH_COMMAND_TIMEOUT_MS + STEP_OVERHEAD_MS);
      const firstCounting = waitForOutput(/Waiting for client to connect/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 2);
      const guestJoinedMsg = waitForOutput(/A guest joined at/, SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 3);

      const sshCommand = await sshCommandPromise;
      console.log(`Found SSH command: ${sshCommand}`);
      expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

      await continued;
      console.log('Workflow continued past the upterm step (detached mode works)');

      // No join during the build this time - let the post step start counting.
      await firstCounting;
      console.log('Post step began counting down; joining briefly now');

      // Shorter than the 5s poll interval: no single poll can observe the guest
      // mid-connection. upterm's daemon records the join and disables its own
      // deadline; the next poll reports it via firstGuestJoinedAt.
      await joinAsGuest(sshCommand, 1500);
      console.log('Guest joined and left between two polls');

      await guestJoinedMsg;
      console.log('Post step picked up the join on its next poll');

      // Past the 60s window: upterm must not have ended it.
      const timedOutDuringWindow = await waitForOutput(/Timed out waiting for client to connect/, COUNTDOWN_MS + 10000).then(
        () => true,
        () => false
      );
      expect(timedOutDuringWindow).toBe(false);
      console.log('No timeout after the countdown window elapsed, as expected');

      const container = findContainer('act-E2E-Fixture-Detached');
      dockerExec(container, 'touch /continue');
      console.log('Touched /continue');
    },
    SSH_COMMAND_TIMEOUT_MS + BUILD_45_MS + STEP_OVERHEAD_MS * 3 + COUNTDOWN_MS + 10000 + TEARDOWN_SLACK_MS
  );
});

describe('E2E: attached mode, nobody joins, upterm ends the session at its deadline', () => {
  let killActProcess: (() => void) | null = null;

  afterAll(async () => {
    if (killActProcess) {
      console.log('Cleaning up: killing act process...');
      killActProcess();
      // Longer than killProcess's 5000ms SIGKILL fallback: see the first describe.
      await sleep(6000);
    }
  });

  it(
    "the attached step ends by upterm's own join timeout and the job carries on",
    async () => {
      const {sshCommandPromise, waitForOutput, killProcess} = runActWorkflow({
        workflowFile: '.github/workflows/e2e-fixture-attached-timeout.yml'
      });
      killActProcess = killProcess;

      // Register before any of these can fire. --join-timeout counts from
      // readiness, which is about when the SSH line prints.
      const counting = waitForOutput(/Waiting for client to connect \(at most \d+ more second\(s\)\)/, SSH_COMMAND_TIMEOUT_MS + STEP_OVERHEAD_MS);
      const timedOut = waitForOutput(/Timed out waiting for client to connect \(join timeout 1m\)/, SSH_COMMAND_TIMEOUT_MS + COUNTDOWN_MS + STEP_OVERHEAD_MS);
      // Same reasoning as buildFinished: the "| " prefix skips act's dump of the step's script.
      const nextStep = waitForOutput(/\|\s*ATTACHED_STEP_FINISHED\b/, SSH_COMMAND_TIMEOUT_MS + COUNTDOWN_MS + STEP_OVERHEAD_MS * 2);

      const sshCommand = await sshCommandPromise;
      console.log(`Found SSH command: ${sshCommand}`);
      expect(sshCommand).toMatch(SSH_COMMAND_PATTERN);

      await counting;
      console.log("Attached step is counting down to upterm's deadline");
      await timedOut;
      console.log('upterm ended the session at its deadline');
      await nextStep;
      console.log('The job carried on past the attached step');
    },
    SSH_COMMAND_TIMEOUT_MS + COUNTDOWN_MS + STEP_OVERHEAD_MS * 2 + TEARDOWN_SLACK_MS
  );
});
