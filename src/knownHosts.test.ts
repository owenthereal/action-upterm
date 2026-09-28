import {knownHostsFor, DEFAULT_KNOWN_HOSTS} from './knownHosts';

describe('knownHostsFor', () => {
  it('returns the supplied known-hosts input verbatim, regardless of server', () => {
    expect(knownHostsFor('ssh://anything.example:22', '@cert-authority x ssh-ed25519 AAAA')).toBe('@cert-authority x ssh-ed25519 AAAA');
  });

  it('trims the supplied input', () => {
    expect(knownHostsFor('ssh://anything.example:22', '  @cert-authority x ssh-ed25519 AAAA  \n')).toBe('@cert-authority x ssh-ed25519 AAAA');
  });

  describe('with no known-hosts input, the matcher recognizes every spelling of the bundled public relay', () => {
    // These assert that pinnedKnownHostsFor() identifies the host from the
    // parsed URL, not that upterm would actually launch against it: upterm's
    // own --server parsing (cmd/upterm/command/host.go) requires an explicit
    // port for ssh:// and rejects a portless one with "missing port in
    // address", even though the matcher (correctly) still resolves it to
    // this host. wss:// has no such requirement - upterm fills in :443 - so
    // portless wss:// both matches here and launches.
    it.each([
      ['default ssh with explicit :22', 'ssh://uptermd.upterm.dev:22'],
      ['ssh with the port omitted - upterm itself still requires one at launch', 'ssh://uptermd.upterm.dev'],
      ['ssh with a trailing slash', 'ssh://uptermd.upterm.dev/'],
      ['wss with the port omitted, which upterm fills in as :443', 'wss://uptermd.upterm.dev'],
      ['wss with explicit :443, which URL normalizes away', 'wss://uptermd.upterm.dev:443'],
      ['wss with a trailing slash', 'wss://uptermd.upterm.dev/']
    ])('%s (%s)', (_label, server) => {
      expect(knownHostsFor(server, '')).toBe(DEFAULT_KNOWN_HOSTS);
    });
  });

  describe('with no known-hosts input, fails closed', () => {
    it.each([
      ['ws:// has no bundled :80 entry and the relay does not serve it', 'ws://uptermd.upterm.dev'],
      ['a non-default port on the right host', 'ssh://uptermd.upterm.dev:2222'],
      ['the right scheme and port on the wrong host', 'ssh://evil.example:22'],
      ['not a URL at all', 'not a url']
    ])('%s (%s)', (_label, server) => {
      const result = knownHostsFor(server, '');
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('known-hosts');
    });
  });
});
