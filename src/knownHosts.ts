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

/** The relay whose certificate authority is bundled above. */
const PINNED_HOST = 'uptermd.upterm.dev';

/**
 * pinnedKnownHostsFor returns the bundled pin when server is the public relay,
 * in any spelling this action ships an entry for, and null otherwise.
 *
 * Matching is on the parsed host and scheme, not the literal string: the same
 * relay is legitimately written `ssh://uptermd.upterm.dev:22`,
 * `ssh://uptermd.upterm.dev` or `wss://uptermd.upterm.dev`, and refusing a
 * spelling we hold the key for would send the user looking for a key they do
 * not need.
 *
 * `ws://` is excluded deliberately: there is no `[host]:80` entry in the bundle,
 * and the public relay redirects port 80 to HTTPS, so it is not a working way
 * to reach it.
 */
function pinnedKnownHostsFor(server: string): string | null {
  let u: URL;
  try {
    u = new URL(server.trim());
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== PINNED_HOST) return null;
  switch (u.protocol) {
    case 'ssh:':
      // Non-special scheme: an explicit :22 is preserved rather than normalized.
      // A portless ssh:// is recognized here as this host - upterm's own
      // `--server` parsing (cmd/upterm/command/host.go) requires an explicit
      // port for ssh:// and rejects a portless one with "missing port in
      // address", unlike ws:// and wss://, which it fills in as :80/:443.
      // That rejection is upterm's own, and clearer than anything this
      // matcher could substitute, so a portless ssh:// still resolves to the
      // bundled pin here and is left to fail at launch on the missing port,
      // not here.
      return u.port === '' || u.port === '22' ? DEFAULT_KNOWN_HOSTS : null;
    case 'wss:':
      // Special scheme: URL normalizes the default :443 away to ''.
      return u.port === '' ? DEFAULT_KNOWN_HOSTS : null;
    default:
      return null;
  }
}

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

  const pinned = pinnedKnownHostsFor(server);
  if (pinned) return pinned;

  return new Error(
    `upterm-server is ${server}, which this action has no host key for. ` +
      "Set the known-hosts input to that server's known_hosts entry " +
      '(`@cert-authority <host> <type> <key>` for a relay that presents a host ' +
      'certificate). A host key is bundled only for the public relay at ' +
      `ssh://${PINNED_HOST}:22 and wss://${PINNED_HOST}.`
  );
}
