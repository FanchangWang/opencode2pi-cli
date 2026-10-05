import os from 'node:os';
import path from 'node:path';

// The directory name is also the project's application id, so the data of a previous install
// under another name is never read back.
const APP_DIR = 'opencode2pi-cli';

export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP_DIR);
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), APP_DIR);
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), APP_DIR);
}

/**
 * The directory this process reads and writes.
 *
 * `OPENCODE_ZEN_CLI_DATA_DIR` overrides the platform default so a second omp
 * (or a test) can keep its own OpenCode install, logs and health store apart.
 */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_ZEN_CLI_DATA_DIR;
  return override && override.trim() ? override : dataDirectory();
}