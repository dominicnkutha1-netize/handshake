/**
 * Drawing the model.
 *
 * Pure string builders: no DOM, no measurements, no clock. The same plan always
 * produces byte-identical SVG, which is what lets the screenshots in the README
 * be checked against the numbers in the tests.
 *
 * Two views of one timeline:
 *
 *   waterfall  a row per phase, on a shared time axis
 *   ladder     three lanes (browser, resolver, server), where every V is one
 *              round trip and every diagonal is a transfer
 */

import { formatBytes, formatMs } from './journey.js';

export const COLOURS = Object.freeze({
  dns: '#f2b24c',
  connect: '#46d3e6',
  tls: '#b197fc',
  request: '#4ade80',
  transfer: '#60a5fa',
  assets: '#f472b6',
  paint: '#94a3b8',
});

export const KIND_LABELS = Object.freeze({
  dns: 'DNS',
  connect: 'Transport',
  tls: 'TLS',
  request: 'Request',
  transfer: 'Document',
  assets: 'Subresources',
  paint: 'Paint',
});

const SHORT = {
  dns: 'DNS',
  connect: 'Connect',
  tls: 'TLS',
  request: 'Request',
  document: 'Document',
  assets: 'Assets',
  paint: 'Paint',
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function n(value) {
  return Number(value.toFixed(1));
}

/**
 * Axis steps that land on 1, 2 or 5 times a power of ten.
 * Round numbers are the difference between an axis and a decoration.
 */
export function niceTicks(total, count = 5) {
  if (!Number.isFinite(total) || total <= 0) return [0];
  const rough = total / Math.max(1, count);
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalised = rough / power;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * power;
  const ticks = [];
  for (let value = 0; value <= total + step * 0.001; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  if (ticks[ticks.length - 1] < total - step * 0.001) ticks.push(total);
  return ticks;
}

/** Shared geometry for the two charts, so the playhead lines up in both. */
const WATERFALL = { width: 960, label: 158, left: 168, right: 24, row: 27, top: 34, axis: 36 };
const LADDER = { width: 960, label: 96, left: 104, right: 30, top: 34, axis: 34, height: 308 };
const LANES = { browser: 66, resolver: 152, server: 238 };

function phaseClass(phase) {
  return `phase-group kind-${phase.kind}`;
}

function phaseData(phase) {
  return `data-phase="${esc(phase.id)}" data-start="${phase.start}" data-end="${phase.end}"`;
}

function clickable(phase) {
  return `tabindex="0" role="button" aria-label="${esc(`${phase.label}, ${formatMs(phase.ms)}`)}"`;
}

/* ------------------------------------------------------------------ */
/* Waterfall                                                           */
/* ------------------------------------------------------------------ */

export function waterfall(result) {
  const { phases, total } = result;
  const plotWidth = WATERFALL.width - WATERFALL.left - WATERFALL.right;
  const height = WATERFALL.top + phases.length * WATERFALL.row + WATERFALL.axis;
  const baseY = height - WATERFALL.axis;
  const x = (ms) => WATERFALL.left + (total > 0 ? (ms / total) * plotWidth : 0);

  const parts = [];
  parts.push(
    `<svg viewBox="0 0 ${WATERFALL.width} ${height}" width="${WATERFALL.width}" height="${height}" role="img" ` +
      `aria-label="Waterfall of ${phases.length} phases totalling ${esc(formatMs(total))}" ` +
      `data-plot-left="${WATERFALL.left}" data-plot-width="${plotWidth}" data-total="${total}">`
  );

  // Vertical gridlines behind the bars.
  for (const tick of niceTicks(total)) {
    const tickX = n(x(tick));
    parts.push(`<line x1="${tickX}" y1="${WATERFALL.top - 8}" x2="${tickX}" y2="${baseY}" stroke="#1b2c43" stroke-width="1" />`);
  }

  phases.forEach((phase, index) => {
    const top = WATERFALL.top + index * WATERFALL.row;
    const barY = top + 6;
    const barHeight = 14;
    const colour = COLOURS[phase.kind] ?? COLOURS.paint;
    const x0 = n(x(phase.start));
    const x1 = n(x(phase.end));
    const width = Math.max(0, x1 - x0);

    parts.push(`<g class="${phaseClass(phase)}" ${phaseData(phase)} ${clickable(phase)}>`);
    parts.push(
      `<text class="bar-label" x="${WATERFALL.label}" y="${barY + 11}" text-anchor="end">${esc(phase.label)}</text>`
    );

    if (width >= 2) {
      parts.push(
        `<rect x="${x0}" y="${barY}" width="${n(width)}" height="${barHeight}" rx="2" fill="${colour}" opacity="0.92" />`
      );
      if (width >= 46) {
        parts.push(
          `<text class="bar-value" x="${n(x1 - 6)}" y="${barY + 11}" text-anchor="end" fill="#06121d">${esc(formatMs(phase.ms))}</text>`
        );
      }
    } else {
      // Zero-duration phases still need to exist, or the chart lies by omission.
      parts.push(
        `<rect x="${x0}" y="${barY}" width="2.5" height="${barHeight}" rx="1" fill="${colour}" opacity="0.5" />`
      );
      parts.push(`<circle cx="${x0}" cy="${barY + barHeight / 2}" r="2.5" fill="${colour}" opacity="0.75" />`);
    }

    if (width >= 2 && width < 46) {
      const roomAfter = WATERFALL.width - WATERFALL.right - (x1 + 7);
      if (roomAfter > 48) {
        parts.push(`<text class="bar-value" x="${n(x1 + 7)}" y="${barY + 11}">${esc(formatMs(phase.ms))}</text>`);
      } else {
        parts.push(
          `<text class="bar-value" x="${n(x0 + 4)}" y="${barY + 11}" fill="#06121d">${esc(formatMs(phase.ms))}</text>`
        );
      }
    }

    parts.push(`</g>`);
  });

  // Axis.
  parts.push(`<line x1="${WATERFALL.left}" y1="${baseY}" x2="${WATERFALL.width - WATERFALL.right}" y2="${baseY}" stroke="#2b4a6a" stroke-width="1" />`);
  for (const tick of niceTicks(total)) {
    const tickX = n(x(tick));
    parts.push(`<line x1="${tickX}" y1="${baseY}" x2="${tickX}" y2="${baseY + 5}" stroke="#2b4a6a" stroke-width="1" />`);
    parts.push(`<text class="axis" x="${tickX}" y="${baseY + 19}" text-anchor="middle">${esc(tick === 0 ? '0' : formatMs(tick))}</text>`);
  }

  parts.push(playhead(baseY, [WATERFALL.top - 10]));
  parts.push('</svg>');
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* Space–time ladder                                                   */
/* ------------------------------------------------------------------ */

export function ladder(result) {
  const { phases, total, options } = result;
  const plotWidth = LADDER.width - LADDER.left - LADDER.right;
  const x = (ms) => LADDER.left + (total > 0 ? (ms / total) * plotWidth : 0);
  const baseY = LADDER.height - LADDER.axis;

  const parts = [];
  parts.push(
    `<svg viewBox="0 0 ${LADDER.width} ${LADDER.height}" width="${LADDER.width}" height="${LADDER.height}" role="img" ` +
      `aria-label="Space-time diagram: ${phases.length} phases over three lanes" ` +
      `data-plot-left="${LADDER.left}" data-plot-width="${plotWidth}" data-total="${total}">`
  );

  // Lanes.
  for (const [lane, y] of Object.entries(LANES)) {
    parts.push(`<line class="lane-line" x1="${LADDER.left}" y1="${y}" x2="${LADDER.width - LADDER.right}" y2="${y}" />`);
    parts.push(`<text class="lane-label" x="4" y="${y - 7}">${esc(lane)}</text>`);
  }

  // Numbered chips: the bridge between this diagram and the phase cards.
  let chipX = LADDER.left - 8;
  phases.forEach((phase, index) => {
    const colour = COLOURS[phase.kind] ?? COLOURS.paint;
    const cx = n(Math.min(LADDER.width - LADDER.right, Math.max(x(phase.start), chipX + 20)));
    chipX = cx;
    parts.push(
      `<g class="phase-group chip" ${phaseData(phase)} ${clickable(phase)}>` +
        `<circle cx="${cx}" cy="16" r="8" fill="${colour}" fill-opacity="0.16" stroke="${colour}" stroke-width="1" />` +
        `<text x="${cx}" y="19.5" text-anchor="middle" fill="${colour}" font-size="9.5">${index + 1}</text>` +
        `</g>`
    );
  });

  for (const phase of phases) {
    const colour = COLOURS[phase.kind] ?? COLOURS.paint;
    const x0 = n(x(phase.start));
    const x1 = n(x(phase.end));
    const width = x1 - x0;

    parts.push(`<g class="${phaseClass(phase)}" ${phaseData(phase)} ${clickable(phase)}>`);

    if (phase.ms <= 0) {
      const lane = LANES[phase.lane] ?? LANES.browser;
      parts.push(`<circle class="zero-dot" cx="${x0}" cy="${lane}" r="3" fill="${colour}" opacity="0.6" />`);
      parts.push(`</g>`);
      continue;
    }

    if (phase.shape === 'roundtrip' || phase.shape === 'request') {
      if (phase.id === 'request') {
        const half = options.rtt / 2;
        const down = n(x(phase.start + half));
        const hold = n(x(phase.start + half + options.serverMs));
        const end = n(x(phase.end));
        parts.push(
          `<path d="M${x0} ${LANES.browser} L${down} ${LANES.server} L${hold} ${LANES.server} L${end} ${LANES.browser}" ` +
            `fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" opacity="0.95" />`
        );
        parts.push(`<circle cx="${end}" cy="${LANES.browser}" r="2.6" fill="${colour}" />`);
        labelIfRoom(parts, 'Request', x0, end, LANES.server + 15, width, colour);
      } else {
        const target = phase.lane === 'resolver' ? LANES.resolver : LANES.server;
        const trips = Math.max(1, phase.rtts);
        const span = (x1 - x0) / trips;
        for (let trip = 0; trip < trips; trip += 1) {
          const startX = n(x0 + span * trip);
          const midX = n(x0 + span * (trip + 0.5));
          const endX = n(x0 + span * (trip + 1));
          parts.push(
            `<path d="M${startX} ${LANES.browser} L${midX} ${target} L${endX} ${LANES.browser}" ` +
              `fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" opacity="0.95" />`
          );
          parts.push(`<circle cx="${endX}" cy="${LANES.browser}" r="2.4" fill="${colour}" />`);
        }
        labelIfRoom(parts, SHORT[phase.id] ?? phase.label, x0, x1, target + 15, width, colour);
      }
    } else if (phase.shape === 'stream') {
      parts.push(
        `<path d="M${x0} ${LANES.server} L${x1} ${LANES.browser}" fill="none" stroke="${colour}" stroke-width="2.5" opacity="0.9" />`
      );
      parts.push(`<circle cx="${x1}" cy="${LANES.browser}" r="3" fill="${colour}" />`);
      parts.push(`<circle cx="${x0}" cy="${LANES.server}" r="2.4" fill="${colour}" opacity="0.8" />`);
      labelIfRoom(parts, SHORT[phase.id] ?? phase.label, x0, x1, LANES.server - 8, width, colour);
    } else {
      // paint: a bar on the browser lane, because nothing travels.
      const barY = LANES.browser - 4;
      parts.push(
        `<rect x="${x0}" y="${barY}" width="${n(Math.max(2, width))}" height="8" rx="2" fill="${colour}" opacity="0.9" />`
      );
      labelIfRoom(parts, SHORT[phase.id] ?? phase.label, x0, x1, LANES.browser - 12, width, colour);
    }

    parts.push(`</g>`);
  }

  // Axis.
  parts.push(`<line x1="${LADDER.left}" y1="${baseY}" x2="${LADDER.width - LADDER.right}" y2="${baseY}" stroke="#2b4a6a" stroke-width="1" />`);
  for (const tick of niceTicks(total)) {
    const tickX = n(x(tick));
    parts.push(`<line x1="${tickX}" y1="${baseY}" x2="${tickX}" y2="${baseY + 5}" stroke="#2b4a6a" stroke-width="1" />`);
    parts.push(`<text class="axis" x="${tickX}" y="${baseY + 19}" text-anchor="middle">${esc(tick === 0 ? '0' : formatMs(tick))}</text>`);
  }

  parts.push(playhead(baseY - 2, [LANES.browser, LANES.resolver, LANES.server]));
  parts.push('</svg>');
  return parts.join('');
}

function labelIfRoom(parts, text, x0, x1, y, width, colour) {
  if (width < 76) return;
  parts.push(
    `<text x="${n((x0 + x1) / 2)}" y="${y}" text-anchor="middle" fill="${colour}" font-size="9.5" opacity="0.85">${esc(text)}</text>`
  );
}

/** One playhead element per chart; hidden until the animation starts. */
function playhead(bottom, laneYs) {
  const dots = laneYs.map((y) => `<circle cx="0" cy="${y}" r="2.2" fill="#ffffff" opacity="0.9" />`).join('');
  return (
    `<g class="playhead-g" visibility="hidden">` +
    `<line class="playhead" x1="0" y1="6" x2="0" y2="${bottom}" />` +
    dots +
    `</g>`
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export function phaseCards(result) {
  const zeroLabel = { dns: 'cached', connect: 'reused', tls: 'reused', assets: 'none', paint: 'instant' };
  return result.phases
    .map((phase, index) => {
      const first = phase.rtts > 0
        ? `${phase.rtts} round trip${phase.rtts === 1 ? '' : 's'}`
        : phase.ms > 0
          ? 'no round trip'
          : zeroLabel[phase.id] ?? 'zero';
      const meta = [
        first,
        phase.bytes > 0 ? `${formatBytes(phase.bytes)} approx` : 'no bytes',
        `${formatMs(phase.start)} → ${formatMs(phase.end)}`,
      ];
      return (
        `<article class="phase-card" data-kind="${esc(phase.kind)}" data-phase="${esc(phase.id)}" ` +
        `data-start="${phase.start}" data-end="${phase.end}" tabindex="0">` +
        `<div class="phase-head">` +
        `<span class="phase-num">${index + 1}</span>` +
        `<h3 class="phase-title">${esc(phase.label)}</h3>` +
        `<span class="phase-ms">${esc(phase.ms === 0 ? '0 ms' : formatMs(phase.ms))}</span>` +
        `</div>` +
        `<div class="phase-meta">${meta.map((item) => `<span>${esc(item)}</span>`).join('')}</div>` +
        `<p class="phase-detail">${esc(phase.detail)}</p>` +
        `<p class="phase-note">${esc(phase.note)}</p>` +
        `</article>`
      );
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Preset comparison                                                   */
/* ------------------------------------------------------------------ */

/** `entries` is [{ preset, result }]; every bar shares the slowest total. */
export function compare(entries) {
  const scale = Math.max(...entries.map((entry) => entry.result.total), 1);

  const rows = entries
    .map(({ preset, result }) => {
      const segments = result.phases
        .filter((phase) => phase.ms > 0)
        .map((phase) => {
          const share = (phase.ms / scale) * 100;
          const colour = COLOURS[phase.kind] ?? COLOURS.paint;
          return `<span class="compare-seg" data-kind="${esc(phase.kind)}" style="width:${share.toFixed(3)}%;background:${colour}" title="${esc(phase.label)} · ${esc(formatMs(phase.ms))}"></span>`;
        })
        .join('');

      return (
        `<div class="compare-row">` +
        `<div class="compare-name">${esc(preset.label)}<small>${esc(preset.blurb)}</small></div>` +
        `<div class="compare-total">${esc(formatMs(result.total))}</div>` +
        `<div class="compare-bar" role="img" aria-label="${esc(`${preset.label}: ${formatMs(result.total)}`)}">${segments}</div>` +
        `</div>`
      );
    })
    .join('');

  const legend = Object.entries(KIND_LABELS)
    .map(([kind, label]) => `<span><i style="background:${COLOURS[kind]}"></i>${esc(label)}</span>`)
    .join('');

  return `${rows}<div class="legend">${legend}</div>`;
}
