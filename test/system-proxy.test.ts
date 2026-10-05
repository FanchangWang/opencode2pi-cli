import { expect, test } from 'bun:test';

import { parseSystemProxy, systemProxyEnvironment } from '../src/system-proxy.ts';

test('system proxy maps HTTP and HTTPS and bypasses local services', () => {
  const env = parseSystemProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7892\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892');
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7892');
  expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
  expect(env.https_proxy).toBe(env.HTTPS_PROXY);
  expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
});

test('off leaves no proxy variable at all; unsupported or invalid config fails explicitly', async () => {
  // An empty HTTPS_PROXY is still "a proxy is configured" to several HTTP stacks,
  // so the disabled case must omit the variables entirely.
  const direct = await systemProxyEnvironment(false);
  expect('HTTPS_PROXY' in direct).toBe(false);
  expect(direct.NO_PROXY).toBe('localhost,127.0.0.1,::1');
  expect(() => parseSystemProxy('SOCKSEnable : 1')).toThrow(/HTTPS/);
  expect(() => parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999')).toThrow(/无效/);
});