// Zero-dependency ISO/IEC 18004 QR Code Model 2 generator (Byte mode, ECC Level L, Versions 1..10)

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data, eccLen) {
  const gen = rsGeneratorPoly(eccLen);
  const rem = new Uint8Array(eccLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    for (let i = 0; i < eccLen - 1; i++) rem[i] = rem[i + 1];
    rem[eccLen - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < eccLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ISO/IEC 18004 ECC Level L tables for Versions 1..10
const VERSION_SPEC = [
  null,
  { totalData: 19, eccPerBlock: 7, blocks: [19], align: [] },
  { totalData: 34, eccPerBlock: 10, blocks: [34], align: [6, 18] },
  { totalData: 55, eccPerBlock: 15, blocks: [55], align: [6, 22] },
  { totalData: 80, eccPerBlock: 20, blocks: [80], align: [6, 26] },
  { totalData: 108, eccPerBlock: 26, blocks: [108], align: [6, 30] },
  { totalData: 136, eccPerBlock: 18, blocks: [68, 68], align: [6, 34] },
  { totalData: 156, eccPerBlock: 20, blocks: [78, 78], align: [6, 22, 38] },
  { totalData: 194, eccPerBlock: 24, blocks: [97, 97], align: [6, 24, 42] },
  { totalData: 232, eccPerBlock: 30, blocks: [116, 116], align: [6, 26, 46] },
  { totalData: 274, eccPerBlock: 18, blocks: [68, 68, 69, 69], align: [6, 28, 50] },
];

function chooseVersion(byteLen) {
  for (let v = 1; v < VERSION_SPEC.length; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const capacityBytes = Math.floor((VERSION_SPEC[v].totalData * 8 - 4 - countBits) / 8);
    if (byteLen <= capacityBytes) return v;
  }
  throw new Error(`QR payload too long (${byteLen} bytes; max 271 bytes)`);
}

function encodeDataCodewords(bytes, version) {
  const spec = VERSION_SPEC[version];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const totalBits = spec.totalData * 8;
  const term = Math.min(4, totalBits - bits.length);
  pushBits(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.totalData) {
    codewords.push(padBytes[padIdx % 2]);
    padIdx++;
  }

  // Split into RS blocks & interleave
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const bLen of spec.blocks) {
    const slice = codewords.slice(offset, offset + bLen);
    offset += bLen;
    dataBlocks.push(slice);
    eccBlocks.push(rsComputeEcc(slice, spec.eccPerBlock));
  }

  const out = [];
  const maxDataLen = Math.max(...spec.blocks);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.eccPerBlock; i++) {
    for (const ecc of eccBlocks) out.push(ecc[i]);
  }
  return out;
}

function formatInfoBits(mask) {
  // ECC Level L = 01
  const data = (0b01 << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionInfoBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function buildBaseMatrix(version) {
  const size = 17 + version * 4;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, val) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r][c] = val ? 1 : 0;
    reserved[r][c] = 1;
  };

  // 3 Finder patterns + 1-module separators
  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inOuter && (
          dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        );
        setFn(r, c, dark ? 1 : 0);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) setFn(6, i, dark);
    if (!reserved[i][6]) setFn(i, 6, dark);
  }

  // Alignment patterns
  const alignCoords = VERSION_SPEC[version].align;
  for (const r of alignCoords) {
    for (const c of alignCoords) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) setFn(8, i, 0);
    if (!reserved[i][8]) setFn(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    setFn(8, size - 1 - i, 0);
    setFn(size - 1 - i, 8, 0);
  }
  setFn(size - 8, 8, 1); // Dark module

  // Reserve & write version info for Version >= 7
  if (version >= 7) {
    const vBits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  return { size, grid, reserved };
}

function placeDataBits(grid, reserved, codewords) {
  const size = grid.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--; // Skip vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (reserved[row][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        grid[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

function writeFormatInfo(grid, mask) {
  const size = grid.length;
  const bits = formatInfoBits(mask);
  const b = (i) => (bits >> i) & 1;
  // Top-left around finder
  for (let i = 0; i <= 5; i++) grid[8][i] = b(14 - i);
  grid[8][7] = b(8);
  grid[8][8] = b(7);
  grid[7][8] = b(6);
  for (let i = 0; i <= 5; i++) grid[5 - i][8] = b(5 - i);
  // Top-right & bottom-left
  for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = b(i);
  for (let i = 0; i < 7; i++) grid[size - 7 + i][8] = b(14 - i);
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function evaluatePenalty(grid) {
  const n = grid.length;
  let score = 0;
  // Rule 1: 5+ consecutive same-color modules
  for (let r = 0; r < n; r++) {
    let runR = 1;
    let runC = 1;
    for (let i = 1; i < n; i++) {
      if (grid[r][i] === grid[r][i - 1]) runR++;
      else { if (runR >= 5) score += 3 + (runR - 5); runR = 1; }
      if (grid[i][r] === grid[i - 1][r]) runC++;
      else { if (runC >= 5) score += 3 + (runC - 5); runC = 1; }
    }
    if (runR >= 5) score += 3 + (runR - 5);
    if (runC >= 5) score += 3 + (runC - 5);
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function generateQrMatrix(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = encodeDataCodewords(bytes, version);
  const { size, grid, reserved } = buildBaseMatrix(version);
  placeDataBits(grid, reserved, codewords);

  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = grid.map((row) => Uint8Array.from(row));
    const fn = MASK_FNS[mask];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && fn(r, c)) candidate[r][c] ^= 1;
      }
    }
    writeFormatInfo(candidate, mask);
    const pen = evaluatePenalty(candidate);
    if (pen < bestScore) {
      bestScore = pen;
      bestMask = mask;
      bestGrid = candidate;
    }
  }

  return {
    version,
    size,
    mask: bestMask,
    modules: bestGrid.map((row) => Array.from(row)),
  };
}

export function generateQrSvg(text, { quietZone = 4, dark = '#111111', light = '#ffffff' } = {}) {
  const { size, modules } = generateQrMatrix(text);
  const total = size + quietZone * 2;
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${total}" height="${total}" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`;
}
