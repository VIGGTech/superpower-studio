import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = path.resolve(__dirname, '..', 'version.json');

const FALLBACK = {
  productName: 'Superpowers Studio',
  edition: 'VIGGTech Edition',
  publisher: 'VIGGTech',
  version: '1.0.0',
  license: 'MIT',
  repository: 'https://github.com/VIGGTech/superpower-studio',
  upstream: {
    name: 'obra/superpowers',
    version: '7.0.2',
    url: 'https://github.com/obra/superpowers',
    author: 'Jesse Vincent',
    license: 'MIT',
  },
  attributions: [
    {
      name: 'addyosmani/agent-skills',
      url: 'https://github.com/addyosmani/agent-skills',
      author: 'Addy Osmani',
      license: 'MIT',
      scope: 'Engineering Pack (8 curated skills + checklists) and 4 Quality & Security expert personas',
    },
  ],
};

export function getVersionInfo() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return {
      ...FALLBACK,
      ...raw,
      upstream: { ...FALLBACK.upstream, ...(raw?.upstream || {}) },
      attributions: Array.isArray(raw?.attributions) ? raw.attributions : FALLBACK.attributions,
    };
  } catch {
    return structuredClone(FALLBACK);
  }
}
