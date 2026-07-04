#!/usr/bin/env node
/**
 * clawhub-visual-diff — the harness's design-regression hand (plan N4).
 *
 * Pixel-compares a HEAD screenshot against a base-branch BASELINE and emits a
 * diff image + a mismatch ratio. Pure JS (pixelmatch + pngjs) — no native
 * per-arch pain in the multi-arch harness image. NON-GATING by design: a legit
 * UI change always diffs; the number is a signal for the human design pass, not a
 * merge gate ("humans keep taste, agents keep proof").
 *
 *   clawhub-visual-diff <baseline.png> <head.png> <out-diff.png> \
 *       [--threshold 0.1] [--ignore x,y,w,h] [--ignore ...]
 *
 * Prints one JSON line: { width, height, diffPixels, totalPixels, mismatchRatio,
 * sizeMismatch, diffPath }. Exit 0 always when it could produce a result (the
 * verifier decides what the ratio means); exit 2 only on a usage/IO error.
 *
 * --ignore masks a rectangle (dynamic content: clocks, spinners, randomized ids)
 * to the SAME solid colour in BOTH images before diffing, so it contributes zero
 * mismatch. Regions are clamped to the image; out-of-range values are ignored,
 * never throw.
 *
 * Dimension mismatch is a REAL design signal, not an error: we diff the
 * overlapping top-left region and count every pixel outside it as mismatched, so
 * a resized layout reports a high ratio with sizeMismatch:true instead of
 * crashing (pixelmatch itself requires equal dimensions).
 */
import { readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

function fail(msg) {
  process.stderr.write(`clawhub-visual-diff: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  let threshold = 0.1;
  const ignore = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") {
      threshold = Number(argv[++i]);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail("--threshold must be 0..1");
    } else if (a === "--ignore") {
      const parts = String(argv[++i] ?? "").split(",").map(Number);
      if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) fail("--ignore needs x,y,w,h");
      ignore.push(parts);
    } else if (a.startsWith("--")) {
      fail(`unknown flag ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 3) fail("usage: clawhub-visual-diff <baseline.png> <head.png> <out-diff.png> [--threshold t] [--ignore x,y,w,h]");
  return { baseline: positional[0], head: positional[1], out: positional[2], threshold, ignore };
}

function readPng(path) {
  try {
    return PNG.sync.read(readFileSync(path));
  } catch (e) {
    fail(`cannot read PNG ${path}: ${e.message}`);
  }
}

// Copy `src` RGBA into a fresh w×h buffer at top-left, transparent-padding the
// rest — so two differently-sized images become comparable on their overlap.
function fitInto(src, w, h) {
  if (src.width === w && src.height === h) return src.data;
  const out = Buffer.alloc(w * h * 4, 0);
  const copyW = Math.min(src.width, w);
  const copyH = Math.min(src.height, h);
  for (let y = 0; y < copyH; y++) {
    const srcStart = y * src.width * 4;
    const dstStart = y * w * 4;
    src.data.copy(out, dstStart, srcStart, srcStart + copyW * 4);
  }
  return out;
}

// Mask a rectangle to a fixed colour in-place (same colour in both images ⇒ zero
// mismatch there). Clamped; silently ignores a rectangle fully outside the frame.
function maskRegion(data, w, h, [rx, ry, rw, rh]) {
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(w, Math.floor(rx + rw));
  const y1 = Math.min(h, Math.floor(ry + rh));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
    }
  }
}

export function diffPngBuffers(baselinePng, headPng, { threshold = 0.1, ignore = [] } = {}) {
  // Compare on the UNION frame so a size change is counted, not crashed on.
  const width = Math.max(baselinePng.width, headPng.width);
  const height = Math.max(baselinePng.height, headPng.height);
  const sizeMismatch = baselinePng.width !== headPng.width || baselinePng.height !== headPng.height;

  const aData = Buffer.from(fitInto(baselinePng, width, height));
  const bData = Buffer.from(fitInto(headPng, width, height));
  for (const r of ignore) { maskRegion(aData, width, height, r); maskRegion(bData, width, height, r); }

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(aData, bData, diff.data, width, height, { threshold });
  const totalPixels = width * height;
  return {
    width, height, diffPixels, totalPixels,
    mismatchRatio: totalPixels ? diffPixels / totalPixels : 0,
    sizeMismatch,
    diffPngBuffer: PNG.sync.write(diff),
  };
}

function main() {
  const { baseline, head, out, threshold, ignore } = parseArgs(process.argv.slice(2));
  const basePng = readPng(baseline);
  const headPng = readPng(head);
  const r = diffPngBuffers(basePng, headPng, { threshold, ignore });
  try {
    writeFileSync(out, r.diffPngBuffer);
  } catch (e) {
    fail(`cannot write diff ${out}: ${e.message}`);
  }
  process.stdout.write(JSON.stringify({
    width: r.width, height: r.height, diffPixels: r.diffPixels, totalPixels: r.totalPixels,
    mismatchRatio: Number(r.mismatchRatio.toFixed(6)), sizeMismatch: r.sizeMismatch, diffPath: out,
  }) + "\n");
}

// Run as CLI unless imported (the diffPngBuffers export is unit-tested).
if (import.meta.url === `file://${process.argv[1]}`) main();
