/**
 * Wiring.
 *
 * Everything here is presentation: read the controls, ask the model for a
 * timeline, draw it, keep the URL shareable. No network, no storage, no
 * analytics — the only state is what is on screen.
 */

import { plan, normaliseOptions, formatMs, formatBytes, toReport } from './journey.js';
import { PRESETS, DEFAULT_PRESET } from './presets.js';
import { waterfall, ladder, phaseCards, compare } from './render.js';

/** Everything a shared link needs to reproduce the same picture. */
const KEYS = ['rtt', 'dns', 'connection', 'tls', 'http', 'serverMs', 'documentKb', 'assets', 'assetKb', 'mbps', 'paintMs'];
const RANGES = ['rtt', 'serverMs', 'documentKb', 'assets', 'mbps'];
const RADIOS = ['dns', 'connection', 'tls', 'http'];

const $ = (selector) => document.querySelector(selector);

const els = {
  form: $('#controls'),
  presetBlurb: $('#preset-blurb'),
  presets: [...document.querySelectorAll('.preset')],
  reset: $('#reset'),
  share: $('#share'),
  play: $('#play'),
  copy: $('#copy'),
  playNote: $('#play-note'),
  totalValue: $('#total-value'),
  factRtts: $('#fact-rtts'),
  factBytes: $('#fact-bytes'),
  factTtfb: $('#fact-ttfb'),
  insight: $('#insight'),
  waterfall: $('#waterfall'),
  ladder: $('#ladder'),
  phases: $('#phases'),
  compare: $('#compare'),
  reportRow: $('.report-row'),
};

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

let state = initialOptions();
let result = plan(state);
let selected = null;
let animation = null;
let playheadMs = 0;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function presetOptions(id) {
  const preset = PRESETS.find((entry) => entry.id === id) ?? PRESETS.find((entry) => entry.id === DEFAULT_PRESET);
  return { ...preset.options };
}

function fromUrl() {
  const params = new URLSearchParams(window.location.search);
  const custom = KEYS.some((key) => params.has(key));
  const base = custom ? { ...presetOptions(DEFAULT_PRESET) } : { ...presetOptions(params.get('preset') ?? DEFAULT_PRESET) };

  if (custom) {
    for (const key of KEYS) {
      if (params.has(key)) base[key] = params.get(key);
    }
  }
  return normaliseOptions(base);
}

function initialOptions() {
  try {
    return fromUrl();
  } catch {
    return normaliseOptions(presetOptions(DEFAULT_PRESET));
  }
}

function readForm() {
  const next = { ...state };
  const data = new FormData(els.form);
  for (const [key, value] of data.entries()) next[key] = value;
  return normaliseOptions(next);
}

function applyOptionsToForm(options) {
  for (const key of RANGES) {
    const input = document.getElementById(key);
    if (input) input.value = String(options[key]);
  }
  for (const key of RADIOS) {
    const input = els.form.querySelector(`input[name="${key}"][value="${options[key]}"]`);
    if (input) input.checked = true;
  }
  syncOutputs(options);
}

function syncOutputs(options) {
  setOutput('rtt', `${Math.round(options.rtt)} ms`);
  setOutput('serverMs', `${Math.round(options.serverMs)} ms`);
  setOutput('documentKb', `${Math.round(options.documentKb)} KB`);
  setOutput('assets', `${options.assets}`);
  setOutput('mbps', `${Math.round(options.mbps)} Mbps`);
}

function setOutput(key, text) {
  const output = document.getElementById(`${key}-out`);
  if (output) output.textContent = text;
  const input = document.getElementById(key);
  if (input) input.setAttribute('aria-valuetext', text);
}

function syncUrl() {
  const params = new URLSearchParams();
  for (const key of KEYS) params.set(key, String(state[key]));
  const url = new URL(window.location.href);
  url.search = params.toString();
  try {
    window.history.replaceState(null, '', url);
  } catch {
    /* file:// and some embedded contexts refuse history changes; the page still works. */
  }
}

function matchingPreset() {
  return PRESETS.find((preset) =>
    Object.entries(preset.options).every(([key, value]) => String(state[key]) === String(normaliseOptions(preset.options)[key]))
  );
}

function syncPresetUi() {
  const match = matchingPreset();
  for (const button of els.presets) {
    button.setAttribute('aria-pressed', String(match?.id === button.dataset.preset));
  }
  els.presetBlurb.textContent = match
    ? match.blurb
    : 'A hand-tuned scenario. The model only knows what you tell it here.';
}

