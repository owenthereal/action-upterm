import {getSession, isTerminal, parseSessionInfo, generateSessionName, parseUptermVersion, isUptermVersionSupported} from './session';
import {execShellCommand} from './helpers';

jest.mock('./helpers', () => ({
  ...jest.requireActual('./helpers'),
  execShellCommand: jest.fn()
}));

const mockedExec = execShellCommand as jest.MockedFunction<typeof execShellCommand>;

const READY_WITH_DETAIL = JSON.stringify({
  name: 'gha-3f9a1c05',
  status: 'ready',
  sessionId: 'sess-1',
  adminSocket: '/tmp/r/upterm/sessions/gha-3f9a1c05/admin.sock',
  logPath: '/tmp/b/state/upterm/upterm.log',
  sshCommand: 'ssh token@uptermd.upterm.dev',
  clientCount: 1,
  guestCount: 0
});

// lookup() returns the record's view with status still "ready" when the admin
// query fails or the session ID moved (cmd/upterm/command/session.go:485-488).
// clientCount and guestCount are declared without `omitempty` (session.go:395,400),
// so upterm sends them as 0 even here - the zero is an artifact of the struct,
// not a count of anybody.
const READY_WITHOUT_DETAIL = JSON.stringify({
  name: 'gha-3f9a1c05',
  status: 'ready',
  sessionId: 'sess-1',
  logPath: '/tmp/b/state/upterm/upterm.log',
  clientCount: 0,
  guestCount: 0
});

const ENDED_AFTER_SIGKILL = JSON.stringify({
  name: 'gha-3f9a1c05',
  status: 'ended',
  reason: 'unknown',
  signal: 'SIGKILL',
  clientCount: 0,
  guestCount: 0
});

describe('parseSessionInfo', () => {
  it('marks a ready session with an ssh command as having live detail', () => {
    const info = parseSessionInfo(READY_WITH_DETAIL);
    expect(info.status).toBe('ready');
    expect(info.hasLiveDetail).toBe(true);
    expect(info.sshCommand).toBe('ssh token@uptermd.upterm.dev');
    expect(info.guestCount).toBe(0);
  });

  it('marks a ready session without an ssh command as lacking live detail', () => {
    const info = parseSessionInfo(READY_WITHOUT_DETAIL);
    expect(info.status).toBe('ready');
    expect(info.hasLiveDetail).toBe(false);
    expect(info.sshCommand).toBeUndefined();
    // guestCount is PRESENT and zero - upterm always sends it. That zero means
    // UNKNOWN, not "nobody connected": hasLiveDetail is the only thing callers
    // may gate on. Reading this 0 as a real count would shut down a session
    // someone is actively attached to.
    expect(info.guestCount).toBe(0);
  });

  it('parses an ended session that crashed', () => {
    const info = parseSessionInfo(ENDED_AFTER_SIGKILL);
    expect(info.status).toBe('ended');
    expect(info.signal).toBe('SIGKILL');
    expect(info.hasLiveDetail).toBe(false);
  });

  it('tolerates output printed around the JSON', () => {
    // execShellCommand resolves with everything on stdout. On Windows the
    // `bash -lc` login shell re-sources /etc/profile, whose output lands in
    // front of the JSON; upterm can print notices too.
    const info = parseSessionInfo(`/etc/profile: sourcing /etc/profile.d/msys2.sh\n${READY_WITH_DETAIL}\n`);
    expect(info.status).toBe('ready');
    expect(info.hasLiveDetail).toBe(true);
    expect(info.sshCommand).toBe('ssh token@uptermd.upterm.dev');
  });

  it('names the problem and quotes the output when there is no JSON at all', () => {
    // A bare SyntaxError here gets swallowed into 'unknown' by the poll loop or
    // burns every readiness retry, with nothing in the log to explain it.
    expect(() => parseSessionInfo('bash: upterm: command not found\n')).toThrow(/Could not parse upterm session info output/);
    expect(() => parseSessionInfo('bash: upterm: command not found\n')).toThrow(/bash: upterm: command not found/);
  });

  it('names the problem and quotes the output when the JSON is malformed', () => {
    expect(() => parseSessionInfo('{"name": "gha-3f9a1c05", }')).toThrow(/Could not parse upterm session info output/);
    expect(() => parseSessionInfo('{"name": "gha-3f9a1c05", }')).toThrow(/"name": "gha-3f9a1c05"/);
  });
});

describe('isTerminal', () => {
  it('treats ended, ending and disconnected as terminal', () => {
    expect(isTerminal('ended')).toBe(true);
    expect(isTerminal('ending')).toBe(true);
    expect(isTerminal('disconnected')).toBe(true);
  });

  it('does not treat starting or ready as terminal', () => {
    expect(isTerminal('starting')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
  });
});

describe('getSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns parsed info for a live session', async () => {
    mockedExec.mockResolvedValue(READY_WITH_DETAIL);
    const info = await getSession('gha-3f9a1c05');
    expect(info?.status).toBe('ready');
    // Quiet: this runs every few seconds in the monitor and post loops, and its
    // JSON would otherwise be dumped into the job log each time.
    expect(mockedExec).toHaveBeenCalledWith("upterm session info 'gha-3f9a1c05' -o json", {quiet: true});
  });

  it('returns null when the session name is not found', async () => {
    mockedExec.mockRejectedValue(new Error('Command failed with exit code 1\nStderr: Error: no session named "gha-3f9a1c05"'));
    await expect(getSession('gha-3f9a1c05')).resolves.toBeNull();
  });

  it('propagates any other failure instead of reporting not-found', async () => {
    mockedExec.mockRejectedValue(new Error('Command failed with exit code 127\nStderr: upterm: command not found'));
    await expect(getSession('gha-3f9a1c05')).rejects.toThrow('command not found');
  });
});

describe('generateSessionName', () => {
  it('produces a short name upterm accepts', () => {
    const name = generateSessionName();
    // upterm's nameRe: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
    expect(name).toMatch(/^gha-[0-9a-f]{8}$/);
    expect(name).toHaveLength(12);
  });

  it('produces a different name each time', () => {
    expect(generateSessionName()).not.toBe(generateSessionName());
  });
});

describe('parseUptermVersion', () => {
  it('parses the first line of `upterm version`', () => {
    expect(parseUptermVersion('Upterm version v0.30.0\nGit commit: abc\n')).toEqual({major: 0, minor: 30, patch: 0});
  });

  it('parses a version without a leading v', () => {
    expect(parseUptermVersion('Upterm version 0.31.2')).toEqual({major: 0, minor: 31, patch: 2});
  });

  it('returns null for an unrecognized string', () => {
    expect(parseUptermVersion('Upterm version dev')).toBeNull();
    expect(parseUptermVersion('')).toBeNull();
  });
});

describe('isUptermVersionSupported', () => {
  it('accepts 0.30.0 and newer', () => {
    expect(isUptermVersionSupported({major: 0, minor: 30, patch: 0})).toBe(true);
    expect(isUptermVersionSupported({major: 0, minor: 31, patch: 2})).toBe(true);
    expect(isUptermVersionSupported({major: 1, minor: 0, patch: 0})).toBe(true);
  });

  it('rejects anything older', () => {
    expect(isUptermVersionSupported({major: 0, minor: 29, patch: 0})).toBe(false);
    expect(isUptermVersionSupported({major: 0, minor: 20, patch: 0})).toBe(false);
  });
});
