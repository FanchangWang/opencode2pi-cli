import { expect, test } from 'bun:test';

import { dataDirectory, resolveDataDirectory } from '../src/platform.ts';
import { locateOpencode, runtimeCandidates } from '../src/runtime.ts';
import { parseWindowsProxy } from '../src/system-proxy.ts';

test('platform paths preserve macOS data and locate Windows and Linux data', () => {
  expect(dataDirectory('darwin', {}, '/Users/test')).toBe('/Users/test/Library/Application Support/opencode-zen-cli');
  expect(dataDirectory('win32', { APPDATA: 'C:\\Users\\测试\\AppData\\Roaming' }, 'C:\\Users\\测试')).toBe('C:\\Users\\测试\\AppData\\Roaming\\opencode-zen-cli');
  expect(dataDirectory('win32', {}, 'C:\\Users\\Test')).toBe('C:\\Users\\Test\\AppData\\Roaming\\opencode-zen-cli');
  expect(dataDirectory('linux', { XDG_CONFIG_HOME: '/tmp/config' }, '/home/test')).toBe('/tmp/config/opencode-zen-cli');
});

test('the data directory override wins over the platform default', () => {
  expect(resolveDataDirectory({ OPENCODE_ZEN_CLI_DATA_DIR: '/tmp/zen-cli' })).toBe('/tmp/zen-cli');
  expect(resolveDataDirectory({ OPENCODE_ZEN_CLI_DATA_DIR: '   ' })).toBe(dataDirectory());
});

test('runtime discovery resolves only what PATH provides for opencode', () => {
  expect(runtimeCandidates()).toEqual(['opencode']);
});

test('the newest install that answers a version probe is used', async () => {
  const versions: Record<string, string> = { '/usr/local/bin/opencode': '1.18.32', '/home/test/.opencode/bin/opencode': '1.25.7', '/opt/homebrew/bin/opencode': 'not-a-version' };
  const found = await locateOpencode({ candidates: Object.keys(versions), probe: async file => versions[file]! });
  expect(found).toEqual({ file: '/home/test/.opencode/bin/opencode', version: '1.25.7' });
});

test('a missing or unusable OpenCode is reported with every candidate tried', async () => {
  await expect(locateOpencode({ candidates: ['/usr/local/bin/opencode'], probe: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); } }))
    .rejects.toThrow(/未找到可用的 OpenCode[\s\S]*\/usr\/local\/bin\/opencode: ENOENT/);
  await expect(locateOpencode({ candidates: ['/opt/oc.cmd'], probe: async () => 'not-a-version' })).rejects.toThrow(/无法识别的版本输出/);
});

test('Windows manual proxy accepts shared and per-protocol addresses', () => {
  const shared = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' });
  expect(shared.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
  expect(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'localhost:80' }).HTTPS_PROXY).toBe('http://localhost');
  expect(shared.no_proxy).toBe('localhost,127.0.0.1,::1');
  const split = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892' });
  expect(split.HTTP_PROXY).toBe('http://127.0.0.1:7890');
  expect(split.HTTPS_PROXY).toBe('http://127.0.0.1:7891');
  for (const settings of [{ ProxyEnable: 0 }, { ProxyEnable: 1, ProxyServer: 'socks=localhost:7890' }, { ProxyEnable: 1, ProxyServer: 'localhost:99999' }])
    expect(() => parseWindowsProxy(settings)).toThrow();
});