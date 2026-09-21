import fs from 'fs';
import path from 'path';

function uniqueSocket(candidates: string[]): string | null {
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Parse the value exported by `tmux show-environment`.
 */
export function parseAdminSocketEnvironment(output: string): string | null {
  const line = output.split(/\r?\n/).find(candidate => candidate.startsWith('UPTERM_ADMIN_SOCKET='));
  const value = line?.slice('UPTERM_ADMIN_SOCKET='.length).trim();
  return value || null;
}

/**
 * Find exactly one action-owned admin socket without selecting attach.sock.
 *
 * The tmux environment is the primary contract used by the action. This
 * filesystem fallback covers v0.29's flat layout and installations where the
 * environment update has not reached tmux yet. Multiple candidates are
 * treated as ambiguous instead of choosing an arbitrary live session.
 */
export function findUptermAdminSocketInFilesystem(runtimeRoot: string): string | null {
  const uptermRoot = path.join(runtimeRoot, 'upterm');
  if (!fs.existsSync(uptermRoot)) return null;

  let directEntries: Array<string | fs.Dirent>;
  try {
    directEntries = fs.readdirSync(uptermRoot) as Array<string | fs.Dirent>;
  } catch {
    return null;
  }

  const legacy = directEntries
    .map(entry => (typeof entry === 'string' ? entry : entry.name))
    .filter(name => name.endsWith('.sock'))
    .map(name => path.join(uptermRoot, name));
  const legacySocket = uniqueSocket(legacy);
  if (legacySocket || legacy.length > 1) return legacySocket;

  const sessionsRoot = path.join(uptermRoot, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  let sessionEntries: Array<string | fs.Dirent>;
  try {
    sessionEntries = fs.readdirSync(sessionsRoot) as Array<string | fs.Dirent>;
  } catch {
    return null;
  }

  const nested = sessionEntries
    .map(entry => (typeof entry === 'string' ? entry : entry.name))
    .map(name => path.join(sessionsRoot, name, 'admin.sock'))
    .filter(socket => fs.existsSync(socket));

  return uniqueSocket(nested);
}
