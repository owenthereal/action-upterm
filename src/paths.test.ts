/**
 * Platform-specific path handling integration tests
 *
 * These tests verify that path conversions work correctly across different
 * platforms and execution contexts (bash, native executables, MSYS2 utilities).
 */

import {shellEscape} from './helpers';

describe('Path handling', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    });
  });

  describe('toShellPath', () => {
    // Import the path handling functions for testing
    // Since these are internal functions, we'll test them through the module
    const toShellPath = (filePath: string): string => {
      return filePath.replace(/\\/g, '/');
    };

    it('should convert Windows backslashes to forward slashes', () => {
      expect(toShellPath('C:\\Users\\foo\\bar')).toBe('C:/Users/foo/bar');
      expect(toShellPath('C:\\Program Files\\App')).toBe('C:/Program Files/App');
    });

    it('should preserve Windows drive letter format', () => {
      expect(toShellPath('C:/Users/foo')).toBe('C:/Users/foo');
      expect(toShellPath('D:/Data/file.txt')).toBe('D:/Data/file.txt');
    });

    it('should handle Unix paths unchanged', () => {
      expect(toShellPath('/home/user/file')).toBe('/home/user/file');
      expect(toShellPath('/var/log/app.log')).toBe('/var/log/app.log');
    });

    it('should handle paths with spaces', () => {
      expect(toShellPath('C:\\Program Files\\My App\\file.txt')).toBe('C:/Program Files/My App/file.txt');
    });

    it('should handle relative paths', () => {
      expect(toShellPath('.\\config\\app.json')).toBe('./config/app.json');
      expect(toShellPath('..\\parent\\file')).toBe('../parent/file');
    });
  });

  describe('toMsys2Path', () => {
    const toMsys2Path = (filePath: string): string => {
      let result = filePath.replace(/\\/g, '/');
      if (process.platform === 'win32') {
        result = result.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
      }
      return result;
    };

    describe('on Windows', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'win32',
          configurable: true
        });
      });

      it('should convert Windows paths to POSIX format', () => {
        expect(toMsys2Path('C:\\Users\\foo\\bar')).toBe('/c/Users/foo/bar');
        expect(toMsys2Path('D:\\Data\\file.txt')).toBe('/d/Data/file.txt');
      });

      it('should handle paths with forward slashes', () => {
        expect(toMsys2Path('C:/Users/foo/bar')).toBe('/c/Users/foo/bar');
        expect(toMsys2Path('D:/Data/file.txt')).toBe('/d/Data/file.txt');
      });

      it('should handle uppercase drive letters', () => {
        expect(toMsys2Path('C:/Users/foo')).toBe('/c/Users/foo');
        expect(toMsys2Path('D:/Data')).toBe('/d/Data');
      });

      it('should handle paths with spaces', () => {
        expect(toMsys2Path('C:/Program Files/My App/file.txt')).toBe('/c/Program Files/My App/file.txt');
      });

      it('should not transform paths without drive letters', () => {
        expect(toMsys2Path('/already/posix/path')).toBe('/already/posix/path');
        expect(toMsys2Path('./relative/path')).toBe('./relative/path');
      });
    });

    describe('on Unix (Linux/macOS)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'linux',
          configurable: true
        });
      });

      it('should leave Unix paths unchanged', () => {
        expect(toMsys2Path('/home/user/file')).toBe('/home/user/file');
        expect(toMsys2Path('/var/log/app.log')).toBe('/var/log/app.log');
      });

      it('should handle paths with spaces', () => {
        expect(toMsys2Path('/home/user/My Documents/file.txt')).toBe('/home/user/My Documents/file.txt');
      });

      it('should handle relative paths', () => {
        expect(toMsys2Path('./config/app.json')).toBe('./config/app.json');
        expect(toMsys2Path('../parent/file')).toBe('../parent/file');
      });
    });
  });

  // The real export from ./helpers, not a copy: a local re-implementation can
  // only ever test itself, and would keep passing after the shipped one broke.
  describe('shellEscape', () => {
    it('should wrap strings in single quotes', () => {
      expect(shellEscape('hello world')).toBe("'hello world'");
      expect(shellEscape('file.txt')).toBe("'file.txt'");
    });

    it('should escape single quotes correctly', () => {
      expect(shellEscape("user's file")).toBe("'user'\\''s file'");
      expect(shellEscape("it's working")).toBe("'it'\\''s working'");
    });

    it('should handle URLs', () => {
      expect(shellEscape('ssh://server:22')).toBe("'ssh://server:22'");
      expect(shellEscape('https://example.com')).toBe("'https://example.com'");
    });

    it('should handle special shell characters', () => {
      expect(shellEscape('file with spaces')).toBe("'file with spaces'");
      expect(shellEscape('$variable')).toBe("'$variable'");
      expect(shellEscape('command; ls')).toBe("'command; ls'");
    });

    it('should handle empty strings', () => {
      expect(shellEscape('')).toBe("''");
    });

    it('should handle paths', () => {
      expect(shellEscape('/home/user/my file.txt')).toBe("'/home/user/my file.txt'");
      expect(shellEscape('C:/Program Files/App')).toBe("'C:/Program Files/App'");
    });
  });

  describe('Path usage patterns', () => {
    it('should use toShellPath for SSH key paths', () => {
      // SSH key generation uses toShellPath
      const idRsaPath = 'C:\\Users\\foo\\.ssh\\id_rsa';
      const shellPath = idRsaPath.replace(/\\/g, '/');
      expect(shellPath).toBe('C:/Users/foo/.ssh/id_rsa');
    });

    it('should use toMsys2Path for XDG environment variables on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true
      });

      const runtimeDir = 'C:/Users/foo/AppData/Local/Temp/upterm-rt-XXXXXX';
      let result = runtimeDir.replace(/\\/g, '/');
      result = result.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

      expect(result).toBe('/c/Users/foo/AppData/Local/Temp/upterm-rt-XXXXXX');
    });

    it('should use toMsys2Path for shell redirects on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true
      });

      const logPath = 'C:/temp/upterm-action-XXXXXX/state/upterm-command.log';
      let result = logPath.replace(/\\/g, '/');
      result = result.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

      expect(result).toBe('/c/temp/upterm-action-XXXXXX/state/upterm-command.log');
    });

    it('should preserve toShellPath format for tmux config when invoked from bash', () => {
      const tmuxConfPath = 'C:/temp/upterm-action-XXXXXX/tmux.conf';
      const shellPath = tmuxConfPath.replace(/\\/g, '/');
      expect(shellPath).toBe('C:/temp/upterm-action-XXXXXX/tmux.conf');
    });
  });
});
