import crypto from 'crypto';
import {execShellCommand, shellEscape} from './helpers';

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

export function parseSessionInfo(raw: string): SessionInfo {
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    // sshCommand is the marker: upterm only publishes it from a successful
    // admin query, alongside the counts.
    hasLiveDetail: typeof parsed.sshCommand === 'string' && parsed.sshCommand.length > 0
  };
}

/**
 * Look up the action's session by name.
 *
 * Returns null ONLY for a genuine not-found (no record within retained
 * history). Every other failure propagates: a lookup that failed must not be
 * indistinguishable from a session that finished.
 */
export async function getSession(name: string): Promise<SessionInfo | null> {
  let raw: string;
  try {
    raw = await execShellCommand(`upterm session info ${shellEscape(name)} -o json`);
  } catch (error) {
    if (/no session named/i.test(String(error))) return null;
    throw error;
  }
  return parseSessionInfo(raw);
}

export const UPTERM_MIN_VERSION = {major: 0, minor: 30, patch: 0};

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

/** Parse `upterm version`, whose first line is "Upterm version v0.30.0". */
export function parseUptermVersion(output: string): UptermVersion | null {
  const match = output.match(/version\s+v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

export function isUptermVersionSupported(v: UptermVersion): boolean {
  const {major, minor, patch} = UPTERM_MIN_VERSION;
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return v.patch >= patch;
}
