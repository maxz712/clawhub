// Rasterize the ClawHub diff-scratch mark to PNG for the contexts that need
// raster (iOS apple-touch, PWA/maskable icons, social og.png fallback) — the
// SVGs (favicon.svg, apple-touch-icon.svg) stay the source of truth for browsers
// that render SVG. One canonical mark definition here keeps every size on-brand
// and crisp (rendered at the target resolution, not upscaled).
//
// Usage:  node packages/dashboard/scripts/rasterize-icons.mjs
//         npm -w @clawhub/dashboard run icons:png
//
// Requires `sharp` (already a transitive dep; declared in devDependencies).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public");

// Brand
const MINT = "#00e5a0";
const BG = "#0a0a0c";
const LINE = "#26262e";
const TEXT = "#f5f5f7";
const MUTED = "#8a8a95";

// The mark: three claw slashes (= the +added lines of a diff). Authored in a
// 100-unit box so it scales to any pixel size. `lines` adds the faint "code"
// behind it (dropped at favicon sizes); `rounded` rounds the tile (platforms
// that don't mask, e.g. a standalone favicon).
function iconSvg(px, { lines = true, rounded = false } = {}) {
  const code = lines
    ? `<g stroke="${LINE}" stroke-width="5" stroke-linecap="round">
         <path d="M22 33 L62 33"/><path d="M22 50 L72 50"/><path d="M22 67 L47 67"/>
       </g>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="${rounded ? 22 : 0}" fill="${BG}"/>
    ${code}
    <g stroke="${MINT}" stroke-width="9" stroke-linecap="round">
      <path d="M55.4 14.3 L17.9 55.4"/>
      <path d="M67.9 23.2 L30.4 66.1"/>
      <path d="M80.4 33.9 L42.9 76.8"/>
    </g>
  </svg>`;
}

// 1200x630 social card (static default; the API generates per-repo cards live).
function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${BG}"/>
    <g transform="translate(80,70)">
      <g stroke="${MINT}" stroke-width="3.6" stroke-linecap="round" fill="none">
        <path d="M19.9 5.1 L6.4 19.9"/><path d="M24.4 8.4 L10.9 23.8"/><path d="M28.9 12.2 L15.4 27.6"/>
      </g>
      <text x="48" y="28" fill="${TEXT}" font-family="sans-serif" font-weight="700" font-size="30">claw<tspan fill="${MINT}">hub</tspan></text>
    </g>
    <text x="80" y="300" fill="${TEXT}" font-family="sans-serif" font-weight="800" font-size="74" letter-spacing="-2">Git hosting where</text>
    <text x="80" y="384" font-family="sans-serif" font-weight="800" font-size="74" letter-spacing="-2"><tspan fill="${MINT}">agents ship</tspan><tspan fill="${TEXT}">&#160;and humans review.</tspan></text>
    <text x="80" y="470" fill="${MUTED}" font-family="sans-serif" font-size="30">Humans and agents both commit. A human owns every merge above low risk.</text>
    <text x="80" y="552" fill="${MINT}" font-family="monospace" font-size="30">$ npm i -g useclawhub &amp;&amp; ch init</text>
  </svg>`;
}

const targets = [
  { name: "favicon-16.png", svg: iconSvg(16, { lines: false, rounded: true }) },
  { name: "favicon-32.png", svg: iconSvg(32, { lines: false, rounded: true }) },
  { name: "favicon-48.png", svg: iconSvg(48, { lines: true, rounded: true }) },
  { name: "apple-touch-icon.png", svg: iconSvg(180, { lines: true, rounded: false }) },
  { name: "icon-192.png", svg: iconSvg(192, { lines: true, rounded: false }) },
  { name: "icon-512.png", svg: iconSvg(512, { lines: true, rounded: false }) },
  { name: "og.png", svg: ogSvg() },
];

async function main() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error("✗ `sharp` is not installed. Run: npm i -D sharp\n  (it ships a rasterization backend — no system libraries needed).");
    process.exit(1);
  }
  for (const t of targets) {
    const png = await sharp(Buffer.from(t.svg)).png().toBuffer();
    await writeFile(join(OUT, t.name), png);
    console.log(`✓ ${t.name} (${png.length.toLocaleString()} bytes)`);
  }
  console.log(`\nWrote ${targets.length} PNGs to packages/dashboard/public/.`);
}

main().catch(e => { console.error(e); process.exit(1); });
