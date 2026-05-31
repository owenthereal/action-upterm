// Regression test for Windows timeout-flag detection.
//
// On Windows the timeout flag is written by bash (in setupSessionTimeout) using
// the MSYS "/c/..." path form, which bash resolves to "C:\...". It is then read
// back by Node's fs in isTimeoutReached(). Node cannot resolve the "/c/..." form
// (it maps to "C:\c\..."), so isTimeoutReached() must check the *native* path
// instead -- the same one the flag actually lives at.
//
// This lives in its own file (rather than index.test.ts) because getUptermDirs()
// caches its result module-wide, and we need a fresh module whose os.tmpdir()
// returns a real Windows drive-letter path. The "/mock-tmp" path used elsewhere
// has no drive letter, so toMsys2Path() is a no-op there and cannot reproduce
// the bug.

import * as core from '@actions/core';
jest.mock('@actions/core');

jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn(),
  extractTar: jest.fn()
}));

jest.mock('fs', () => ({
  mkdirSync: jest.fn(() => true),
  existsSync: jest.fn(() => true),
  appendFileSync: jest.fn(() => true),
  writeFileSync: jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  readFileSync: jest.fn(() => '{}'),
  rmSync: jest.fn(),
  promises: {access: jest.fn()}
}));

// A real Windows tmpdir has a drive letter (C:\...). This is essential:
// toMsys2Path() only produces the buggy "/c/..." form when the input path
// starts with a drive letter.
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  tmpdir: jest.fn(() => 'C:/Users/runneradmin/AppData/Local/Temp'),
  homedir: jest.fn(() => 'C:/Users/runneradmin')
}));

import {execShellCommand, launchOutsideJobObject, sleep} from './helpers';
jest.mock('./helpers');
const mockedExecShellCommand = jest.mocked(execShellCommand);
const mockedLaunchOutsideJobObject = jest.mocked(launchOutsideJobObject);
const mockedSleep = jest.mocked(sleep);

import * as toolCache from '@actions/tool-cache';
const mockedToolCache = jest.mocked(toolCache);

import {run} from '.';
import fs from 'fs';
const mockFs = fs as jest.Mocked<typeof fs>;

const TIMEOUT_MESSAGE = 'Upterm session timed out - no client connected within the specified wait-timeout-minutes';

describe('isTimeoutReached on Windows', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', {value: 'win32'});
    Object.defineProperty(process, 'arch', {value: 'x64'});

    mockedToolCache.downloadTool.mockResolvedValue('/mock/upterm.tar.gz');
    mockedToolCache.extractTar.mockResolvedValue('/mock/upterm-extract');
    mockedExecShellCommand.mockResolvedValue('');
    mockedLaunchOutsideJobObject.mockReturnValue(undefined);
    mockedSleep.mockResolvedValue(undefined);

    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'upterm-server':
          return 'ssh://myserver:22';
        case 'wait-timeout-minutes':
          return '5';
        default:
          return '';
      }
    });
    (core.getState as jest.Mock).mockReturnValue('');
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {value: originalPlatform});
    Object.defineProperty(process, 'arch', {value: originalArch});
  });

  it('detects the timeout flag that bash wrote at the native path', async () => {
    // The flag file exists on disk. Node can only see it via the native
    // drive-letter path (C:/...); the MSYS "/c/..." form resolves to a
    // different, non-existent location and must therefore appear absent.
    let socketReads = 0;
    (mockFs.readdirSync as jest.Mock).mockImplementation(() => (++socketReads <= 12 ? ['upterm.sock'] : []));
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes('id_rsa') || s.includes('id_ed25519')) return false; // force SSH key generation
      if (s.endsWith('upterm.exe')) return true; // downloaded binary is present
      if (s.includes('continue')) return false; // no /continue file
      if (s.includes('timeout-flag')) return !s.startsWith('/c/'); // visible only via the native path
      return true; // directories, socket dir, etc.
    });

    await run();

    // With the buggy "/c/..." path this is never logged; the timeout would be
    // misreported as "'upterm' quit" once bash's kill-server drops the socket.
    expect(core.info).toHaveBeenCalledWith(TIMEOUT_MESSAGE);
  });

  it('clears a stale timeout flag from a reused temp dir instead of timing out immediately', async () => {
    // A reused temp directory (self-hosted runner, or a second invocation in
    // the same job) can still hold a timeout-flag from an earlier run. It must
    // be removed during session setup; otherwise monitorSession() would read
    // the stale flag and report a timeout before this session's timer is armed.
    let flagCleared = false;
    (mockFs.rmSync as jest.Mock).mockImplementation((p: fs.PathLike) => {
      if (p.toString().includes('timeout-flag')) flagCleared = true;
    });
    let socketReads = 0;
    (mockFs.readdirSync as jest.Mock).mockImplementation(() => (++socketReads <= 6 ? ['upterm.sock'] : []));
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes('id_rsa') || s.includes('id_ed25519')) return false;
      if (s.endsWith('upterm.exe')) return true;
      if (s.includes('continue')) return false;
      if (s.includes('timeout-flag')) return !flagCleared && !s.startsWith('/c/'); // stale until cleared
      return true;
    });

    await run();

    // The stale flag is removed at the native path, and no timeout is reported
    // (the run exits via "'upterm' quit" once the socket disappears).
    expect(mockFs.rmSync).toHaveBeenCalledWith('C:/Users/runneradmin/AppData/Local/Temp/upterm-data/timeout-flag', expect.objectContaining({force: true}));
    expect(core.info).not.toHaveBeenCalledWith(TIMEOUT_MESSAGE);
  });
});
