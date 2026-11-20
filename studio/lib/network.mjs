import os from 'node:os';
import { generateQrSvg } from './qr.mjs';

const VIRTUAL_IFACE_RE = /vethernet|wsl|docker|hyper-v|virtualbox|vmware|loopback|isatap|teredo/i;

export function isTailscaleIp(ip) {
  const m = String(ip || '').match(/^100\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const second = Number(m[1]);
  // RFC 6598 CGNAT 100.64.0.0/10 used by Tailscale
  return second >= 64 && second <= 127;
}

export function isPrivateLanIp(ip) {
  const m = String(ip || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function discoverMobileEndpoints({
  port = 49500,
  token = '',
  host = '127.0.0.1',
  interfaces = os.networkInterfaces(),
} = {}) {
  const lan = [];
  const tailscale = [];
  const seen = new Set();

  for (const [ifaceName, addrs] of Object.entries(interfaces || {})) {
    for (const info of addrs || []) {
      const fam = info.family === 4 ? 'IPv4' : String(info.family || '');
      if (fam !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);

      const url = `http://${ip}:${port}/?token=${token}`;
      const origin = `http://${ip}:${port}`;
      const isVirtual = VIRTUAL_IFACE_RE.test(ifaceName);

      if (isTailscaleIp(ip) || /tailscale/i.test(ifaceName)) {
        tailscale.push({
          kind: 'tailscale',
          label: `Tailscale VPN (${ifaceName})`,
          iface: ifaceName,
          ip,
          origin,
          url,
          isVirtual: false,
        });
      } else if (isPrivateLanIp(ip)) {
        lan.push({
          kind: 'lan',
          label: `Local Wi-Fi / LAN (${ifaceName})`,
          iface: ifaceName,
          ip,
          origin,
          url,
          isVirtual,
        });
      }
    }
  }

  // Prefer real Wi-Fi/Ethernet adapters over virtual WSL/Hyper-V adapters
  lan.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual) || a.iface.localeCompare(b.iface));

  const endpoints = [...tailscale, ...lan];
  const primary = tailscale[0] || lan[0] || null;
  let qrSvg = '';
  if (primary?.url) {
    try { qrSvg = generateQrSvg(primary.url); } catch { qrSvg = ''; }
  }

  return {
    listeningAllInterfaces: host === '0.0.0.0' || host === '::',
    lan,
    tailscale,
    endpoints,
    primaryUrl: primary?.url || null,
    qrSvg,
  };
}

export function isRemoteOriginAllowed(origin, {
  port = 49500,
  allowRemote = false,
  interfaces = os.networkInterfaces(),
  customOrigins = [],
} = {}) {
  if (!origin || origin === 'null') return false;
  const trimmed = String(origin).trim();

  // Explicit user-configured custom origins are always honored when exact-matched
  if (Array.isArray(customOrigins) && customOrigins.includes(trimmed)) {
    return true;
  }
  if (!allowRemote) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Tailscale MagicDNS HTTPS Serve (https://<machine>.<tailnet>.ts.net)
  if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.ts.net')) {
    return true;
  }

  // Local LAN or Tailscale IPv4 on the active Studio port
  const originPort = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (originPort !== Number(port)) return false;

  const disc = discoverMobileEndpoints({ port, token: '', host: '0.0.0.0', interfaces });
  return disc.endpoints.some((e) => e.ip === parsed.hostname);
}
