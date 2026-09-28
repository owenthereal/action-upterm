// A real child process, deliberately unmocked. The guard this pins is about the
// stdio the child actually receives, which a mocked spawn cannot demonstrate.
//
// Skipped on Windows, where execShellCommand shells through MSYS2 bash at a
// fixed absolute path; a unit run should not depend on that being installed.
import {execShellCommand} from './helpers';

jest.mock('@actions/core');

const describeOnUnix = process.platform === 'win32' ? describe.skip : describe;

describeOnUnix('execShellCommand stdin, with a real child process', () => {
  it('gives the child no readable stdin, so a command that reads it cannot hang', async () => {
    // bash's `read` blocks forever on an open stdin and exits non-zero on EOF.
    // With stdin ignored it sees EOF at once, so this rejects in milliseconds.
    //
    // If the stdio guard in execShellCommand is ever removed, this test does not
    // merely fail — it hangs until Jest's timeout, which is precisely the failure
    // it exists to prevent: upterm's host-key confirmation prompt blocking a job
    // until the workflow timeout instead of failing fast.
    await expect(execShellCommand('read -r line')).rejects.toThrow(/exit code 1/);
  });
});
