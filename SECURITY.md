# Security Policy

## Reporting a vulnerability

Report it privately through GitHub, not in a public issue:
[Security → Report a vulnerability](https://github.com/owenthereal/action-upterm/security/advisories/new).

This action is a wrapper around [upterm](https://github.com/owenthereal/upterm).
If what you found is in the `upterm` CLI or in the `uptermd` relay rather than
in this action's own code, report it at
[upterm's advisory form](https://github.com/owenthereal/upterm/security/advisories/new)
instead, and see [upterm's SECURITY.md](https://github.com/owenthereal/upterm/blob/master/SECURITY.md)
for what to include and what to expect.

## Scope

In scope: this action — how it installs upterm, launches the session, decides
who is authorized, and what it writes to the job log.

Out of scope: that anyone authorized to join a session gets a shell on the
runner. That is what the action is for. Restrict who may join with
`limit-access-to-actor` or `limit-access-to-users`.
