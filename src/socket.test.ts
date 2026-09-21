import fs from 'fs';
import os from 'os';
import path from 'path';
import {findUptermAdminSocketInFilesystem, parseAdminSocketEnvironment} from './socket';

describe('Upterm admin socket compatibility', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-upterm-socket-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('finds the v0.29 flat socket layout', () => {
    const socket = path.join(root, 'upterm', 'tmux-1234.sock');
    fs.mkdirSync(path.dirname(socket), {recursive: true});
    fs.writeFileSync(socket, '');

    expect(findUptermAdminSocketInFilesystem(root)).toBe(socket);
  });

  it('finds v0.30 admin.sock in a named session directory', () => {
    const sessionRoot = path.join(root, 'upterm', 'sessions', 'tmux-1234');
    fs.mkdirSync(sessionRoot, {recursive: true});
    const adminSocket = path.join(sessionRoot, 'admin.sock');
    fs.writeFileSync(adminSocket, '');
    fs.writeFileSync(path.join(sessionRoot, 'attach.sock'), '');

    expect(findUptermAdminSocketInFilesystem(root)).toBe(adminSocket);
  });

  it('returns no socket when no session exists', () => {
    fs.mkdirSync(path.join(root, 'upterm'), {recursive: true});

    expect(findUptermAdminSocketInFilesystem(root)).toBeNull();
  });

  it('does not choose an arbitrary session when multiple sessions exist', () => {
    for (const name of ['first', 'second']) {
      const sessionRoot = path.join(root, 'upterm', 'sessions', name);
      fs.mkdirSync(sessionRoot, {recursive: true});
      fs.writeFileSync(path.join(sessionRoot, 'admin.sock'), '');
    }

    expect(findUptermAdminSocketInFilesystem(root)).toBeNull();
  });

  it('parses the supported UPTERM_ADMIN_SOCKET environment contract', () => {
    expect(parseAdminSocketEnvironment('TMUX_PANE=%1\nUPTERM_ADMIN_SOCKET=/tmp/upterm/admin.sock\n')).toBe('/tmp/upterm/admin.sock');
    expect(parseAdminSocketEnvironment('UPTERM_ADMIN_SOCKET=')).toBeNull();
    expect(parseAdminSocketEnvironment('UPTERM_ADMIN_SOCKET=/tmp/attach.sock\n')).toBe('/tmp/attach.sock');
  });
});
