'use strict';
/*
 * Lightline: design holiday lights on a photo of your house.
 *
 * Rendering pipeline (all in image pixels, then scaled to fit the screen):
 *   1. Night grade   the daytime photo is converted to night in linear light:
 *                    exposure drop, desaturation, blue (scotopic) shift, darker sky.
 *   2. Light spill   each bulb adds a soft pool of its color, which is multiplied by
 *                    the daytime photo (the surface's albedo) and added back. Siding
 *                    and gutters near a strand glow; dark shingles stay dark.
 *   3. Bulbs         a halo and a hot core per bulb, blended additively.
 * Strand geometry is stored in image pixels; bulb size and spacing are stored in real
 * inches and converted with the scale (pixels per inch) the user sets on the photo.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------- catalog
  const PALETTES = {
    warm:     { label: 'Warm white',   colors: [[255, 182, 102]] },
    cool:     { label: 'Cool white',   colors: [[205, 224, 255]] },
    multi:    { label: 'Classic multi', colors: [[255, 56, 44], [48, 208, 82], [52, 112, 255], [255, 146, 28], [255, 212, 58]] },
    redgreen: { label: 'Red & green',  colors: [[255, 50, 42], [46, 204, 76]] },
    candy:    { label: 'Candy cane',   colors: [[255, 50, 42], [255, 236, 222]] },
    blue:     { label: 'Blue',         colors: [[66, 128, 255]] },
    gold:     { label: 'Gold',         colors: [[255, 156, 38]] },
    purple:   { label: 'Purple',       colors: [[168, 82, 255]] },
  };
  // diameter: visible bulb size in inches. spacing: typical spacing on store-bought sets.
  const BULBS = {
    mini: { label: 'Mini', diameter: 0.35, spacing: 4, power: 0.5 },
    c7:   { label: 'C7',   diameter: 0.85, spacing: 8, power: 0.8 },
    c9:   { label: 'C9',   diameter: 1.2,  spacing: 12, power: 1 },
  };
  const KINDS = {
    line:   { label: 'String', help: 'Tap along a roofline, gutter, railing or window frame. Finish to place the strand.' },
    icicle: { label: 'Icicle', help: 'Tap along the edge of the eave. Drops hang straight down from the line.' },
    net:    { label: 'Net',    help: 'Tap around a bush or hedge, then tap the first point again to close the shape.' },
  };
  const ICICLE_DROPS = [14, 20, 9, 17, 11, 22, 8, 16]; // inches, repeating like a real set
  const EXPORT_NAME = 'lightline-design.png';
  const MAX_SIDE = 2400; // longest side of the working image, in pixels

  // ---------------------------------------------------------------- state
  const state = {
    base: null,          // canvas holding the daytime photo
    baseData: null,      // its ImageData, for the night grade
    W: 0, H: 0,
    ppi: 1.75,           // image pixels per real inch
    scaleSource: 'sample', // 'sample' | 'estimated' | 'measured'
    scaleLine: null,     // [{x,y},{x,y}] while setting the scale
    strands: [],
    nextId: 1,
    selected: null,      // strand id
    tool: 'draw',
    draft: null,         // { points: [] } while drawing a strand
    hover: null,         // pointer position in image pixels
    night: 0.88,
    spill: 0.7,
    effect: 'steady',
    compare: false,
    split: 0.5,
    style: { kind: 'line', palette: 'warm', bulb: 'c9', spacing: 12 },
    isSample: true,
  };
  const history = { past: [], future: [] };

  const scene = $('#scene');
  const overlay = $('#overlay');
  const sctx = scene.getContext('2d');
  const octx = overlay.getContext('2d');
  const stage = $('#stage');
  const wrap = $('#wrap');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- color math
  const toLinear = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    toLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const LUT = 4096;
  const toSrgb = new Uint8ClampedArray(LUT + 1);
  for (let i = 0; i <= LUT; i++) {
    const l = i / LUT;
    toSrgb[i] = Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055));
  }

  const nightCanvas = document.createElement('canvas');
  const nctx = nightCanvas.getContext('2d');
  let nightBuiltFor = -1;

  function buildNight() {
    const m = state.night;
    const { W, H } = state;
    if (nightCanvas.width !== W || nightCanvas.height !== H) {
      nightCanvas.width = W;
      nightCanvas.height = H;
    }
    nightBuiltFor = m;
    if (m < 0.005) {
      nctx.drawImage(state.base, 0, 0);
      return;
    }
    const src = state.baseData.data;
    const out = nctx.createImageData(W, H);
    const d = out.data;
    const sat = 1 - 0.72 * m;
    const exposure = Math.pow(0.075, m);           // about -3.7 stops at full night
    const tr = 1 - 0.32 * m, tg = 1 - 0.1 * m, tb = 1 + 0.3 * m; // scotopic blue shift
    const amb = 0.0022 * m;                         // moonlight floor so shapes survive
    for (let y = 0; y < H; y++) {
      const t = 1 - y / H;
      const sky = 1 - 0.5 * m * t * t;              // the top of the frame falls off faster
      const kr = exposure * sky * tr, kg = exposure * sky * tg, kb = exposure * sky * tb;
      let i = y * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        const r = toLinear[src[i]], g = toLinear[src[i + 1]], b = toLinear[src[i + 2]];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const nr = (l + (r - l) * sat) * kr + amb * 0.55;
        const ng = (l + (g - l) * sat) * kg + amb * 0.75;
        const nb = (l + (b - l) * sat) * kb + amb * 1.3;
        d[i] = toSrgb[nr >= 1 ? LUT : (nr * LUT) | 0];
        d[i + 1] = toSrgb[ng >= 1 ? LUT : (ng * LUT) | 0];
        d[i + 2] = toSrgb[nb >= 1 ? LUT : (nb * LUT) | 0];
        d[i + 3] = 255;
      }
    }
    nctx.putImageData(out, 0, 0);
  }

  // ---------------------------------------------------------------- sprites
  const spriteCache = new Map();
  function rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
  function glowSprite(c) {
    const key = 'g' + c.join();
    let s = spriteCache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 128;
    const g = s.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, rgba(c, 1));
    gr.addColorStop(0.12, rgba(c, 0.62));
    gr.addColorStop(0.35, rgba(c, 0.22));
    gr.addColorStop(0.65, rgba(c, 0.06));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    spriteCache.set(key, s);
    return s;
  }
  function coreSprite(c) {
    const key = 'c' + c.join();
    let s = spriteCache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d');
    const hot = c.map((v) => Math.round(v + (255 - v) * 0.75));
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,250,1)');
    gr.addColorStop(0.3, rgba(hot, 1));
    gr.addColorStop(0.62, rgba(c, 0.85));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    spriteCache.set(key, s);
    return s;
  }

  // ---------------------------------------------------------------- geometry
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function polyLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  }
  // Points every `step` px along a polyline, starting at `start` px.
  function along(pts, step, start) {
    const out = [];
    if (pts.length < 2 || step <= 0) return out;
    let next = start, walked = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const seg = dist(a, b);
      while (next <= walked + seg) {
        const t = seg === 0 ? 0 : (next - walked) / seg;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        next += step;
      }
      walked += seg;
    }
    return out;
  }
  function polyArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    return Math.abs(a / 2);
  }
  function inside(p, pts) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function hash(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  // Bulb positions for a strand, cached until the strand or the scale changes.
  function bulbsFor(st) {
    const key = state.ppi + '|' + st.spacing + '|' + st.kind + '|' + JSON.stringify(st.points);
    if (st._key === key) return st._bulbs;
    const ppi = state.ppi;
    const step = Math.max(2, st.spacing * ppi);
    const n = PALETTES[st.palette].colors.length;
    const out = [];
    const push = (p, seq, ci) => out.push({ x: p.x, y: p.y, seq, c: ci % n, phase: hash(st.id * 1000 + seq) });
    const drops = [];
    if (st.kind === 'line') {
      along(st.points, step, step / 2).forEach((p, i) => push(p, i, i));
    } else if (st.kind === 'icicle') {
      const gap = Math.max(4, st.spacing) * 1.5 * ppi;
      along(st.points, gap, gap / 2).forEach((top, k) => {
        const len = ICICLE_DROPS[k % ICICLE_DROPS.length] * ppi;
        drops.push([top, { x: top.x, y: top.y + len }]);
        for (let j = 0; j * step <= len; j++) push({ x: top.x, y: top.y + j * step }, k, k + j);
      });
    } else if (st.kind === 'net' && st.points.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of st.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const rowH = step * 0.866;
      let row = 0, seq = 0;
      for (let y = minY + rowH / 2; y < maxY; y += rowH, row++) {
        const off = row % 2 ? step / 2 : 0;
        let col = 0;
        for (let x = minX + off + step / 4; x < maxX; x += step, col++) {
          const p = { x, y };
          if (inside(p, st.points)) push(p, seq++, row + col);
        }
      }
    }
    st._key = key;
    st._bulbs = out;
    st._drops = drops;
    return out;
  }

  function strandStats(st) {
    const bulbs = bulbsFor(st).length;
    if (st.kind === 'net') {
      const sqft = polyArea(st.points) / (state.ppi * state.ppi) / 144;
      return { bulbs, sqft, feet: 0 };
    }
    return { bulbs, feet: polyLength(st.points) / state.ppi / 12, sqft: 0 };
  }

  // ---------------------------------------------------------------- rendering
  const spillCanvas = document.createElement('canvas');
  const spctx = spillCanvas.getContext('2d');
  const SPILL_SCALE = 0.25;

  function intensity(b, t) {
    switch (state.effect) {
      case 'twinkle': {
        const s = 0.5 + 0.5 * Math.sin(t * (1.1 + b.phase * 2.2) + b.phase * 40);
        return 0.3 + 0.7 * s * s;
      }
      case 'chase': return ((b.seq - Math.floor(t * 4)) % 3 + 3) % 3 === 0 ? 1 : 0.18;
      case 'fade': return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.4 - b.c * 2.1));
      default: return 1;
    }
  }

  // Draws the lit scene into ctx at full image resolution.
  function renderScene(ctx, t, withCompare) {
    const { W, H, ppi } = state;
    if (nightBuiltFor !== state.night) buildNight();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(nightCanvas, 0, 0);

    const nightF = 0.25 + 0.75 * state.night;
    const strands = state.strands.slice();
    if (state.draft && state.draft.points.length >= 2 && state.draft.kind !== 'net') strands.push(state.draft);

    // 1. Wires, faint and dark, as they read in a real photo.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(14, 26, 18, 0.6)';
    ctx.lineWidth = Math.max(1, 0.2 * ppi);
    for (const st of strands) {
      if (st.kind === 'net') continue;
      bulbsFor(st);
      ctx.beginPath();
      st.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (st.kind === 'icicle') for (const [a, b] of st._drops) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    }

    // 2. Spill: colored light pools x surface albedo, added on top.
    const sw = Math.max(1, Math.round(W * SPILL_SCALE)), sh = Math.max(1, Math.round(H * SPILL_SCALE));
    if (spillCanvas.width !== sw || spillCanvas.height !== sh) { spillCanvas.width = sw; spillCanvas.height = sh; }
    if (state.spill > 0) {
      spctx.globalCompositeOperation = 'source-over';
      spctx.globalAlpha = 1;
      spctx.fillStyle = '#000';
      spctx.fillRect(0, 0, sw, sh);
      spctx.globalCompositeOperation = 'lighter';
      for (const st of strands) {
        const bulb = BULBS[st.bulb];
        const colors = PALETTES[st.palette].colors;
        const r = Math.max(4, 42 * ppi * SPILL_SCALE * (0.6 + 0.4 * bulb.power));
        const base = 0.2 * bulb.power * state.spill * nightF * Math.min(1.6, Math.sqrt(st.spacing / bulb.spacing));
        for (const b of bulbsFor(st)) {
          spctx.globalAlpha = Math.min(1, base * intensity(b, t));
          spctx.drawImage(glowSprite(colors[b.c]), b.x * SPILL_SCALE - r, b.y * SPILL_SCALE - r, r * 2, r * 2);
        }
      }
      spctx.globalAlpha = 1;
      spctx.globalCompositeOperation = 'multiply';
      spctx.drawImage(state.base, 0, 0, sw, sh);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(spillCanvas, 0, 0, W, H);
    }

    // 3. Bulbs: halo, then hot core.
    ctx.globalCompositeOperation = 'lighter';
    for (const st of strands) {
      const bulb = BULBS[st.bulb];
      const colors = PALETTES[st.palette].colors;
      const rCore = Math.max(1.6, bulb.diameter * 0.9 * ppi);
      const rHalo = Math.max(7, bulb.diameter * 9 * ppi);
      const haloA = (0.4 + 0.35 * bulb.power) * nightF;
      const coreA = 0.55 + 0.45 * nightF;
      for (const b of bulbsFor(st)) {
        const k = intensity(b, t);
        const c = colors[b.c];
        ctx.globalAlpha = Math.min(1, haloA * k);
        ctx.drawImage(glowSprite(c), b.x - rHalo, b.y - rHalo, rHalo * 2, rHalo * 2);
        ctx.globalAlpha = Math.min(1, coreA * (0.35 + 0.65 * k));
        ctx.drawImage(coreSprite(c), b.x - rCore, b.y - rCore, rCore * 2, rCore * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (withCompare && state.compare) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W * state.split, H);
      ctx.clip();
      ctx.drawImage(state.base, 0, 0);
      ctx.restore();
    }
  }

  // Overlay: everything that is UI, never part of the saved image.
  function cssToImage() { return state.W / wrap.clientWidth || 1; }
  function renderOverlay() {
    const { W, H } = state;
    const k = cssToImage();
    octx.clearRect(0, 0, W, H);
    octx.lineCap = 'round';
    octx.lineJoin = 'round';

    const pathOf = (pts, closed) => {
      octx.beginPath();
      pts.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
      if (closed) octx.closePath();
    };
    const handle = (p, r, fill) => {
      octx.beginPath();
      octx.arc(p.x, p.y, r, 0, Math.PI * 2);
      octx.fillStyle = fill;
      octx.fill();
      octx.lineWidth = 1.5 * k;
      octx.strokeStyle = 'rgba(13,18,23,.9)';
      octx.stroke();
    };

    if (state.tool === 'edit') {
      for (const st of state.strands) {
        const sel = st.id === state.selected;
        if (!sel && st.id !== hoverStrand) continue;
        pathOf(st.points, st.kind === 'net');
        octx.setLineDash(sel ? [] : [6 * k, 5 * k]);
        octx.lineWidth = 2 * k;
        octx.strokeStyle = sel ? 'rgba(244,180,92,.95)' : 'rgba(235,230,220,.7)';
        octx.stroke();
        octx.setLineDash([]);
        if (sel) st.points.forEach((p) => handle(p, 6 * k, '#ebe6dc'));
      }
    }

    if (state.tool === 'draw' && state.draft) {
      const pts = state.draft.points;
      const live = state.hover ? pts.concat([state.hover]) : pts;
      pathOf(live, false);
      octx.setLineDash([7 * k, 6 * k]);
      octx.lineWidth = 2 * k;
      octx.strokeStyle = 'rgba(244,180,92,.95)';
      octx.stroke();
      octx.setLineDash([]);
      if (state.draft.kind === 'net' && pts.length >= 3) {
        const closing = state.hover && dist(state.hover, pts[0]) < 14 * k;
        handle(pts[0], (closing ? 9 : 7) * k, closing ? '#f4b45c' : '#ebe6dc');
      }
      pts.forEach((p, i) => i && handle(p, 5 * k, '#ebe6dc'));
      if (pts.length && state.draft.kind !== 'net') handle(pts[0], 5 * k, '#ebe6dc');
    }

    if (state.scaleLine && state.tool === 'scale') {
      const [a, b] = state.scaleLine;
      const end = b || state.hover;
      if (end) {
        octx.lineWidth = 2 * k;
        octx.strokeStyle = '#7fd3ff';
        octx.beginPath();
        octx.moveTo(a.x, a.y);
        octx.lineTo(end.x, end.y);
        octx.stroke();
        const ang = Math.atan2(end.y - a.y, end.x - a.x) + Math.PI / 2;
        for (const p of [a, end]) {
          octx.beginPath();
          octx.moveTo(p.x - Math.cos(ang) * 8 * k, p.y - Math.sin(ang) * 8 * k);
          octx.lineTo(p.x + Math.cos(ang) * 8 * k, p.y + Math.sin(ang) * 8 * k);
          octx.stroke();
        }
      }
    }

    if (state.compare) {
      const x = W * state.split;
      octx.fillStyle = 'rgba(235,230,220,.95)';
      octx.fillRect(x - 1 * k, 0, 2 * k, H);
      handle({ x, y: H / 2 }, 14 * k, '#ebe6dc');
      octx.fillStyle = '#0d1217';
      octx.beginPath();
      octx.moveTo(x - 9 * k, H / 2); octx.lineTo(x - 3 * k, H / 2 - 5 * k); octx.lineTo(x - 3 * k, H / 2 + 5 * k);
      octx.moveTo(x + 9 * k, H / 2); octx.lineTo(x + 3 * k, H / 2 - 5 * k); octx.lineTo(x + 3 * k, H / 2 + 5 * k);
      octx.fill();
      const label = (txt, lx, align) => {
        octx.font = `600 ${13 * k}px "Instrument Sans", system-ui, sans-serif`;
        octx.textAlign = align;
        octx.textBaseline = 'top';
        const w = octx.measureText(txt).width + 16 * k;
        const bx = align === 'left' ? lx : lx - w;
        octx.fillStyle = 'rgba(13,18,23,.72)';
        octx.fillRect(bx, 12 * k, w, 24 * k);
        octx.fillStyle = '#ebe6dc';
        octx.fillText(txt, align === 'left' ? lx + 8 * k : lx - 8 * k, 17 * k);
      };
      if (x > 90 * k) label('Before', x - 12 * k, 'right');
      if (W - x > 90 * k) label('After', x + 12 * k, 'left');
    }
  }

  let raf = 0;
  let sceneDirty = true;
  function requestRender(sceneToo = true) {
    if (sceneToo) sceneDirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (!state.base) return;
    const animated = state.effect !== 'steady' && !reducedMotion;
    if (sceneDirty || animated) {
      renderScene(sctx, now / 1000, true);
      sceneDirty = false;
    }
    renderOverlay();
    if (animated) raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- layout
  function fit() {
    if (!state.W) return;
    if (narrow.matches) {
      // Stacked layout: size the stage to the photo instead of leaving bars above and below.
      const h = Math.round(Math.min(stage.clientWidth * state.H / state.W, window.innerHeight * 0.7));
      if (Math.abs(stage.clientHeight - h) > 1) stage.style.height = h + 'px';
    } else if (stage.style.height) {
      stage.style.height = '';
    }
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const s = Math.min(sw / state.W, sh / state.H);
    wrap.style.width = Math.floor(state.W * s) + 'px';
    wrap.style.height = Math.floor(state.H * s) + 'px';
    requestRender(false);
  }
  const narrow = window.matchMedia('(max-width: 860px)');
  new ResizeObserver(fit).observe(stage);
  narrow.addEventListener('change', fit);

  // ---------------------------------------------------------------- image loading
  function setBase(source, w, h) {
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const W = Math.round(w * s), H = Math.round(h * s);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, W, H);
    state.base = c;
    state.baseData = g.getImageData(0, 0, W, H);
    state.W = W;
    state.H = H;
    for (const cv of [scene, overlay]) { cv.width = W; cv.height = H; }
    nightBuiltFor = -1;
    fit();
    requestRender();
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast('That file isn’t an image. Choose a JPG, PNG or HEIC photo of your house.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      checkpoint();
      state.strands = [];
      state.selected = null;
      state.draft = null;
      state.scaleLine = null;
      state.isSample = false;
      setBase(img, img.naturalWidth, img.naturalHeight);
      // Until the user measures something, assume the frame spans about 50 ft of house.
      state.ppi = state.W / (50 * 12);
      state.scaleSource = 'estimated';
      setTool('draw');
      syncUI();
      toast('Photo loaded. Tap along your roofline to add the first strand.');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('This browser can’t open that photo. Try saving it as a JPG first.');
    };
    img.src = url;
  }

  // ---------------------------------------------------------------- sample house
  function drawSampleHouse() {
    const W = 1600, H = 1000;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');

    let gr = g.createLinearGradient(0, 0, 0, 640);
    gr.addColorStop(0, '#86aecf');
    gr.addColorStop(1, '#d3e2ea');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, 660);

    // Tree line behind the house
    g.fillStyle = '#5f7a5a';
    for (let x = -40; x < W + 40; x += 46) {
      const r = 42 + 28 * hash(x);
      g.beginPath();
      g.arc(x, 610 - 40 * hash(x + 7), r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillRect(0, 600, W, 60);

    gr = g.createLinearGradient(0, 640, 0, H);
    gr.addColorStop(0, '#78985a');
    gr.addColorStop(1, '#4f6d37');
    g.fillStyle = gr;
    g.fillRect(0, 640, W, H - 640);

    // Chimney (behind the roof surface)
    g.fillStyle = '#8b4a3a';
    g.fillRect(1030, 140, 62, 120);
    g.strokeStyle = 'rgba(40,20,15,.35)';
    g.lineWidth = 1.5;
    for (let y = 150; y < 260; y += 12) { g.beginPath(); g.moveTo(1030, y); g.lineTo(1092, y); g.stroke(); }
    g.fillStyle = '#6e7278';
    g.fillRect(1024, 132, 74, 12);

    // Wall with lap siding
    g.fillStyle = '#ddd4c2';
    g.fillRect(300, 384, 1000, 322);
    g.strokeStyle = 'rgba(90,78,58,.2)';
    g.lineWidth = 1.5;
    for (let y = 396; y < 706; y += 13) { g.beginPath(); g.moveTo(300, y); g.lineTo(1300, y); g.stroke(); }
    gr = g.createLinearGradient(0, 384, 0, 430);
    gr.addColorStop(0, 'rgba(0,0,0,.28)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(300, 384, 1000, 46);

    // Side-gable roof, seen as a trapezoid of shingles
    const roof = new Path2D();
    roof.moveTo(262, 388); roof.lineTo(430, 196); roof.lineTo(1170, 196); roof.lineTo(1338, 388); roof.closePath();
    g.fillStyle = '#4a4f58';
    g.fill(roof);
    g.save();
    g.clip(roof);
    for (let y = 206, row = 0; y < 390; y += 13, row++) {
      g.strokeStyle = 'rgba(0,0,0,.28)';
      g.beginPath(); g.moveTo(200, y); g.lineTo(1400, y); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.16)';
      for (let x = 200 + (row % 2) * 17; x < 1400; x += 34) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 13); g.stroke(); }
    }
    g.fillStyle = 'rgba(255,255,255,.05)';
    g.fillRect(0, 196, W, 60);
    g.restore();
    g.strokeStyle = '#efebe3';
    g.lineWidth = 9;
    g.beginPath(); g.moveTo(262, 388); g.lineTo(430, 196); g.lineTo(1170, 196); g.lineTo(1338, 388); g.stroke();
    g.fillStyle = '#efebe3';
    g.fillRect(258, 382, 1084, 12); // fascia board along the eave

    // Windows with shutters
    const windowAt = (x, y, w, h) => {
      g.fillStyle = '#2f4a3c';
      g.fillRect(x - 40, y, 32, h);
      g.fillRect(x + w + 8, y, 32, h);
      g.strokeStyle = 'rgba(0,0,0,.25)';
      g.lineWidth = 1;
      for (let yy = y + 8; yy < y + h; yy += 8) {
        g.beginPath(); g.moveTo(x - 36, yy); g.lineTo(x - 12, yy); g.moveTo(x + w + 12, yy); g.lineTo(x + w + 36, yy); g.stroke();
      }
      g.fillStyle = '#f3f0e9';
      g.fillRect(x - 6, y - 6, w + 12, h + 12);
      const glass = g.createLinearGradient(x, y, x + w, y + h);
      glass.addColorStop(0, '#5d7486');
      glass.addColorStop(0.5, '#33495a');
      glass.addColorStop(1, '#283a48');
      g.fillStyle = glass;
      g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.moveTo(x, y + h * 0.7); g.lineTo(x + w * 0.45, y); g.lineTo(x + w * 0.65, y); g.lineTo(x, y + h); g.fill();
      g.fillStyle = '#f3f0e9';
      g.fillRect(x + w / 2 - 3, y, 6, h);
      g.fillRect(x, y + h / 2 - 3, w, 6);
      g.fillRect(x - 10, y + h + 4, w + 20, 8);
    };
    windowAt(392, 470, 140, 132);
    windowAt(1068, 470, 140, 132);

    // Front porch: floor, recess, door, columns, gable
    g.fillStyle = 'rgba(0,0,0,.14)';
    g.fillRect(650, 470, 300, 232);
    g.fillStyle = '#6b2b2a'; // door, 36 x 80 in at 1.75 px/in
    g.fillRect(768, 560, 63, 140);
    g.strokeStyle = 'rgba(0,0,0,.3)';
    g.lineWidth = 2;
    g.strokeRect(776, 572, 21, 50); g.strokeRect(802, 572, 21, 50);
    g.strokeRect(776, 632, 21, 56); g.strokeRect(802, 632, 21, 56);
    g.fillStyle = '#d9b45b';
    g.beginPath(); g.arc(822, 632, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f3f0e9';
    g.fillRect(760, 552, 79, 8); g.fillRect(760, 552, 8, 148); g.fillRect(831, 552, 8, 148);
    g.fillStyle = '#2b2b2b';
    g.fillRect(858, 590, 10, 18);
    g.fillStyle = '#e8d9a8';
    g.fillRect(860, 594, 6, 10);
    g.fillStyle = '#a69e8f';
    g.fillRect(634, 700, 332, 16);
    g.fillStyle = '#958d7e';
    g.fillRect(700, 716, 200, 12);
    g.fillRect(690, 728, 220, 12);
    for (const x of [664, 918]) {
      g.fillStyle = '#f4f1ea';
      g.fillRect(x, 474, 18, 228);
      g.fillStyle = 'rgba(0,0,0,.12)';
      g.fillRect(x + 12, 474, 6, 228);
    }
    const ped = new Path2D();
    ped.moveTo(636, 476); ped.lineTo(800, 360); ped.lineTo(964, 476); ped.closePath();
    g.fillStyle = '#e4dccb';
    g.fill(ped);
    g.save();
    g.clip(ped);
    g.strokeStyle = 'rgba(90,78,58,.2)';
    g.lineWidth = 1.5;
    for (let y = 372; y < 476; y += 13) { g.beginPath(); g.moveTo(620, y); g.lineTo(980, y); g.stroke(); }
    g.restore();
    g.strokeStyle = '#f3f0e9';
    g.lineWidth = 10;
    g.beginPath(); g.moveTo(626, 482); g.lineTo(800, 358); g.lineTo(974, 482); g.stroke();
    g.fillStyle = '#f3f0e9';
    g.fillRect(630, 470, 340, 12);
    g.fillStyle = '#4a4f58';
    g.beginPath(); g.moveTo(780, 432); g.lineTo(800, 418); g.lineTo(820, 432); g.closePath(); g.fill();

    // Foundation and walkway
    g.fillStyle = '#9b968c';
    g.fillRect(300, 704, 334, 14);
    g.fillRect(966, 704, 334, 14);
    g.fillStyle = '#b8b0a1';
    g.beginPath(); g.moveTo(712, 740); g.lineTo(888, 740); g.lineTo(980, H); g.lineTo(620, H); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.12)';
    for (let y = 790; y < H; y += 60) { g.beginPath(); g.moveTo(600, y); g.lineTo(1000, y); g.stroke(); }

    // Shrubs
    const shrubs = (cx0, cx1) => {
      for (let x = cx0; x <= cx1; x += 34) {
        const r = 34 + 14 * hash(x * 3.1);
        const y = 690 - 18 * hash(x * 1.7);
        g.fillStyle = '#2e4a2a';
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(140,180,110,.18)';
        g.beginPath(); g.arc(x - r * 0.3, y - r * 0.35, r * 0.55, 0, Math.PI * 2); g.fill();
      }
    };
    shrubs(340, 600);
    shrubs(1000, 1262);
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(300, 716, 1000, 10);
    return c;
  }

  function loadSample() {
    setBase(drawSampleHouse(), 1600, 1000);
    state.ppi = 1.75; // the door is 80 in tall and 140 px in the drawing
    state.scaleSource = 'sample';
    state.isSample = true;
    const mk = (name, kind, palette, bulb, spacing, points) =>
      ({ id: state.nextId++, name, kind, palette, bulb, spacing, points });
    state.strands = [
      mk('Roof outline', 'line', 'warm', 'c9', 12, [{ x: 262, y: 386 }, { x: 430, y: 194 }, { x: 1170, y: 194 }, { x: 1338, y: 386 }]),
      mk('Left eave', 'icicle', 'cool', 'mini', 4, [{ x: 266, y: 392 }, { x: 628, y: 392 }]),
      mk('Right eave', 'icicle', 'cool', 'mini', 4, [{ x: 972, y: 392 }, { x: 1334, y: 392 }]),
      mk('Porch gable', 'line', 'multi', 'c7', 8, [{ x: 626, y: 480 }, { x: 800, y: 356 }, { x: 974, y: 480 }]),
      mk('Left shrubs', 'net', 'multi', 'mini', 4, [{ x: 300, y: 716 }, { x: 306, y: 672 }, { x: 350, y: 640 }, { x: 440, y: 630 }, { x: 540, y: 634 }, { x: 610, y: 652 }, { x: 636, y: 690 }, { x: 630, y: 716 }]),
      mk('Right shrubs', 'net', 'multi', 'mini', 4, [{ x: 962, y: 716 }, { x: 966, y: 676 }, { x: 1010, y: 640 }, { x: 1100, y: 630 }, { x: 1200, y: 634 }, { x: 1272, y: 652 }, { x: 1298, y: 690 }, { x: 1296, y: 716 }]),
    ];
  }

  // ---------------------------------------------------------------- history
  function snapshot() {
    return JSON.stringify({
      strands: state.strands.map(({ _key, _bulbs, _drops, ...s }) => s),
      ppi: state.ppi,
      scaleSource: state.scaleSource,
      nextId: state.nextId,
    });
  }
  function restore(snap) {
    const s = JSON.parse(snap);
    state.strands = s.strands;
    state.ppi = s.ppi;
    state.scaleSource = s.scaleSource;
    state.nextId = s.nextId;
    if (!state.strands.some((st) => st.id === state.selected)) state.selected = null;
  }
  function checkpoint() {
    history.past.push(snapshot());
    if (history.past.length > 100) history.past.shift();
    history.future.length = 0;
  }
  function undo() {
    if (state.draft) { cancelDraft(); return; }
    if (!history.past.length) return;
    history.future.push(snapshot());
    restore(history.past.pop());
    syncUI();
    requestRender();
  }
  function redo() {
    if (!history.future.length) return;
    history.past.push(snapshot());
    restore(history.future.pop());
    syncUI();
    requestRender();
  }

  // ---------------------------------------------------------------- strand editing
  const selectedStrand = () => state.strands.find((s) => s.id === state.selected) || null;

  function startDraft(p) {
    state.draft = { id: -1, name: '', ...state.style, points: [p] };
  }
  function finishDraft() {
    const d = state.draft;
    if (!d) return;
    const pts = d.points;
    const ok = d.kind === 'net' ? pts.length >= 3 : pts.length >= 2 && polyLength(pts) > 4;
    if (!ok) {
      toast(d.kind === 'net' ? 'A net needs at least three points around the bush.' : 'Tap at least two points to make a strand.');
      return;
    }
    checkpoint();
    const n = state.strands.filter((s) => s.kind === d.kind).length + 1;
    state.strands.push({ ...d, id: state.nextId++, name: `${KINDS[d.kind].label} ${n}` });
    state.draft = null;
    syncUI();
    requestRender();
  }
  function cancelDraft() {
    state.draft = null;
    syncUI();
    requestRender();
  }

  function applyStyle(patch) {
    Object.assign(state.style, patch);
    const st = selectedStrand();
    if (st) {
      checkpoint();
      Object.assign(st, patch);
      if (patch.kind === 'net' && st.points.length < 3) st.kind = 'line';
    }
    if (state.draft) Object.assign(state.draft, patch);
    syncUI();
    requestRender();
  }

  function deleteSelected() {
    const st = selectedStrand();
    if (!st) return;
    checkpoint();
    state.strands = state.strands.filter((s) => s !== st);
    state.selected = null;
    syncUI();
    requestRender();
    toast(`Deleted “${st.name}”. Press Undo to bring it back.`);
  }

  function select(id) {
    state.selected = id;
    const st = selectedStrand();
    if (st) state.style = { kind: st.kind, palette: st.palette, bulb: st.bulb, spacing: st.spacing };
    syncUI();
    requestRender(false);
  }

  function setTool(tool) {
    if (state.draft && tool !== 'draw') finishOrDropDraft();
    state.tool = tool;
    if (tool !== 'scale') state.scaleLine = null;
    if (tool === 'draw') state.selected = null;
    stage.dataset.tool = tool;
    syncUI();
    requestRender(false);
  }
  function finishOrDropDraft() {
    const d = state.draft;
    if (d && (d.kind === 'net' ? d.points.length >= 3 : d.points.length >= 2)) finishDraft();
    else state.draft = null;
  }

  // ---------------------------------------------------------------- pointer input
  let drag = null;
  let hoverStrand = null;

  function toImage(e) {
    const r = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(state.W, ((e.clientX - r.left) / r.width) * state.W)),
      y: Math.max(0, Math.min(state.H, ((e.clientY - r.top) / r.height) * state.H)),
    };
  }
  // Shift snaps the new segment to horizontal, vertical or 45 degrees.
  function snap(p, from, e) {
    if (!e.shiftKey || !from) return p;
    const dx = p.x - from.x, dy = p.y - from.y;
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const L = Math.hypot(dx, dy);
    return { x: from.x + Math.cos(a) * L, y: from.y + Math.sin(a) * L };
  }
  function strandAt(p) {
    const tol = 10 * cssToImage();
    let best = null, bestD = tol;
    for (const st of state.strands) {
      const pts = st.kind === 'net' ? st.points.concat([st.points[0]]) : st.points;
      if (st.kind === 'net' && inside(p, st.points)) return st;
      for (let i = 1; i < pts.length; i++) {
        const d = segDist(p, pts[i - 1], pts[i]);
        if (d < bestD) { bestD = d; best = st; }
      }
      if (st.kind === 'icicle') {
        bulbsFor(st);
        for (const [a, b] of st._drops) {
          const d = segDist(p, a, b);
          if (d < bestD) { bestD = d; best = st; }
        }
      }
    }
    return best;
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = toImage(e);
    const k = cssToImage();

    if (state.compare && Math.abs(p.x - state.W * state.split) < 18 * k) {
      drag = { type: 'split' };
      overlay.setPointerCapture(e.pointerId);
      return;
    }

    if (state.tool === 'draw') {
      if (!state.draft) {
        startDraft(p);
      } else {
        const pts = state.draft.points;
        if (state.draft.kind === 'net' && pts.length >= 3 && dist(p, pts[0]) < 14 * k) {
          finishDraft();
          return;
        }
        const q = snap(p, pts[pts.length - 1], e);
        if (dist(q, pts[pts.length - 1]) > 3 * k) pts.push(q);
      }
      syncUI();
      requestRender();
    } else if (state.tool === 'edit') {
      const st = selectedStrand();
      if (st) {
        const idx = st.points.findIndex((q) => dist(q, p) < 10 * k);
        if (idx >= 0) {
          checkpoint();
          drag = { type: 'point', st, idx, moved: false };
          overlay.setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = strandAt(p);
      if (hit) {
        select(hit.id);
        checkpoint();
        drag = { type: 'strand', st: hit, last: p, moved: false };
        overlay.setPointerCapture(e.pointerId);
      } else {
        select(null);
      }
    } else if (state.tool === 'scale') {
      if (!state.scaleLine || state.scaleLine[1]) state.scaleLine = [p];
      else state.scaleLine = [state.scaleLine[0], snap(p, state.scaleLine[0], e)];
      syncUI();
      requestRender(false);
      if (state.scaleLine[1]) $('#scaleFt').focus();
    }
  });

  overlay.addEventListener('pointermove', (e) => {
    const p = toImage(e);
    if (drag) {
      if (drag.type === 'split') {
        state.split = Math.max(0, Math.min(1, p.x / state.W));
        requestRender();
      } else if (drag.type === 'point') {
        drag.st.points[drag.idx] = p;
        drag.moved = true;
        requestRender();
      } else if (drag.type === 'strand') {
        const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
        drag.st.points = drag.st.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
        drag.last = p;
        drag.moved = true;
        requestRender();
      }
      return;
    }
    const last = state.draft && state.draft.points[state.draft.points.length - 1];
    state.hover = state.tool === 'scale' && state.scaleLine && !state.scaleLine[1] ? snap(p, state.scaleLine[0], e) : snap(p, last, e);
    if (state.tool === 'edit') {
      const h = strandAt(p);
      const id = h ? h.id : null;
      if (id !== hoverStrand) { hoverStrand = id; overlay.style.cursor = h ? 'move' : ''; }
      const st = selectedStrand();
      if (st && st.points.some((q) => dist(q, p) < 10 * cssToImage())) overlay.style.cursor = 'grab';
    }
    requestRender(state.tool === 'draw' && !!state.draft);
  });

  const endDrag = () => {
    if (drag && (drag.type === 'point' || drag.type === 'strand') && !drag.moved) history.past.pop();
    if (drag && drag.moved) syncUI();
    drag = null;
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('pointerleave', () => {
    state.hover = null;
    hoverStrand = null;
    requestRender(false);
  });

  overlay.addEventListener('dblclick', (e) => {
    const p = toImage(e);
    const k = cssToImage();
    if (state.tool === 'draw' && state.draft) {
      // The second click of a double-click already added a point at the same spot.
      const pts = state.draft.points;
      if (pts.length >= 2 && dist(pts[pts.length - 1], pts[pts.length - 2]) < 8 * k) pts.pop();
      finishDraft();
    } else if (state.tool === 'edit') {
      const st = selectedStrand();
      if (!st) return;
      const idx = st.points.findIndex((q) => dist(q, p) < 10 * k);
      const min = st.kind === 'net' ? 3 : 2;
      if (idx >= 0 && st.points.length > min) {
        checkpoint();
        st.points.splice(idx, 1);
      } else if (idx < 0) {
        const pts = st.kind === 'net' ? st.points.concat([st.points[0]]) : st.points;
        for (let i = 1; i < pts.length; i++) {
          if (segDist(p, pts[i - 1], pts[i]) < 10 * k) {
            checkpoint();
            st.points.splice(i, 0, p);
            break;
          }
        }
      }
      syncUI();
      requestRender();
    }
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (typing || mod || e.altKey) return;
    switch (e.key) {
      case 'd': case 'D': setTool('draw'); break;
      case 'v': case 'V': setTool('edit'); break;
      case 's': case 'S': setTool('scale'); break;
      case 'Enter': if (state.draft) { e.preventDefault(); finishDraft(); } break;
      case 'Escape':
        if (state.draft) cancelDraft();
        else if (state.selected) select(null);
        else if (state.scaleLine) { state.scaleLine = null; syncUI(); requestRender(false); }
        break;
      case 'Delete': case 'Backspace':
        if (state.draft) {
          e.preventDefault();
          state.draft.points.pop();
          if (!state.draft.points.length) state.draft = null;
          syncUI();
          requestRender();
        } else if (state.selected) {
          e.preventDefault();
          deleteSelected();
        }
        break;
    }
  });

  // ---------------------------------------------------------------- panel UI
  const fmtFt = (ft) => (ft >= 10 ? Math.round(ft) : ft.toFixed(1)) + ' ft';
  function dots(palette) {
    return '<span class="swatch-dots">' +
      PALETTES[palette].colors.map((c) => `<i style="background:${rgba(c, 1)};box-shadow:0 0 6px ${rgba(c, 0.8)}"></i>`).join('') +
      '</span>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  $('#palette').innerHTML = Object.entries(PALETTES).map(([key, p]) =>
    `<button type="button" class="swatch" data-palette="${key}" aria-pressed="false">${dots(key)}<span>${p.label}</span></button>`).join('');

  const press = (root, attr, value) =>
    root.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));

  function syncUI() {
    const st = selectedStrand();
    const s = state.style;
    press($('#tools'), 'tool', state.tool);
    press($('#kind'), 'kind', s.kind);
    press($('#palette'), 'palette', s.palette);
    press($('#bulb'), 'bulb', s.bulb);
    press($('#effect'), 'effect', state.effect);
    $('#kindHelp').textContent = KINDS[s.kind].help;
    $('#spacing').value = s.spacing;
    $('#spacingOut').textContent = s.spacing + ' in';
    $('#lightsHeading').textContent = st ? `Editing: ${st.name}` : 'Next strand';
    $('#deleteStrand').hidden = !st;
    $('#deselect').hidden = !st;
    $('#undo').disabled = !history.past.length && !state.draft;
    $('#redo').disabled = !history.future.length;
    $('#compare').setAttribute('aria-pressed', String(state.compare));
    $('#sampleNote').hidden = !state.isSample;

    const nightPct = Math.round(state.night * 100);
    $('#night').value = nightPct;
    $('#nightOut').textContent = nightPct < 20 ? 'Day' : nightPct < 65 ? 'Dusk' : 'Night';
    $('#spill').value = Math.round(state.spill * 100);
    $('#spillOut').textContent = Math.round(state.spill * 100) + '%';

    // Hint bar and draft buttons
    const d = state.draft;
    $('#finish').hidden = !d;
    $('#cancel').hidden = !d && !(state.tool === 'scale' && state.scaleLine);
    let hint = '';
    if (state.tool === 'draw') {
      if (!d) hint = `<strong>Add lights:</strong> ${KINDS[s.kind].help}`;
      else if (d.kind === 'net') hint = d.points.length < 3 ? 'Keep tapping around the shape.' : '<strong>Tap the first point</strong> to close the net, or press Finish.';
      else hint = d.points.length < 2 ? 'Tap the next point along the edge. Hold Shift to keep the line straight.' : '<strong>Double-click, press Enter or tap Finish</strong> to place the strand.';
    } else if (state.tool === 'edit') {
      hint = st ? 'Drag a dot to reshape the strand. Double-click a line to add a point, or a dot to remove it.' : 'Tap a strand to select it. Drag to move it.';
    } else if (state.tool === 'scale') {
      hint = !state.scaleLine ? '<strong>Set scale:</strong> tap both ends of something you know the size of. A front door is usually 6 ft 8 in tall.'
        : !state.scaleLine[1] ? 'Now tap the other end.' : 'Enter its real length on the right, then press Apply.';
    }
    $('#hint').innerHTML = hint;

    // Strand list
    const list = $('#strandList');
    list.innerHTML = state.strands.map((x) => {
      const stats = strandStats(x);
      const qty = x.kind === 'net' ? `${Math.round(stats.sqft)} sq ft` : fmtFt(stats.feet);
      return `<li><button type="button" class="strand-row" data-id="${x.id}" aria-current="${x.id === state.selected}">
        ${dots(x.palette)}
        <span><span class="strand-name">${esc(x.name)}</span><span class="strand-meta">${BULBS[x.bulb].label} ${KINDS[x.kind].label.toLowerCase()} · ${PALETTES[x.palette].label.toLowerCase()}</span></span>
        <span class="strand-qty">${qty}<span class="strand-meta">${stats.bulbs} bulbs</span></span>
      </button></li>`;
    }).join('');
    $('#strandEmpty').hidden = state.strands.length > 0;
    $('#clearAll').hidden = state.strands.length === 0;
    renderTotals();

    // Scale
    const ftPerFrame = state.W / state.ppi / 12;
    $('#scaleStatus').innerHTML =
      state.scaleSource === 'measured' ? `Measured from your photo. The picture is about <strong>${Math.round(ftPerFrame)} ft</strong> wide.`
      : state.scaleSource === 'sample' ? 'Set from the sample house’s front door (6 ft 8 in).'
      : `Estimated: the picture is assumed to be about ${Math.round(ftPerFrame)} ft wide. Use <strong>Set scale</strong> on your front door for accurate bulb sizes and lengths.`;
    $('#scaleForm').hidden = !(state.tool === 'scale' && state.scaleLine && state.scaleLine[1]);
  }

  function renderTotals() {
    const groups = new Map();
    for (const st of state.strands) {
      const key = [st.kind, st.bulb, st.palette].join('|');
      const g = groups.get(key) || { st, feet: 0, sqft: 0, bulbs: 0 };
      const s = strandStats(st);
      g.feet += s.feet; g.sqft += s.sqft; g.bulbs += s.bulbs;
      groups.set(key, g);
    }
    if (!groups.size) { $('#totals').innerHTML = ''; return; }
    let rows = '';
    for (const g of groups.values()) {
      const { st } = g;
      const what = `${PALETTES[st.palette].label} ${BULBS[st.bulb].label} ${st.kind === 'line' ? 'string' : st.kind === 'icicle' ? 'icicle' : 'net'}`;
      // Buy 10% extra on runs for slack and the trip to the outlet. Nets are sold 4 x 6 ft.
      const buy = st.kind === 'net' ? `${Math.max(1, Math.ceil(g.sqft / 24))} × 4×6 ft` : `${Math.ceil(g.feet * 1.1)} ft`;
      rows += `<tr><td>${esc(what)}</td><td class="num">${g.bulbs}</td><td class="num">${buy}</td></tr>`;
    }
    $('#totals').innerHTML = `<table><thead><tr><th>Shopping list</th><th>Bulbs</th><th>Buy</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="foot">Lengths include 10% extra for slack and runs to the outlet.${state.scaleSource === 'estimated' ? ' Set the scale for accurate numbers.' : ''}</p>`;
  }

  // Panel events
  $('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
  $('#kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const st = selectedStrand();
    if (st && b.dataset.kind === 'net' && st.points.length < 3) { toast('A net needs at least three points. Draw a new shape around the bush.'); return; }
    applyStyle({ kind: b.dataset.kind });
  });
  $('#palette').addEventListener('click', (e) => { const b = e.target.closest('[data-palette]'); if (b) applyStyle({ palette: b.dataset.palette }); });
  $('#bulb').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulb]');
    if (b) applyStyle({ bulb: b.dataset.bulb, spacing: BULBS[b.dataset.bulb].spacing });
  });
  $('#effect').addEventListener('click', (e) => {
    const b = e.target.closest('[data-effect]');
    if (!b) return;
    state.effect = b.dataset.effect;
    if (reducedMotion && state.effect !== 'steady') toast('Animation is off because your device is set to reduce motion.');
    syncUI();
    requestRender();
  });

  // Spacing: one undo step per drag, not per tick.
  let spacingDrag = false;
  $('#spacing').addEventListener('input', (e) => {
    const v = +e.target.value;
    state.style.spacing = v;
    const st = selectedStrand();
    if (st) {
      if (!spacingDrag) { checkpoint(); spacingDrag = true; }
      st.spacing = v;
    }
    if (state.draft) state.draft.spacing = v;
    $('#spacingOut').textContent = v + ' in';
    requestRender();
  });
  $('#spacing').addEventListener('change', () => { spacingDrag = false; syncUI(); });

  $('#night').addEventListener('input', (e) => {
    state.night = +e.target.value / 100;
    const n = +e.target.value;
    $('#nightOut').textContent = n < 20 ? 'Day' : n < 65 ? 'Dusk' : 'Night';
    requestRender();
  });
  $('#spill').addEventListener('input', (e) => {
    state.spill = +e.target.value / 100;
    $('#spillOut').textContent = e.target.value + '%';
    requestRender();
  });
  $('#compare').addEventListener('click', () => {
    state.compare = !state.compare;
    syncUI();
    requestRender();
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#finish').addEventListener('click', finishDraft);
  $('#cancel').addEventListener('click', () => {
    if (state.draft) cancelDraft();
    else { state.scaleLine = null; syncUI(); requestRender(false); }
  });
  $('#deleteStrand').addEventListener('click', deleteSelected);
  $('#deselect').addEventListener('click', () => select(null));
  $('#strandList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    if (state.tool !== 'edit') setTool('edit');
    select(+b.dataset.id);
  });

  let clearArmed = 0;
  $('#clearAll').addEventListener('click', (e) => {
    // Two-step confirm in place: the first click arms, the second clears.
    if (Date.now() - clearArmed > 3000) {
      clearArmed = Date.now();
      e.target.textContent = 'Click again to clear';
      setTimeout(() => { e.target.textContent = 'Clear all'; }, 3000);
      return;
    }
    clearArmed = 0;
    e.target.textContent = 'Clear all';
    checkpoint();
    state.strands = [];
    state.selected = null;
    syncUI();
    requestRender();
    toast('Cleared all lights. Press Undo to bring them back.');
  });

  $('#scaleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inches = (+$('#scaleFt').value || 0) * 12 + (+$('#scaleIn').value || 0);
    const [a, b] = state.scaleLine || [];
    if (!a || !b || inches <= 0) { toast('Enter a length greater than zero.'); return; }
    const px = dist(a, b);
    if (px < 10) { toast('That line is too short to measure. Draw it across the whole door.'); return; }
    checkpoint();
    state.ppi = px / inches;
    state.scaleSource = 'measured';
    state.scaleLine = null;
    setTool('draw');
    toast('Scale set. Bulb sizes and lengths now match your house.');
  });

  // ---------------------------------------------------------------- upload, drop, paste
  $('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    $('#dropHint').hidden = false;
    stage.classList.add('is-dragover');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; stage.classList.remove('is-dragover'); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    stage.classList.remove('is-dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // ---------------------------------------------------------------- export
  $('#export').addEventListener('click', () => {
    const c = document.createElement('canvas');
    c.width = state.W;
    c.height = state.H;
    const saveDraft = state.draft;
    state.draft = null;
    renderScene(c.getContext('2d'), performance.now() / 1000, false);
    state.draft = saveDraft;
    c.toBlob((blob) => {
      if (!blob) { toast('Couldn’t create the image. Try a smaller photo.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = EXPORT_NAME;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(`Saved ${EXPORT_NAME}.`);
    }, 'image/png');
  });

  // ---------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  // ---------------------------------------------------------------- boot
  loadSample();
  stage.dataset.tool = state.tool;
  syncUI();
  if (document.fonts) document.fonts.ready.then(() => requestRender(false));
})();