function applyPreset(id) {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (!preset) return;
  state = normaliseOptions(preset.options);
  applyOptionsToForm(state);
  renderAll();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll({ keepPlayhead = false } = {}) {
  result = plan(state);

  els.totalValue.textContent = formatMs(result.total);
  els.factRtts.textContent = String(result.rtts);
  els.factBytes.textContent = formatBytes(result.bytes);
  els.factTtfb.textContent = formatMs(result.firstByteMs);
  els.insight.textContent = result.insight;

  els.waterfall.innerHTML = waterfall(result);
  els.ladder.innerHTML = ladder(result);
  els.phases.innerHTML = phaseCards(result);
  els.compare.innerHTML = compare(PRESETS.map((preset) => ({ preset, result: plan(preset.options) })));

  syncOutputs(state);
  syncPresetUi();
  syncUrl();

  if (selected && !els.phases.querySelector(`[data-phase="${selected}"]`)) selected = null;
  applySelection();

  if (keepPlayhead && playheadMs > 0) {
    showPlayhead(Math.min(playheadMs, result.total));
    markProgress(Math.min(playheadMs, result.total));
  } else {
    resetPlayhead();
  }
}

function svgCharts() {
  return [els.waterfall.querySelector('svg'), els.ladder.querySelector('svg')].filter(Boolean);
}

function playheadGroups() {
  return svgCharts().map((svg) => svg.querySelector('.playhead-g')).filter(Boolean);
}

function showPlayhead(ms) {
  playheadMs = ms;
  for (const svg of svgCharts()) {
    const left = Number(svg.dataset.plotLeft);
    const width = Number(svg.dataset.plotWidth);
    const total = Number(svg.dataset.total) || 1;
    const ratio = Math.min(1, Math.max(0, ms / total));
    const group = svg.querySelector('.playhead-g');
    if (!group) continue;
    group.setAttribute('visibility', 'visible');
    group.setAttribute('transform', `translate(${(left + ratio * width).toFixed(2)} 0)`);
  }
}

function hidePlayhead() {
  for (const group of playheadGroups()) group.setAttribute('visibility', 'hidden');
}

function markProgress(ms) {
  for (const group of document.querySelectorAll('.svg-slot .phase-group')) {
    const start = Number(group.dataset.start);
    const end = Number(group.dataset.end);
    group.classList.toggle('dim', start > ms);
    group.classList.toggle('live', end > ms && start <= ms);
  }
  for (const card of els.phases.querySelectorAll('.phase-card')) {
    const start = Number(card.dataset.start);
    const end = Number(card.dataset.end);
    card.classList.toggle('live', end > ms && start <= ms);
  }
}

function clearProgress() {
  for (const group of document.querySelectorAll('.svg-slot .phase-group')) {
    group.classList.remove('dim', 'live');
  }
  for (const card of els.phases.querySelectorAll('.phase-card')) {
    card.classList.remove('live');
  }
}

function resetPlayhead() {
  stopAnimation();
  playheadMs = 0;
  hidePlayhead();
  clearProgress();
  els.play.setAttribute('aria-pressed', 'false');
  els.play.textContent = 'Play the load';
  els.playNote.textContent = 'Watch the round trips accumulate.';
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

function applySelection() {
  for (const card of els.phases.querySelectorAll('.phase-card')) {
    card.classList.toggle('active', card.dataset.phase === selected);
  }
  for (const group of document.querySelectorAll('.svg-slot .phase-group')) {
    const isSelected = group.dataset.phase === selected;
    group.classList.toggle('is-selected', isSelected);
    group.classList.toggle('is-muted', Boolean(selected) && !isSelected);
  }
}

function select(id, { scroll = false } = {}) {
  selected = selected === id ? null : id;
  applySelection();
  if (scroll && selected) {
    const card = els.phases.querySelector(`[data-phase="${selected}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

/* ------------------------------------------------------------------ */
/* Animation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Give every non-zero phase at least a moment on screen, then divide the rest
 * of the window in proportion to its duration. A 45 ms DNS lookup should not
 * be a single frame just because it is a small number.
 */
function buildSchedule(timeline, windowMs = 4200) {
  const active = timeline.phases.filter((phase) => phase.ms > 0);
  const floor = 230;
  const guaranteed = Math.min(windowMs * 0.55, active.length * floor);
  const perPhase = active.length ? guaranteed / active.length : 0;
  const remaining = Math.max(0, windowMs - active.length * perPhase);
  const entries = [];
  let acc = 0;
  let from = 0;

  for (const phase of active) {
    const share = timeline.total > 0 ? phase.ms / timeline.total : 1 / Math.max(1, active.length);
    acc += perPhase + remaining * share;
    const to = Math.min(1, acc / windowMs);
    entries.push({ from, to, phase });
    from = to;
  }

  return {
    durationMs: windowMs,
    timeAt(progress) {
      if (progress >= 1) return timeline.total;
      const p = Math.max(0, progress);
      for (const entry of entries) {
        if (p <= entry.to) {
          const span = entry.to - entry.from;
          const local = span > 0 ? (p - entry.from) / span : 1;
          return entry.phase.start + (entry.phase.end - entry.phase.start) * Math.min(1, Math.max(0, local));
        }
      }
      return timeline.total;
    },
  };
}

function stopAnimation() {
  if (animation) cancelAnimationFrame(animation);
  animation = null;
}

function play() {
  if (animation) {
    stopAnimation();
    els.play.setAttribute('aria-pressed', 'false');
    els.play.textContent = 'Play again';
    els.playNote.textContent = `Stopped at ${formatMs(playheadMs)}.`;
    return;
  }

  clearProgress();
  playheadMs = 0;

  if (prefersReducedMotion()) {
    showPlayhead(result.total);
    els.play.textContent = 'Play again';
    els.playNote.textContent = 'Reduced motion is on: the full load is shown at once.';
    return;
  }

  const schedule = buildSchedule(result);
  const started = performance.now();
  els.play.setAttribute('aria-pressed', 'true');
  els.play.textContent = 'Pause';
  els.playNote.textContent = 'Each phase gets a moment on screen; the playhead moves through the load.';

  const step = (now) => {
    const progress = Math.min(1, (now - started) / schedule.durationMs);
    const ms = schedule.timeAt(progress);
    showPlayhead(ms);
    markProgress(ms);
    if (progress < 1) {
      animation = requestAnimationFrame(step);
    } else {
      animation = null;
      playheadMs = result.total;
      showPlayhead(result.total);
      clearProgress();
      els.play.setAttribute('aria-pressed', 'false');
      els.play.textContent = 'Play again';
      els.playNote.textContent = 'That is the whole load, from URL to first paint.';
    }
  };

  animation = requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the old way */
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function flash(button, text) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = button.dataset.label ?? original;
  }, 1600);
}

function shareUrl() {
  const params = new URLSearchParams();
  for (const key of KEYS) params.set(key, String(state[key]));
  const url = new URL(window.location.href);
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

function showReportFallback(text) {
  let area = document.getElementById('report-fallback');
  if (!area) {
    area = document.createElement('textarea');
    area.id = 'report-fallback';
    area.className = 'report-fallback';
    area.setAttribute('readonly', '');
    area.setAttribute('aria-label', 'Timeline text, select and copy');
    els.reportRow.after(area);
  }
  area.value = text;
  area.focus();
  area.select();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

els.form.addEventListener('input', () => {
  state = readForm();
  renderAll();
});

els.form.addEventListener('change', () => {
  state = readForm();
  renderAll();
});

for (const button of els.presets) {
  button.addEventListener('click', () => applyPreset(button.dataset.preset));
}

els.reset.addEventListener('click', () => applyPreset(DEFAULT_PRESET));

els.play.addEventListener('click', play);

els.share.addEventListener('click', async () => {
  const ok = await copyText(shareUrl());
  if (ok) {
    flash(els.share, 'Link copied');
  } else {
    flash(els.share, 'Copy failed');
    window.prompt('Copy this link:', shareUrl());
  }
});

els.copy.addEventListener('click', async () => {
  const text = toReport(result);
  const ok = await copyText(text);
  if (ok) {
    flash(els.copy, 'Copied');
    document.getElementById('report-fallback')?.remove();
  } else {
    flash(els.copy, 'Select it below');
    showReportFallback(text);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-phase]');
  if (!target) return;
  if (target.closest('button')) return;
  select(target.dataset.phase, { scroll: Boolean(target.closest('svg')) });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('.phase-card, .svg-slot .phase-group');
  if (!target || !target.dataset.phase) return;
  event.preventDefault();
  select(target.dataset.phase);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

applyOptionsToForm(state);
renderAll();
document.body.dataset.ready = 'true';
