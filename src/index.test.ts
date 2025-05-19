import { when } from 'jest-when';

import * as core from '@actions/core';
jest.mock('@actions/core');

jest.mock('fs', () => ({
  mkdirSync: () => true,
  existsSync: () => true,
  appendFileSync: () => true,
  readdirSync: () => ['id_rsa', 'id_ed25519', 'hello.sock'],
  readFileSync: () => '{}',
  promises: {
    access: jest.fn()
  }
}));

import { execShellCommand } from './helpers';
jest.mock('./helpers');
const mockedExecShellCommand = jest.mocked(execShellCommand);

import { run } from '.';

describe('upterm GitHub integration', () => {
  const originalPlatform = process.platform;

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
  });

  it('should skip for windows', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    await run();
    expect(core.info).toHaveBeenCalledWith('Windows is not supported by upterm, skipping...');
  });

  it('should handle the main loop for linux x64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready...');
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
  });

  it('should handle the main loop for linux arm64', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'arm64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_arm64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');

    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready...');
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
  });

  it('error handling for unsupported linux arch', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'unknown'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(core.error).toHaveBeenNthCalledWith(1, 'Unsupported architecture: unknown');
  });


  it('should support custom known_hosts content', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');
    when(core.getInput).calledWith('ssh-known-hosts').mockReturnValueOnce('known hosts content');

    const customConnectionString = 'foobar';
    mockedExecShellCommand.mockReturnValue(Promise.resolve(customConnectionString));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'curl -sL https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/');
    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(2, 'if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    expect(core.info).toHaveBeenNthCalledWith(1, 'Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:');
    expect(core.info).toHaveBeenNthCalledWith(2, `${customConnectionString}`);
    expect(core.info).toHaveBeenNthCalledWith(3, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(4, 'Waiting for upterm to be ready...');
    expect(core.info).toHaveBeenNthCalledWith(5, "Exiting debugging session because '/continue' file was created");
  });

  it('should install using brew on macos', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });
    when(core.getInput).calledWith('limit-access-to-users').mockReturnValue('');
    when(core.getInput).calledWith('limit-access-to-actor').mockReturnValue('false');
    when(core.getInput).calledWith('wait-timeout-minutes').mockReturnValue('');
    when(core.getInput).calledWith('upterm-server').mockReturnValue('ssh://myserver:22');

    mockedExecShellCommand.mockReturnValue(Promise.resolve('foobar'));
    await run();

    expect(mockedExecShellCommand).toHaveBeenNthCalledWith(1, 'brew install owenthereal/upterm/upterm tmux');
    expect(core.info).toHaveBeenNthCalledWith(1, 'Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev');
    expect(core.info).toHaveBeenNthCalledWith(2, 'Creating a new session. Connecting to upterm server ssh://myserver:22');
    expect(core.info).toHaveBeenNthCalledWith(3, 'Waiting for upterm to be ready...');
    expect(core.info).toHaveBeenNthCalledWith(4, "Exiting debugging session because '/continue' file was created");
  });
});
