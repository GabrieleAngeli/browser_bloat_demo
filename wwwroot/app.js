const $ = (id) => document.getElementById(id);

const pointsEl = $("points");
const bucketsEl = $("buckets");
const seedEl = $("seed");

const seriesStartEl = $("seriesStart");
const seriesStepsEl = $("seriesSteps");
const seriesMultEl = $("seriesMult");
const seriesCooldownEl = $("seriesCooldown");

const outEl = $("out");

const previewCanvas = $("chart");
const previewCtx = previewCanvas.getContext("2d");

const cTime = $("chartTime").getContext("2d");
const cCpu  = $("chartCpu").getContext("2d");
const cMem  = $("chartMem").getContext("2d");
const cBrk  = $("chartBreak").getContext("2d");

let isRunning = false;

/**
 * Clear separation between Browser-heavy and Backend-light:
 * - Browser: orange solid
 * - Backend: green dashed
 * - Delta area shaded
 */
const THEME = {
  grid: "rgba(38,49,74,0.55)",
  axis: "#26314a",
  text: "rgba(231,234,240,0.92)",
  textDim: "rgba(231,234,240,0.75)",

  browser: {
    line: "rgba(255, 159, 10, 0.95)",
    fillDelta: "rgba(255, 159, 10, 0.12)",
    fetch: "rgba(255, 159, 10, 0.35)",
    parse: "rgba(255, 159, 10, 0.75)",
    compute: "rgba(255, 159, 10, 0.20)",
  },
  backend: {
    line: "rgba(52, 199, 89, 0.95)",
    fetch: "rgba(52, 199, 89, 0.35)",
    parse: "rgba(52, 199, 89, 0.75)",
  }
};

$("runClient").addEventListener("click", () => runSingle("browser"));
$("runServer").addEventListener("click", () => runSingle("backend"));
$("runSeries").addEventListener("click", runSeriesBenchmark);
$("clear").addEventListener("click", clearAll);

