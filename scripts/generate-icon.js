const fs = require('fs');
const path = require('path');

const size = 1024;
const data = Buffer.alloc(size * size * 3, 255);

function setPixel(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 3;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
}

function drawCircle(cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, r, g, b);
    }
  }
}

function drawLine(x0, y0, x1, y1, width, r, g, b) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(1, Math.hypot(dx, dy));
  const step = 0.6;
  for (let t = 0; t <= len; t += step) {
    const x = x0 + (dx * t) / len;
    const y = y0 + (dy * t) / len;
    drawCircle(x, y, width / 2, r, g, b);
  }
}

function drawArc(cx, cy, radius, startDeg, endDeg, width, r, g, b) {
  const dir = startDeg <= endDeg ? 1 : -1;
  const step = 0.35 * dir;
  for (let a = startDeg; dir > 0 ? a <= endDeg : a >= endDeg; a += step) {
    const rad = (a * Math.PI) / 180;
    const x = cx + radius * Math.cos(rad);
    const y = cy + radius * Math.sin(rad);
    drawCircle(x, y, width / 2, r, g, b);
  }
}

function p(x, y) {
  return { x: (x / 24) * size, y: ((24 - y) / 24) * size };
}

const bird = { r: 246, g: 196, b: 0 };
const stroke = 82;

const a = p(3.4, 18);
const b = p(12, 18);
drawLine(a.x, a.y, b.x, b.y, stroke, bird.r, bird.g, bird.b);

drawArc(p(11.8, 10.2).x, p(11.8, 10.2).y, size * 0.33, 178, 342, stroke, bird.r, bird.g, bird.b);
drawArc(p(16.5, 9.2).x, p(16.5, 9.2).y, size * 0.15, 180, 20, stroke, bird.r, bird.g, bird.b);
drawArc(p(14.2, 13).x, p(14.2, 13).y, size * 0.13, 195, 35, stroke, bird.r, bird.g, bird.b);

let s = p(10, 10); let e = p(6, 10);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);
s = p(10, 14); e = p(4, 14);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);
s = p(10, 18); e = p(7, 18);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);

s = p(7, 10); e = p(8.09, 7.82);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);
s = p(8.09, 7.82); e = p(10, 6);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);
s = p(10, 6); e = p(10, 3);
drawLine(s.x, s.y, e.x, e.y, stroke, bird.r, bird.g, bird.b);

const eye = p(16, 7);
drawCircle(eye.x, eye.y, 24, bird.r, bird.g, bird.b);

const header = Buffer.from(`P6\n${size} ${size}\n255\n`, 'ascii');
const ppm = Buffer.concat([header, data]);
const outPpm = path.join('assets', 'icons', 'icon-1024.ppm');
fs.writeFileSync(outPpm, ppm);
console.log(`Wrote ${outPpm}`);
