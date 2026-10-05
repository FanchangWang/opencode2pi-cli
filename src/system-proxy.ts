import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * Proxy variables for the isolated child process.
 *
 * It extends `Record<string, string>` so it can be spread straight into the
 * spawn environment without re-typing the shape at each hand-off.
 */
export interface ProxyEnvironment extends Record<string, string> {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  http_proxy: string;
  https_proxy: string;
  NO_PROXY: string;
  no_proxy: string;
}

/**
 * What a child process gets when the system proxy is off.
 *
 * The proxy variables are absent rather than empty: an empty `HTTPS_PROXY` is
 * still "a proxy is configured", and several HTTP stacks honor it as such.
 */
export interface DirectEnvironment extends Record<string, string> {
  NO_PROXY: string;
  no_proxy: string;
}

export function parseSystemProxy(text: string): ProxyEnvironment {
  const value = (name: string): string | undefined =>
    text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  function address(kind: string): string | undefined {
    if (value(`${kind}Enable`) !== '1') return undefined;
    const host = value(`${kind}Proxy`), port = Number(value(`${kind}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('系统代理地址无效');
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  const http = address('HTTP'), https = address('HTTPS');
  if (!https) throw new Error('请先在 macOS 中启用 HTTPS 系统代理；暂不支持仅 SOCKS 或 PAC 配置');
  return { HTTP_PROXY: http || https, HTTPS_PROXY: https,
    http_proxy: http || https, https_proxy: https,
    NO_PROXY, no_proxy: NO_PROXY };
}

export async function systemProxyEnvironment(enabled: boolean): Promise<ProxyEnvironment | DirectEnvironment> {
  if (!enabled) return { NO_PROXY, no_proxy: NO_PROXY };
  if (process.platform === 'win32') {
    const script = "Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress";
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true });
    return parseWindowsProxy(JSON.parse(String(result.stdout)));
  }
  if (process.platform !== 'darwin') throw new Error('此系统暂不支持读取系统代理');
  return parseSystemProxy((await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 })).stdout);
}

export function parseWindowsProxy(settings: { ProxyEnable?: unknown; ProxyServer?: unknown }): ProxyEnvironment {
  if (!Number(settings.ProxyEnable) || !settings.ProxyServer)
    throw new Error('请先启用 Windows 手动系统代理；暂不支持仅 PAC 配置');
  const entries = String(settings.ProxyServer).trim().split(';').filter(Boolean);
  const split = entries.some(x => x.includes('='));
  const map: Record<string, string | undefined> = split
    ? Object.fromEntries(entries.map(x => x.trim().split('=')))
    : { http: entries[0], https: entries[0] };
  const address = (value: string | undefined): string => {
    if (!value || /[\s/@?#]/.test(value)) throw new Error('Windows 系统代理地址无效');
    let url: URL;
    try { url = new URL('http://' + value); } catch { throw new Error('Windows 系统代理地址无效'); }
    const port = Number(value.match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Windows 系统代理端口无效');
    return url.origin;
  };
  const https = address(map.https || map.http), http = address(map.http || map.https);
  return { HTTP_PROXY: http, HTTPS_PROXY: https, http_proxy: http, https_proxy: https, NO_PROXY, no_proxy: NO_PROXY };
}