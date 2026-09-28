import {knownHostsFor, DEFAULT_KNOWN_HOSTS} from './knownHosts';

describe('knownHostsFor', () => {
  it('returns the supplied known-hosts input verbatim, regardless of server', () => {
    expect(knownHostsFor('ssh://anything.example:22', '@cert-authority x ssh-ed25519 AAAA')).toBe('@cert-authority x ssh-ed25519 AAAA');
  });

  it('trims the supplied input', () => {
    expect(knownHostsFor('ssh://anything.example:22', '  @cert-authority x ssh-ed25519 AAAA  \n')).toBe('@cert-authority x ssh-ed25519 AAAA');
  });

  describe('with no known-hosts input, accepts every spelling of the bundled public relay', () => {
    it.each([
      ['default ssh with explicit :22', 'ssh://uptermd.upterm.dev:22'],
      ['ssh with the port omitted', 'ssh://uptermd.upterm.dev'],
      ['ssh with a trailing slash', 'ssh://uptermd.upterm.dev/'],
      ['wss with the port omitted', 'wss://uptermd.upterm.dev'],
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
