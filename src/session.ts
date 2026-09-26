import crypto from 'crypto';
import {execShellCommand, shellEscape, ShellCommandError} from './helpers';

/**
 * Session statuses.
 *
 * The record persists four (host/sessiondir/record.go:16-19); the CLI
 * synthesizes a fifth, "ended", when nobody holds the name - which covers BOTH
 * an ordinary completed session and a crashed one whose record still says
 * "ready" (cmd/upterm/command/session.go:437-441). Terminating on "ending"
 * alone would miss essentially every real exit.
 */
export type SessionStatus = 'starting' | 'ready' | 'disconnected' | 'ending' | 'ended';

const TERMINAL_STATUSES: readonly SessionStatus[] = ['disconnected', 'ending', 'ended'];

export interface SessionInfo {
  name: string;
  status: SessionStatus;
  sessionId?: string;
  adminSocket?: string;
  attachSocket?: string;
  logPath?: string;
  pid?: number;
  sshCommand?: string;
  clientCount?: number;
  guestCount?: number;
  connectedClients?: string[];
  reason?: string;
  exitCode?: number;
  signal?: string;
  /**
   * When the first guest's session was accepted, as upterm records it (v0.31.0+).
   *
   * Session-lifetime and published by the daemon from its own join events, so
   * it is set even for a guest who joined and left between two of our polls,
   * and it survives the session: an ended session's record still carries it.
   * Absent until a guest joins. Forwarding-only connections never set it.
   */
  firstGuestJoinedAt?: string;
  /**
   * True when upterm's admin query succeeded and the detail fields above are
   * trustworthy.
   *
   * A "ready" status does NOT imply this: when the admin query fails or the
   * session ID moved underneath the lookup, upterm returns the record's view
   * with status still "ready" (cmd/upterm/command/session.go:485-488). What is
   * absent in that case is `sshCommand`. `clientCount` and `guestCount` are NOT
   * absent — they are declared without `omitempty` (session.go:395,400) and
   * infoFromRecord (session.go:494-508) leaves them at their zero value, so
   * upterm sends `0`. Therefore `hasLiveDetail` is the ONLY valid gate. Never
   * test `guestCount === undefined` — it will never fire. A `0` with
   * `hasLiveDetail === false` means UNKNOWN, not "nobody connected"; reading
   * it as a real count would shut down a session someone is attached to.
   */
  hasLiveDetail: boolean;
}

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Parse `upterm session info -o json` output.
 *
 * execShellCommand resolves with EVERYTHING written to stdout, so the JSON can
 * arrive with company: an upterm notice, or the /etc/profile chatter the
 * Windows `bash -lc` *login* shell emits. Slice to the object rather than
 * letting a stray line fail the parse.
 *
 * When it still cannot be parsed, say so and quote the output. A bare
 * SyntaxError gets swallowed into 'unknown' by the caller's poll loop or burns
 * the readiness retries, leaving no clue in the log about what upterm actually
 * printed.
 */
export function parseSessionInfo(raw: string): SessionInfo {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end < start) {
    throw new Error(`Could not parse upterm session info output (no JSON object found): ${raw}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Could not parse upterm session info output: ${error}\nOutput was: ${raw}`);
  }

  return {
    ...parsed,
    // sshCommand is the marker: upterm only publishes it from a successful
    // admin query, alongside the counts.
    hasLiveDetail: typeof parsed.sshCommand === 'string' && parsed.sshCommand.length > 0
  };
}

/**
 * upterm's exit status for "no session has this name", from `session info`,
 * `session stop` and `session set` (v0.32.0+). Every other failure exits 1.
 */
export const NO_SESSION_EXIT_CODE = 4;

/** Whether a failed upterm call said there is no session by that name. */
export function isNoSuchSession(error: unknown): boolean {
  return error instanceof ShellCommandError && error.exitCode === NO_SESSION_EXIT_CODE;
}

/**
 * Look up the action's session by name.
 *
 * Returns null ONLY for a genuine not-found: upterm's exit 4, no record
 * within retained history. Every other failure propagates: a lookup that
 * failed must not be indistinguishable from a session that finished.
 */
export async function getSession(name: string): Promise<SessionInfo | null> {
  let raw: string;
  try {
    // Quiet: the monitor and post loops call this every few seconds for as long
    // as someone is connected, and each call would dump its JSON into the log.
    raw = await execShellCommand(`upterm session info ${shellEscape(name)} -o json`, {quiet: true});
  } catch (error) {
    if (isNoSuchSession(error)) return null;
    throw error;
  }
  return parseSessionInfo(raw);
}

/**
 * v0.31.0 is the first upterm that publishes firstGuestJoinedAt. Below it the
 * field is always absent, which v2 would read as "nobody has joined" and stop a
 * session someone is sitting in — so older versions are refused, not guessed at.
 */
export const UPTERM_MIN_VERSION = {major: 0, minor: 31, patch: 0};

export interface UptermVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Generate this run's session name.
 *
 * Short on purpose: the name becomes a path component under the runtime root,
 * and upterm caps the resulting socket path at 103 bytes on every platform.
 */
export function generateSessionName(): string {
  return `gha-${crypto.randomBytes(4).toString('hex')}`;
}

/** Parse `upterm version`, whose first line is "upterm version v0.30.0". */
export function parseUptermVersion(output: string): UptermVersion | null {
  const match = output.match(/version\s+v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

/** Whether upterm has recorded a qualifying guest join for this session. */
export function hasGuestJoined(session: SessionInfo): boolean {
  return typeof session.firstGuestJoinedAt === 'string' && session.firstGuestJoinedAt.length > 0;
}

export function formatVersion(v: UptermVersion): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function isUptermVersionSupported(v: UptermVersion): boolean {
  const {major, minor, patch} = UPTERM_MIN_VERSION;
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return v.patch >= patch;
}
