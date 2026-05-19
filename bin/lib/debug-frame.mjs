// debug-frame.mjs — write a PPM (P6) preview of an RGB frame with the chosen
// face bbox + keypoints drawn on top. PPM is the simplest portable raster
// format: ascii header + raw RGB bytes. Every reasonable image viewer (and
// ffmpeg) reads it.

import { writeFileSync } from 'node:fs';

/**
 * @param {Uint8Array} rgb        Source RGB bytes (will be cloned, not mutated)
 * @param {number} width
 * @param {number} height
 * @param {Face|null} face        From face-detector (coords in DOWNSAMPLED frame coords if you call with frame coords; or scale them yourself)
 * @param {string} path
 * @param {object} [opts]
 * @param {number} [opts.sx=1]    Scale factor x — divides source-coord face.x to get frame-coord
 * @param {number} [opts.sy=1]    Scale factor y
 */
export function writeDebugPpm(rgb, width, height, face, path, opts = {}) {
  const sx = opts.sx ?? 1;
  const sy = opts.sy ?? 1;
  const buf = Buffer.from(rgb); // own copy

  if (face) {
    const fx = face.x / sx, fy = face.y / sy;
    const fw = face.w / sx, fh = face.h / sy;
    drawRect(buf, width, height, fx - fw / 2, fy - fh / 2, fw, fh, 255, 50, 50, 3);
    if (face.keypoints) {
      for (const k of Object.values(face.keypoints)) {
        drawDot(buf, width, height, k.x / sx, k.y / sy, 50, 255, 100, 3);
      }
    }
  }

  const header = Buffer.from('P6\n' + width + ' ' + height + '\n255\n', 'ascii');
  writeFileSync(path, Buffer.concat([header, buf]));
}

function plot(buf, w, h, x, y, r, g, b) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}

function drawDot(buf, w, h, cx, cy, r, g, b, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) plot(buf, w, h, cx + dx, cy + dy, r, g, b);
    }
  }
}

function drawRect(buf, w, h, x, y, rw, rh, r, g, b, thickness = 1) {
  for (let t = 0; t < thickness; t++) {
    // Top + bottom edges
    for (let i = 0; i <= rw; i++) {
      plot(buf, w, h, x + i, y + t, r, g, b);
      plot(buf, w, h, x + i, y + rh - t, r, g, b);
    }
    // Left + right edges
    for (let j = 0; j <= rh; j++) {
      plot(buf, w, h, x + t, y + j, r, g, b);
      plot(buf, w, h, x + rw - t, y + j, r, g, b);
    }
  }
}