function log(line) {
  outEl.textContent += line + "\n";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function memMB() {
  // Chrome/Edge only (most of the time). If unavailable, returns null.
  const m = performance.memory;
  if (!m) return null;
  return m.usedJSHeapSize / (1024 * 1024);
}

function fmtMB(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(1)}MB`;
}

function maxNonNull(...vals) {
  const v = vals.filter(x => x != null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

async function timedFetchJson(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const t1 = performance.now();
  const json = await res.json();
  const t2 = performance.now();
  return { json, fetchMs: (t1 - t0), parseMs: (t2 - t1) };
}

function aggregateClient(rawPairs, buckets) {
  const t0 = performance.now();

  const min = Array(buckets).fill(Number.POSITIVE_INFINITY);
  const max = Array(buckets).fill(Number.NEGATIVE_INFINITY);
  const sum = Array(buckets).fill(0);
  const cnt = Array(buckets).fill(0);

  const n = rawPairs.length;

  for (let i = 0; i < n; i++) {
    const y = rawPairs[i][1];
    const b = Math.floor((i * buckets) / n);
    if (y < min[b]) min[b] = y;
    if (y > max[b]) max[b] = y;
    sum[b] += y;
    cnt[b] += 1;
  }

  const series = new Array(buckets);
  for (let b = 0; b < buckets; b++) {
    series[b] = {
      bucket: b,
      min: Number.isFinite(min[b]) ? min[b] : 0,
      max: Number.isFinite(max[b]) ? max[b] : 0,
      avg: cnt[b] ? sum[b] / cnt[b] : 0,
    };
  }

  const t1 = performance.now();
  return { series, computeMs: (t1 - t0) };
}

/**
 * CPU “UX estimate”:
 * busyMs: parse + compute (main-thread-ish work)
 * cpuBusyPct: busyMs / totalMs
 */
function cpuEstimate(totalMs, parseMs, computeMs) {
  const busyMs = (parseMs || 0) + (computeMs || 0);
  const pct = totalMs > 0 ? (busyMs / totalMs) * 100 : 0;
  return { busyMs, cpuBusyPct: pct };
}

/* ========= Preview chart (min/max band + avg) ========= */

function clearPreview() {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function drawPreviewSeries(series, title) {
  clearPreview();

  const ctx = previewCtx;
  const w = previewCanvas.width, h = previewCanvas.height;
  const pad = 28;

  let lo = Infinity, hi = -Infinity;
  for (const p of series) {
    lo = Math.min(lo, p.min);
    hi = Math.max(hi, p.max);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { lo = -1; hi = 1; }

  // axes
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = THEME.axis;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  // title
  ctx.fillStyle = THEME.text;
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(title, pad, 18);

  const n = series.length;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
  const y = (v) => {
    const t = (v - lo) / (hi - lo);
    return (h - pad) - t * (h - 2 * pad);
  };

  // min/max band
  ctx.fillStyle = "rgba(231,234,240,0.08)";
  ctx.beginPath();
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(series[i].max));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), y(series[i].min));
  ctx.closePath();
  ctx.fill();

  // avg line
  ctx.strokeStyle = "rgba(231,234,240,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i), py = y(series[i].avg);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/* ========= Benchmark drawing helpers ========= */

function clearCanvas(ctx) {
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawAxesAndGrid(ctx, lo, hi, yFormatter, labels) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const padL = 42, padR = 10, padT = 22, padB = 28;

  // axes
  ctx.strokeStyle = THEME.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB);
  ctx.stroke();

  const y = (v) => {
    const t = (v - lo) / (hi - lo);
    return (h - padB) - t * (h - padT - padB);
  };

  // grid + y labels
  ctx.fillStyle = THEME.textDim;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const vv = lo + (t * (hi - lo)) / ticks;
    const yy = y(vv);
    ctx.fillText(yFormatter(vv), 8, yy + 4);
    ctx.strokeStyle = THEME.grid;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
  }

  // x scale
  const x = (i) => {
    const n = Math.max(1, labels.length - 1);
    return padL + (i * (w - padL - padR)) / n;
  };

  // x labels
  labels.forEach((lab, i) => {
    const xx = x(i);
    if (labels.length <= 6 || i === 0 || i === labels.length - 1 || i % 2 === 0) {
      ctx.fillText(lab, xx - 10, h - 8);
    }
  });

  return { padL, padR, padT, padB, x, y };
}

function drawLegend(ctx, items) {
  // items: [{label, color, dashed}]
  const x0 = 52, y0 = 26;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillStyle = THEME.text;

  let yy = y0;
  for (const it of items) {
    ctx.strokeStyle = it.color;
    ctx.lineWidth = 3;
    ctx.setLineDash(it.dashed ? [7, 5] : []);
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(x0 + 22, yy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillText(it.label, x0 + 30, yy + 4);
    yy += 16;
  }
}

function drawDeltaBadge(ctx, label, browserVal, backendVal, unit = "") {
  const w = ctx.canvas.width;
  const text =
    (browserVal != null && backendVal != null)
      ? `${label}: browser ${browserVal.toFixed(1)}${unit} | backend ${backendVal.toFixed(1)}${unit} | Δ ${(browserVal - backendVal).toFixed(1)}${unit}`
      : `${label}: n/a`;

  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const pad = 8;
  const tw = ctx.measureText(text).width;

  const bx = w - tw - pad * 2 - 10;
  const by = 8;
  const bw = tw + pad * 2;
  const bh = 18 + pad;

  // background
  ctx.fillStyle = "rgba(15,20,32,0.88)";
  ctx.strokeStyle = THEME.axis;
  ctx.lineWidth = 1;

  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
  }

  ctx.fillStyle = THEME.text;
  ctx.fillText(text, bx + pad, by + 18);
}

/**
 * Enhanced line chart:
 * - Browser (orange solid) vs Backend (green dashed)
 * - Shaded delta area between the two lines to emphasize difference
 * - Legend + last-point badge with delta
 */
function drawLineChartEnhanced(ctx, labels, browserVals, backendVals, title, yFormatter, unit = "") {
  clearCanvas(ctx);

  // title
  ctx.fillStyle = THEME.text;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(title, 10, 14);

  // bounds
  const all = [...browserVals, ...backendVals].filter(v => v != null && Number.isFinite(v));
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 1;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { lo = 0; hi = lo + 1; }

  const { x, y } = drawAxesAndGrid(ctx, lo, hi, yFormatter, labels);

  // build points
  const bPts = [];
  const sPts = [];
  for (let i = 0; i < labels.length; i++) {
    const bv = browserVals[i];
    const sv = backendVals[i];
    bPts.push((bv == null || !Number.isFinite(bv)) ? null : { x: x(i), y: y(bv), v: bv });
    sPts.push((sv == null || !Number.isFinite(sv)) ? null : { x: x(i), y: y(sv), v: sv });
  }

  // delta area segments (where both series exist)
  ctx.fillStyle = THEME.browser.fillDelta;

  let inSeg = false;
  let segStart = 0;

  function fillSegment(start, end) {
    if (end - start < 1) return;
    ctx.beginPath();
    for (let k = start; k <= end; k++) ctx.lineTo(bPts[k].x, bPts[k].y);
    for (let k = end; k >= start; k--) ctx.lineTo(sPts[k].x, sPts[k].y);
    ctx.closePath();
    ctx.fill();
  }

  for (let i = 0; i < labels.length; i++) {
    const ok = bPts[i] && sPts[i];
    if (ok && !inSeg) { inSeg = true; segStart = i; }
    if (!ok && inSeg) { inSeg = false; fillSegment(segStart, i - 1); }
  }
  if (inSeg) fillSegment(segStart, labels.length - 1);

  // backend line (dashed)
  ctx.strokeStyle = THEME.backend.line;
  ctx.lineWidth = 2.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  {
    let first = true;
    for (const p of sPts) {
      if (!p) continue;
      if (first) { ctx.moveTo(p.x, p.y); first = false; }
      else ctx.lineTo(p.x, p.y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // backend markers
  ctx.fillStyle = THEME.backend.line;
  for (const p of sPts) {
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // browser line (solid)
  ctx.strokeStyle = THEME.browser.line;
  ctx.lineWidth = 3.0;
  ctx.beginPath();
  {
    let first = true;
    for (const p of bPts) {
      if (!p) continue;
      if (first) { ctx.moveTo(p.x, p.y); first = false; }
      else ctx.lineTo(p.x, p.y);
    }
  }
  ctx.stroke();

  // browser markers
  ctx.fillStyle = THEME.browser.line;
  for (const p of bPts) {
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLegend(ctx, [
    { label: "Browser heavy", color: THEME.browser.line, dashed: false },
    { label: "Backend light", color: THEME.backend.line, dashed: true },
  ]);

  // last-point badge
  const lastIdx = labels.length - 1;
  const lastB = browserVals[lastIdx];
  const lastS = backendVals[lastIdx];
  drawDeltaBadge(
    ctx,
    "Last",
    Number.isFinite(lastB) ? lastB : null,
    Number.isFinite(lastS) ? lastS : null,
    unit
  );
}

/**
 * Stacked breakdown bars:
 * - Two bars per step: Browser-heavy vs Backend-light
 * - Each bar is stacked by phase times (fetch/parse/compute)
 */
function drawStackedBreakdown(ctx, labels, browser, backend) {
  clearCanvas(ctx);

  ctx.fillStyle = THEME.text;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText("Stacked breakdown (ms) — Browser vs Backend per step", 10, 14);

  const w = ctx.canvas.width, h = ctx.canvas.height;
  const padL = 42, padR = 10, padT = 22, padB = 28;

  // max total across all bars
  let maxTotal = 1;
  for (let i = 0; i < labels.length; i++) {
    const bt = (browser.fetch[i] || 0) + (browser.parse[i] || 0) + (browser.compute[i] || 0);
    const st = (backend.fetch[i] || 0) + (backend.parse[i] || 0);
    maxTotal = Math.max(maxTotal, bt, st);
  }

  // axes
  ctx.strokeStyle = THEME.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB);
  ctx.stroke();

  // y scale
  const y = (v) => {
    const t = v / maxTotal;
    return (h - padB) - t * (h - padT - padB);
  };

  // grid ticks
  ctx.fillStyle = THEME.textDim;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const vv = (t * maxTotal) / ticks;
    const yy = y(vv);
    ctx.fillText(`${vv.toFixed(0)}`, 10, yy + 4);
    ctx.strokeStyle = THEME.grid;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
  }

  // x scale and bar geometry
  const n = labels.length;
  const plotW = (w - padL - padR);
  const groupW = plotW / Math.max(1, n);
  const barGap = 6;
  const barW = Math.max(10, (groupW - barGap * 3) / 2);

  function xGroup(i) {
    return padL + i * groupW;
  }

  // x labels
  ctx.fillStyle = THEME.textDim;
  for (let i = 0; i < n; i++) {
    const gx = xGroup(i);
    const lab = labels[i];
    if (n <= 6 || i === 0 || i === n - 1 || i % 2 === 0) {
      ctx.fillText(lab, gx + groupW / 2 - 12, h - 8);
    }
  }

  // draw bars
  for (let i = 0; i < n; i++) {
    const gx = xGroup(i);
    const baseY = h - padB;

    // Browser bar (left)
    let x0 = gx + barGap;
    let acc = 0;

    const bf = browser.fetch[i] || 0;
    const bp = browser.parse[i] || 0;
    const bc = browser.compute[i] || 0;

    drawStackRect(ctx, x0, baseY, barW, bf, acc, THEME.browser.fetch, y); acc += bf;
    drawStackRect(ctx, x0, baseY, barW, bp, acc, THEME.browser.parse, y); acc += bp;
    drawStackRect(ctx, x0, baseY, barW, bc, acc, THEME.browser.compute, y);

    // Backend bar (right)
    x0 = gx + barGap * 2 + barW;
    acc = 0;

    const sf = backend.fetch[i] || 0;
    const sp = backend.parse[i] || 0;

    drawStackRect(ctx, x0, baseY, barW, sf, acc, THEME.backend.fetch, y); acc += sf;
    drawStackRect(ctx, x0, baseY, barW, sp, acc, THEME.backend.parse, y);

    // outlines
    ctx.strokeStyle = THEME.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(gx + barGap, y(bf + bp + bc), barW, baseY - y(bf + bp + bc));
    ctx.strokeRect(gx + barGap * 2 + barW, y(sf + sp), barW, baseY - y(sf + sp));
  }

  drawLegend(ctx, [
    { label: "Browser heavy (stacked)", color: THEME.browser.line, dashed: false },
    { label: "Backend light (stacked)", color: THEME.backend.line, dashed: true },
  ]);
}

function drawStackRect(ctx, x, baseY, w, value, accBelow, fill, yScaleFn) {
  if (!value || value <= 0) return;
  const y0 = yScaleFn(accBelow);
  const y1 = yScaleFn(accBelow + value);
  const top = y1;
  const height = y0 - y1;
  ctx.fillStyle = fill;
  ctx.fillRect(x, top, w, height);
}

/* ========= Runs ========= */

async function runSingle(mode) {
  if (isRunning) return;
  isRunning = true;
  try {
    const points = clamp(Number(pointsEl.value), 1000, 1_000_000);
    const buckets = clamp(Number(bucketsEl.value), 50, 10_000);
    const seed = clamp(Number(seedEl.value), 1, 9999);

    outEl.textContent += `\n--- Single run (${mode}) ---\n`;

    if (mode === "browser") {
      const r = await runBrowserHeavy(points, buckets, seed, true);
      drawPreviewSeries(r.previewSeries, `Browser aggregates — points=${points}, buckets=${buckets}`);
    } else {
      const r = await runBackendLight(points, buckets, seed, true);
      drawPreviewSeries(r.previewSeries, `Backend aggregates — points=${points}, buckets=${buckets}`);
    }
  } finally {
    isRunning = false;
  }
}

async function runBrowserHeavy(points, buckets, seed, verbose) {
  const heapBefore = memMB();
  const t0 = performance.now();

  const url = `/api/raw?points=${points}&seed=${seed}`;
  const { json, fetchMs, parseMs } = await timedFetchJson(url);

  const heapAfterParse = memMB();

  const agg = aggregateClient(json.data, buckets);

  const heapAfterCompute = memMB();
  const heapPeak = maxNonNull(heapBefore, heapAfterParse, heapAfterCompute);
  const heapDelta = (heapPeak != null && heapBefore != null) ? (heapPeak - heapBefore) : null;

  // Optional: help GC by dropping reference to the huge raw payload:
  // json.data = null;
  // await sleep(0);

  const t1 = performance.now();
  const totalMs = t1 - t0;

  const { cpuBusyPct } = cpuEstimate(totalMs, parseMs, agg.computeMs);

  if (verbose) {
    log("=== Browser heavy (client aggregates) ===");
    log(`Heap before: ${fmtMB(heapBefore)} | peak: ${fmtMB(heapPeak)} | delta: ${heapDelta == null ? "n/a" : heapDelta.toFixed(1) + "MB"}`);
    log(`Raw payload: points=${json.points}, serverGeneratedMs=${json.generatedMs}`);
    log(`FetchMs=${fetchMs.toFixed(1)} ParseMs=${parseMs.toFixed(1)} ComputeMs=${agg.computeMs.toFixed(1)} TotalMs=${totalMs.toFixed(1)}`);
    log(`CPU busy estimate: ${cpuBusyPct.toFixed(1)}% (parse+compute over total)`);
    log("");
  }

  return {
    points,
    buckets,
    totalMs,
    fetchMs,
    parseMs,
    computeMs: agg.computeMs,
    cpuBusyPct,
    heapDelta,
    previewSeries: agg.series
  };
}

async function runBackendLight(points, buckets, seed, verbose) {
  const heapBefore = memMB();
  const t0 = performance.now();

  const url = `/api/aggregate?points=${points}&buckets=${buckets}&seed=${seed}`;
  const { json, fetchMs, parseMs } = await timedFetchJson(url);

  const heapAfterParse = memMB();
  const heapPeak = maxNonNull(heapBefore, heapAfterParse);
  const heapDelta = (heapPeak != null && heapBefore != null) ? (heapPeak - heapBefore) : null;

  const t1 = performance.now();
  const totalMs = t1 - t0;

  const { cpuBusyPct } = cpuEstimate(totalMs, parseMs, 0);

  if (verbose) {
    log("=== Backend light (server aggregates) ===");
    log(`Heap before: ${fmtMB(heapBefore)} | peak: ${fmtMB(heapPeak)} | delta: ${heapDelta == null ? "n/a" : heapDelta.toFixed(1) + "MB"}`);
    log(`Aggregated: points=${json.points}, buckets=${json.buckets}, serverComputedMs=${json.computedMs}`);
    log(`FetchMs=${fetchMs.toFixed(1)} ParseMs=${parseMs.toFixed(1)} TotalMs=${totalMs.toFixed(1)}`);
    log(`CPU busy estimate: ${cpuBusyPct.toFixed(1)}% (parse over total)`);
    log("");
  }

  return {
    points,
    buckets,
    totalMs,
    fetchMs,
    parseMs,
    computeMs: 0,
    cpuBusyPct,
    heapDelta,
    previewSeries: json.series
  };
}

function clearAll() {
  outEl.textContent = "";
  clearPreview();
  clearCanvas(cTime);
  clearCanvas(cCpu);
  clearCanvas(cMem);
  clearCanvas(cBrk);
}

/* ========= Series benchmark (serial) ========= */

async function runSeriesBenchmark() {
  if (isRunning) return;
  isRunning = true;

  try {
    outEl.textContent += `\n=== SERIES BENCHMARK (serial) ===\n`;

    const seed = clamp(Number(seedEl.value), 1, 9999);
    const buckets = clamp(Number(bucketsEl.value), 50, 10_000);

    let start = clamp(Number(seriesStartEl.value), 1000, 1_000_000);
    const steps = clamp(Number(seriesStepsEl.value), 1, 10);
    const mult = clamp(Number(seriesMultEl.value), 1, 3);
    const cooldown = clamp(Number(seriesCooldownEl.value), 0, 2000);

    const labels = [];

    const browser = { total: [], cpu: [], heapDelta: [], fetch: [], parse: [], compute: [] };
    const backend = { total: [], cpu: [], heapDelta: [], fetch: [], parse: [] };

    for (let i = 0; i < steps; i++) {
      const points = clamp(Math.round(start), 1000, 1_000_000);
      labels.push(`${Math.round(points / 1000)}k`);

      log(`--- Step ${i + 1}/${steps}: points=${points}, buckets=${buckets} ---`);

      // 1) Browser heavy
      const rB = await runBrowserHeavy(points, buckets, seed, false);
      browser.total.push(rB.totalMs);
      browser.cpu.push(rB.cpuBusyPct);
      browser.heapDelta.push(rB.heapDelta);
      browser.fetch.push(rB.fetchMs);
      browser.parse.push(rB.parseMs);
      browser.compute.push(rB.computeMs);

      if (cooldown) await sleep(cooldown);

      // 2) Backend light
      const rS = await runBackendLight(points, buckets, seed, false);
      backend.total.push(rS.totalMs);
      backend.cpu.push(rS.cpuBusyPct);
      backend.heapDelta.push(rS.heapDelta);
      backend.fetch.push(rS.fetchMs);
      backend.parse.push(rS.parseMs);

      // preview: show backend output (cleaner)
      drawPreviewSeries(rS.previewSeries, `Last step preview (backend) — points=${points}, buckets=${buckets}`);

      // charts (emphasized)
      drawLineChartEnhanced(cTime, labels, browser.total, backend.total, "Total time (ms)", v => v.toFixed(0), "ms");
      drawLineChartEnhanced(cCpu,  labels, browser.cpu,   backend.cpu,   "CPU busy estimate (%)", v => v.toFixed(0) + "%", "%");

      // heap delta chart
      const bHeapDelta = browser.heapDelta.map(v => (v == null || !Number.isFinite(v) ? null : v));
      const sHeapDelta = backend.heapDelta.map(v => (v == null || !Number.isFinite(v) ? null : v));
      drawLineChartEnhanced(cMem, labels, bHeapDelta, sHeapDelta, "JS heap delta (MB)", v => v.toFixed(1), "MB");

      // stacked breakdown
      drawStackedBreakdown(cBrk, labels,
        { fetch: browser.fetch, parse: browser.parse, compute: browser.compute },
        { fetch: backend.fetch, parse: backend.parse }
      );

      log(
        `Browser: total=${rB.totalMs.toFixed(1)}ms, cpu~${rB.cpuBusyPct.toFixed(1)}%, heapΔ=${rB.heapDelta == null ? "n/a" : rB.heapDelta.toFixed(1) + "MB"} | ` +
        `Backend: total=${rS.totalMs.toFixed(1)}ms, cpu~${rS.cpuBusyPct.toFixed(1)}%, heapΔ=${rS.heapDelta == null ? "n/a" : rS.heapDelta.toFixed(1) + "MB"}`
      );
      log("");

      start *= mult;
      if (start > 1_000_000 && i < steps - 1) start = 1_000_000;

      if (cooldown) await sleep(cooldown);
    }

    log("=== SERIES DONE ===\n");
  } finally {
    isRunning = false;
  }
}
