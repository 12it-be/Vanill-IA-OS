/**
 * ==============================================================================
 * Vanill-IA OS — Zero-Dependency Local QR Code SVG Generator (ISO/IEC 18004)
 * Generates crisp SVG QR codes locally for TOTP 2FA (otpauth:// URIs) so secrets
 * NEVER leave the Debian server toward external third-party APIs.
 * Supports Byte mode, Error Correction Level L, Versions 1..10 (up to 271 bytes).
 * ==============================================================================
 */

// Capacités totales de codewords de données + EC par version (1..10) en niveau EC = L (1 bloc jusqu'à v5, 2 blocs v6..9, 4 blocs v10)
const VERSION_SPECS = [
  null,
  { totalData: 19, ecPerBlock: 7, blocks: [19], align: [] },
  { totalData: 34, ecPerBlock: 10, blocks: [34], align: [6, 18] },
  { totalData: 55, ecPerBlock: 15, blocks: [55], align: [6, 22] },
  { totalData: 80, ecPerBlock: 20, blocks: [80], align: [6, 26] },
  { totalData: 108, ecPerBlock: 26, blocks: [108], align: [6, 30] },
  { totalData: 136, ecPerBlock: 18, blocks: [68, 68], align: [6, 34] },
  { totalData: 156, ecPerBlock: 20, blocks: [78, 78], align: [6, 22, 38] },
  { totalData: 194, ecPerBlock: 24, blocks: [97, 97], align: [6, 24, 42] },
  { totalData: 232, ecPerBlock: 30, blocks: [116, 116], align: [6, 26, 46] },
  { totalData: 274, ecPerBlock: 18, blocks: [68, 68, 69, 69], align: [6, 28, 50] },
];

const VERSION_INFO_BITS = {
  7: 0x07C94,
  8: 0x085BC,
  9: 0x09A99,
  10: 0x0A4D3,
};

// Tables GF(256) pour Reed-Solomon (polynôme primitif 0x11D)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(dataBytes, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of dataBytes) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) {
      rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

function pickVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const headerBits = v <= 9 ? 4 + 8 : 4 + 16;
    const maxBytes = Math.floor((VERSION_SPECS[v].totalData * 8 - headerBits) / 8);
    if (byteLength <= maxBytes) return v;
  }
  throw new Error('Contenu QR Code trop long (max 271 octets).');
}

function buildCodewords(utf8Bytes, version) {
  const spec = VERSION_SPECS[version];
  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode Byte = 0100
  pushBits(0b0100, 4);
  pushBits(utf8Bytes.length, version <= 9 ? 8 : 16);
  for (const b of utf8Bytes) pushBits(b, 8);

  const capacityBits = spec.totalData * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataWords.push(byte);
  }

  const pads = [0xEC, 0x11];
  let padIdx = 0;
  while (dataWords.length < spec.totalData) {
    dataWords.push(pads[padIdx % 2]);
    padIdx += 1;
  }

  // Découpage en blocs et entrelacement Reed-Solomon
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const blockLen of spec.blocks) {
    const slice = dataWords.slice(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(slice);
    ecBlocks.push(Array.from(rsRemainder(slice, spec.ecPerBlock)));
  }

  const interleaved = [];
  const maxDataLen = Math.max(...spec.blocks);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      interleaved.push(ec[i]);
    }
  }

  return interleaved;
}

function calcFormatBits(ecLevelBits, maskPattern) {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

export function renderQrCodeSvg(text, { padding = 3, darkColor = '#0F1115', lightColor = '#FFFFFF' } = {}) {
  const utf8 = new TextEncoder().encode(text);
  const version = pickVersion(utf8.length);
  const size = version * 4 + 17;
  const spec = VERSION_SPECS[version];
  const codewords = buildCodewords(utf8, version);

  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setModule = (r, c, dark) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r][c] = dark ? 1 : 0;
      reserved[r][c] = 1;
    }
  };

  // Finder patterns + séparateurs
  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(top + r, left + c, inOuter && (onBorder || inInner));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const r of spec.align) {
    for (const c of spec.align) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setModule(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Réservation des zones d'information de format + dark module fixe
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  setModule(size - 8, 8, true);

  // Version info (v7..v10)
  if (version >= 7) {
    const vBits = VERSION_INFO_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(b, a, bit);
      setModule(a, b, bit);
    }
  }

  // Placement zigzag des bits de données + masque 0 ((r + c) % 2 === 0)
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!reserved[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx += 1;
          }
          if ((r + c) % 2 === 0) dark = !dark;
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Écriture des 15 bits de format ISO/IEC 18004 (EC Level L = 0b01, Mask = 0)
  // Bit 14 = MSB, Bit 0 = LSB
  const formatBits = calcFormatBits(0b01, 0);
  const fBit = (n) => (formatBits >>> n) & 1;

  // Copie 1 : Autour du Finder Haut-Gauche
  modules[8][0] = fBit(14);
  modules[8][1] = fBit(13);
  modules[8][2] = fBit(12);
  modules[8][3] = fBit(11);
  modules[8][4] = fBit(10);
  modules[8][5] = fBit(9);
  modules[8][7] = fBit(8);
  modules[8][8] = fBit(7);
  modules[7][8] = fBit(6);
  modules[5][8] = fBit(5);
  modules[4][8] = fBit(4);
  modules[3][8] = fBit(3);
  modules[2][8] = fBit(2);
  modules[1][8] = fBit(1);
  modules[0][8] = fBit(0);

  // Copie 2 : Haut-Droite (bits 0..7) & Bas-Gauche (bits 8..14)
  for (let i = 0; i <= 7; i++) {
    modules[8][size - 1 - i] = fBit(i);
  }
  for (let i = 8; i <= 14; i++) {
    modules[size - 15 + i][8] = fBit(i);
  }

  const fullSize = size + padding * 2;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c] === 1) {
        pathData += `M${c + padding},${r + padding}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}" shape-rendering="crispEdges" role="img" aria-label="QR Code 2FA TOTP"><rect width="${fullSize}" height="${fullSize}" rx="2" fill="${lightColor}"/><path d="${pathData}" fill="${darkColor}"/></svg>`;
}
