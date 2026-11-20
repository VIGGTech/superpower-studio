#!/usr/bin/env node
import {
  DEFAULT_DATA_DIR,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readDaemonLogs,
  openStudio,
  installWindowsService,
  uninstallWindowsService,
  getWindowsServiceStatus,
  installWindowsShortcuts,
  uninstallWindowsShortcuts,
  getWindowsShortcutsStatus,
} from './lib/daemon.mjs';

const args = process.argv.slice(2);
const cmd = (args[0] || 'status').toLowerCase();

let port = Number(process.env.SUPERPOWERS_STUDIO_PORT) || 49500;
let host = process.env.SUPERPOWERS_STUDIO_HOST || '127.0.0.1';
let dataDir = process.env.SUPERPOWERS_STUDIO_DATA_DIR || DEFAULT_DATA_DIR;
let lines = 60;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  else if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
  else if (args[i] === '--lines' && args[i + 1]) lines = Number(args[++i]);
}

async function main() {
  switch (cmd) {
    case 'start': {
      const res = await startDaemon({ dataDir, port, host });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'stop': {
      const res = await stopDaemon({ dataDir });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'restart': {
      await stopDaemon({ dataDir });
      const res = await startDaemon({ dataDir, port, host });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'status': {
      const daemon = await getDaemonStatus({ dataDir });
      const windowsService = getWindowsServiceStatus();
      console.log(JSON.stringify({ daemon, windowsService }, null, 2));
      break;
    }
    case 'logs': {
      const text = readDaemonLogs({ dataDir, lines });
      console.log(text || '(no daemon logs yet)');
      break;
    }
    case 'install-service': {
      const res = installWindowsService({ dataDir, port, host });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'uninstall-service': {
      const res = uninstallWindowsService({ dataDir });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'service-status': {
      console.log(JSON.stringify(getWindowsServiceStatus(), null, 2));
      break;
    }
    case 'open': {
      const res = await openStudio({ dataDir, port, host });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'install-shortcuts': {
      const res = installWindowsShortcuts({ dataDir, port, host, desktop: true, startMenu: true });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'uninstall-shortcuts': {
      const res = uninstallWindowsShortcuts({ dataDir });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'shortcuts-status': {
      console.log(JSON.stringify(getWindowsShortcutsStatus(), null, 2));
      break;
    }
    default: {
      console.error('Usage: node studio/daemon.mjs <start|stop|restart|status|logs|open|install-service|uninstall-service|service-status|install-shortcuts|uninstall-shortcuts> [--port 49500] [--host 127.0.0.1]');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Superpowers Studio daemon error:', err.message);
  process.exit(1);
});
