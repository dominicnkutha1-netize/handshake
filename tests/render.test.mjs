import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../assets/journey.js';
import { PRESETS } from '../assets/presets.js';
import { COLOURS, KIND_LABELS, niceTicks, waterfall, ladder, phaseCards, compare } from '../assets/render.js';

const baseline = {
  rtt: 40,
  dns: 'resolver',
  connection: 'new',
  tls: '1.3',
  http: 'h2',
  serverMs: 60,
  documentKb: 180,
  assets: 8,
  assetKb: 25,
  mbps: 20,
  paintMs: 120,
};

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('niceTicks starts at zero, stays round and reaches the total', () => {
  for (const total of [484, 156, 4390, 9000, 73]) {
    const ticks = niceTicks(total);
    assert.equal(ticks[0], 0);
    assert.ok(ticks[ticks.length - 1] >= total - 0.001, `ticks for ${total} stop short`);
    assert.ok(ticks.length >= 3 && ticks.length <= 8, `ticks for ${total} are wrong: ${ticks}`);
    const step = ticks[1] - ticks[0];
    for (let index = 1; index < ticks.length - 1; index += 1) {
      assert.ok(Math.abs(ticks[index] - ticks[index - 1] - step) < 0.001, 'ticks are not evenly spaced');
    }
    assert.ok(ticks[ticks.length - 1] - ticks[ticks.length - 2] <= step + 0.001, 'the final tick overshoots');
  }
});

test('the waterfall has one labelled bar per phase and a shared time axis', () => {
  const result = plan(baseline);
  const svg = waterfall(result);
  assert.match(svg, /^<svg viewBox="0 0 960 \d+"/);
  assert.match(svg, new RegExp(`data-total="${result.total}"`));
  assert.equal(count(svg, '<g class="phase-group'), result.phases.length);
  for (const phase of result.phases) {
    assert.ok(svg.includes(`data-phase="${phase.id}"`), `${phase.id} is missing from the waterfall`);
    assert.ok(svg.includes(phase.label), `${phase.id} has no visible label`);
  }
  assert.equal(count(svg, 'class="playhead-g"'), 1);
  assert.equal(/undefined|NaN/.test(svg), false);
});

test('the waterfall keeps a zero-duration phase visible instead of hiding it', () => {
  const result = plan({ ...baseline, connection: 'reused' });
  const svg = waterfall(result);
  assert.equal(count(svg, '<g class="phase-group'), result.phases.length);
  assert.match(svg, /data-phase="connect"/);
});

test('every phase kind in the timeline has a colour and a legend label', () => {
  const result = plan(baseline);
  for (const phase of result.phases) {
    assert.ok(COLOURS[phase.kind], `${phase.kind} has no colour`);
  }
  for (const kind of Object.keys(KIND_LABELS)) {
    assert.ok(COLOURS[kind], `${kind} is in the legend but has no colour`);
    assert.ok(KIND_LABELS[kind].length > 2);
  }
});

test('the ladder draws three lanes, a chip per phase and a V per round trip', () => {
  const result = plan({ ...baseline, dns: 'cold' });
  const svg = ladder(result);
  for (const lane of ['browser', 'resolver', 'server']) {
    assert.ok(svg.includes(`>${lane}</text>`), `lane ${lane} is missing`);
  }
  assert.equal(count(svg, 'class="phase-group chip"'), result.phases.length);

  // DNS 3 + TCP 1 + TLS 1 are plain Vs; the request is a V with a hold; the
  // document and the assets are one-way transfers; the paint is a bar.
  const paths = count(svg, '<path');
  assert.equal(paths, 3 + 1 + 1 + 1 + 2);
  assert.match(svg, /data-phase="request"/);
  assert.match(svg, /data-phase="paint"/);
});

test('the ladder shows a cached phase as a dot, not an imaginary round trip', () => {
  const result = plan({ ...baseline, dns: 'os', connection: 'reused' });
  const svg = ladder(result);
  assert.ok(count(svg, 'class="zero-dot"') >= 3, 'expected dots for cached DNS and a reused connection');
  assert.equal(/undefined|NaN/.test(svg), false);
});

test('the phase cards carry the explanation, the caveat and the timing', () => {
  const result = plan(baseline);
  const html = phaseCards(result);
  assert.equal(count(html, '<article class="phase-card"'), result.phases.length);
  for (const phase of result.phases) {
    assert.ok(html.includes(`data-phase="${phase.id}"`), `${phase.id} card is missing`);
    assert.ok(html.includes(phase.detail.slice(0, 40)), `${phase.id} has no detail text`);
    assert.ok(html.includes(phase.note.slice(0, 30)), `${phase.id} has no caveat`);
    assert.ok(html.includes(`data-start="${phase.start}"`));
  }
  assert.equal(/undefined|NaN/.test(html), false);
});

test('zero phases say zero, not "<1 ms"', () => {
  const result = plan({ ...baseline, connection: 'reused', assets: 0 });
  const html = phaseCards(result);
  assert.match(html, /<span class="phase-ms">0 ms<\/span>/);
  assert.match(html, /reused/);
});

test('the comparison is scaled to the slowest preset and adds up per row', () => {
  const entries = PRESETS.map((preset) => ({ preset, result: plan(preset.options) }));
  const html = compare(entries);
  assert.equal(count(html, 'class="compare-row"'), PRESETS.length);
  assert.equal(count(html, 'class="compare-seg"'), entries.reduce(
    (sum, entry) => sum + entry.result.phases.filter((phase) => phase.ms > 0).length,
    0
  ));

  const slowest = Math.max(...entries.map((entry) => entry.result.total));
  const rows = html.split('class="compare-row"').slice(1);
  assert.equal(rows.length, PRESETS.length);

  rows.forEach((row, index) => {
    const entry = entries[index];
    const widths = [...row.matchAll(/style="width:([\d.]+)%;/g)].map((match) => Number(match[1]));
    assert.ok(widths.length > 0, `${entry.preset.id} has no bar segments`);
    const expected = (entry.result.total / slowest) * 100;
    const rowWidth = widths.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(rowWidth - expected) < 1.5, `${entry.preset.id} bars do not add to its total`);
  });
  assert.equal(count(html, 'class="legend"'), 1);
});

test('the drawings are deterministic', () => {
  const first = plan(baseline);
  const second = plan({ ...baseline });
  assert.equal(waterfall(first), waterfall(second));
  assert.equal(ladder(first), ladder(second));
  assert.equal(phaseCards(first), phaseCards(second));
});

test('extreme legal inputs never produce broken markup', () => {
  const result = plan({
    rtt: 1000,
    dns: 'cold',
    connection: 'new',
    tls: '1.2',
    http: 'h1',
    serverMs: 5000,
    documentKb: 20000,
    assets: 200,
    assetKb: 5000,
    mbps: 0.5,
    paintMs: 2000,
  });
  for (const markup of [waterfall(result), ladder(result), phaseCards(result), compare([{ preset: PRESETS[0], result }])]) {
    assert.equal(/undefined|NaN|Infinity/.test(markup), false);
  }
});
