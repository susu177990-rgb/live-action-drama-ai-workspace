import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProxyAgent, type Dispatcher } from 'undici';

const execFileAsync = promisify(execFile);
type FetchOptions = RequestInit & { dispatcher?: Dispatcher };
const proxyAgents = new Map<string, ProxyAgent>();
const proxyLookups = new Map<string, Promise<string | undefined>>();

function hostIsLocal(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function matchesNoProxy(hostname: string) {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  return list.some(pattern => pattern === '*' || (pattern.startsWith('.') ? host.endsWith(pattern) : host === pattern || host.endsWith(`.${pattern}`)));
}

function environmentProxy(protocol: string) {
  const names = protocol === 'https:' ? ['HTTPS_PROXY', 'https_proxy'] : ['HTTP_PROXY', 'http_proxy'];
  for (const name of [...names, 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function macOSSystemProxy(protocol: string) {
  if (process.platform !== 'darwin') return undefined;
  const prefix = protocol === 'https:' ? 'HTTPS' : 'HTTP';
  try {
    const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500, maxBuffer: 32 * 1024 });
    const value = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(stdout)?.[1];
    if (value(`${prefix}Enable`) !== '1') return undefined;
    const host = value(`${prefix}Proxy`);
    const port = value(`${prefix}Port`);
    if (!host || !port || !/^\d+$/.test(port)) return undefined;
    return `http://${host}:${port}`;
  } catch {
    return undefined;
  }
}

async function proxyFor(url: URL) {
  if (hostIsLocal(url.hostname) || matchesNoProxy(url.hostname)) return undefined;
  const key = url.protocol;
  let lookup = proxyLookups.get(key);
  if (!lookup) {
    lookup = (async () => environmentProxy(url.protocol) || await macOSSystemProxy(url.protocol))();
    proxyLookups.set(key, lookup);
  }
  return lookup;
}

async function dispatcherFor(proxy: string) {
  let dispatcher = proxyAgents.get(proxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxy);
    proxyAgents.set(proxy, dispatcher);
  }
  return dispatcher;
}

/** Fetch an external URL through the configured environment or macOS HTTPS proxy. */
export async function networkFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const proxy = await proxyFor(url);
  if (!proxy) return fetch(input, init);
  return fetch(input, { ...(init || {}), dispatcher: await dispatcherFor(proxy) } as FetchOptions);
}
