/**
 * The public upterm relay's certificate authority, copied verbatim from
 * upterm's etc/known_hosts/uptermd.upterm.dev.
 *
 * uptermd presents an SSH *host certificate*, which x/crypto's knownhosts only
 * authorizes from an @cert-authority line — an `ssh-keyscan` plain key line
 * never matches it. Both entries are needed because a known_hosts pattern
 * matches the port exactly: a bare host is port 22, and wss:// is keyed as
 * [host]:443.
 *
 * Rotating the relay key means updating this constant and cutting a release;
 * pinned runners cannot pick it up any other way.
 */
export const DEFAULT_KNOWN_HOSTS = [
  '@cert-authority uptermd.upterm.dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICiecex8Dq718eSe1CCLgLvDmI7AagvCtax7brPFWkh4',
  '@cert-authority [uptermd.upterm.dev]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICiecex8Dq718eSe1CCLgLvDmI7AagvCtax7brPFWkh4'
].join('\n');

/** The default `upterm-server` input, from action.yml. */
export const DEFAULT_UPTERM_SERVER = 'ssh://uptermd.upterm.dev:22';

/**
 * knownHostsFor returns the known_hosts contents to pin for this server, or an
 * Error explaining what the workflow has to supply.
 *
 * A custom server with no input fails rather than falling back to
 * --skip-host-key-check: on a fresh runner that accepts whatever answers, which
 * is precisely what a debugging session must not do.
 */
export function knownHostsFor(server: string, input: string): string | Error {
  const supplied = input.trim();
  if (supplied) return supplied;
  if (server.trim() === DEFAULT_UPTERM_SERVER) return DEFAULT_KNOWN_HOSTS;
  return new Error(
    `upterm-server is ${server}, which this action has no host key for. ` + "Set the known-hosts input to that server's known_hosts entry " + '(`@cert-authority <host> <type> <key>` for a relay that presents a host certificate).'
  );
}
