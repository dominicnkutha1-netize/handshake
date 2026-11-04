import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  LIMITS,
  normaliseOptions,
  transferMs,
  plan,
  describe,
  formatMs,
  formatBytes,
  toReport,
} from '../assets/journey.js';
import { PRESETS } from '../assets/presets.js';

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

const phase = (result, id) => result.phases.find((entry) => entry.id === id);

test('every default is inside its own limit', () => {
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    assert.ok(DEFAULTS[key] >= min && DEFAULTS[key] <= max, `${key} default is out of range`);
  }
});

test('normaliseOptions clamps numbers instead of trusting them', () => {
  const low = normaliseOptions({ rtt: -50, mbps: 0, assets: -3 });
  assert.equal(low.rtt, LIMITS.rtt[0]);
  assert.equal(low.mbps, LIMITS.mbps[0]);
  assert.equal(low.assets, 0);

  const high = normaliseOptions({ rtt: 99999, serverMs: 1e9, assets: 5000 });
  assert.equal(high.rtt, LIMITS.rtt[1]);
  assert.equal(high.serverMs, LIMITS.serverMs[1]);
  assert.equal(high.assets, LIMITS.assets[1]);
});

test('normaliseOptions ignores unknown enums and non-numeric junk', () => {
  const options = normaliseOptions({ dns: 'maybe', tls: '1.4', http: 'h4', rtt: 'fast', mbps: null });
  assert.equal(options.dns, DEFAULTS.dns);
  assert.equal(options.tls, DEFAULTS.tls);
  assert.equal(options.http, DEFAULTS.http);
  assert.equal(options.rtt, DEFAULTS.rtt);
  assert.equal(options.mbps, DEFAULTS.mbps);
});

test('the timeline is contiguous and the total is the sum of its phases', () => {
  const result = plan(baseline);
  let cursor = 0;
  for (const entry of result.phases) {
    assert.equal(entry.start, cursor, `${entry.id} starts at the wrong time`);
    assert.equal(entry.end - entry.start, entry.ms);
    cursor = entry.end;
  }
  assert.equal(result.total, cursor);
  assert.equal(result.total, result.phases.reduce((sum, entry) => sum + entry.ms, 0));
});

test('the seven phases exist for a normal page load', () => {
  assert.deepEqual(
    plan(baseline).phases.map((entry) => entry.id),
    ['dns', 'connect', 'tls', 'request', 'document', 'assets', 'paint']
  );
});

test('DNS costs three round trips cold, one cached at the resolver, none in the OS cache', () => {
  const cold = plan({ ...baseline, dns: 'cold' });
  const resolver = plan({ ...baseline, dns: 'resolver' });
  const os = plan({ ...baseline, dns: 'os' });

  assert.equal(phase(cold, 'dns').rtts, 3);
  assert.equal(phase(resolver, 'dns').rtts, 1);
  assert.equal(phase(os, 'dns').rtts, 0);
  assert.equal(phase(os, 'dns').ms, 0);
  assert.equal(phase(cold, 'dns').ms - phase(resolver, 'dns').ms, 2 * baseline.rtt);
});

test('TLS 1.3 costs one round trip and TLS 1.2 costs two', () => {
  assert.equal(phase(plan({ ...baseline, tls: '1.3' }), 'tls').rtts, 1);
  assert.equal(phase(plan({ ...baseline, tls: '1.2' }), 'tls').rtts, 2);

  const delta = plan({ ...baseline, tls: '1.2' }).total - plan({ ...baseline, tls: '1.3' }).total;
  assert.equal(delta, baseline.rtt);
});

test('HTTP/3 has no separate TLS phase and connects in one round trip', () => {
  const h3 = plan({ ...baseline, http: 'h3' });
  assert.equal(phase(h3, 'tls').ms, 0);
  assert.equal(phase(h3, 'tls').rtts, 0);
  assert.equal(phase(h3, 'connect').rtts, 1);

  const h2 = plan({ ...baseline, http: 'h2' });
  assert.equal(h2.total - h3.total, baseline.rtt, 'HTTP/3 should save exactly one round trip');
});

test('a reused connection pays for neither TCP nor TLS', () => {
  const reused = plan({ ...baseline, connection: 'reused' });
  assert.equal(phase(reused, 'connect').ms, 0);
  assert.equal(phase(reused, 'tls').ms, 0);
  assert.equal(reused.reused, true);
  assert.ok(reused.total < plan(baseline).total);
});

test('the request phase is one round trip plus the server think time', () => {
  const result = plan({ ...baseline, serverMs: 250 });
  assert.equal(phase(result, 'request').ms, baseline.rtt + 250);
  assert.equal(phase(result, 'request').rtts, 1);
});

test('server think time is added to the total exactly once per round trip', () => {
  const fast = plan({ ...baseline, serverMs: 10 });
  const slow = plan({ ...baseline, serverMs: 110 });
  // The document request and the single asset round both wait on the server.
  assert.equal(slow.total - fast.total, 200);
});

test('transfer time follows bandwidth, not round trips', () => {
  const fast = plan({ ...baseline, mbps: 100 });
  const slow = plan({ ...baseline, mbps: 10 });
  assert.ok(phase(slow, 'document').ms > phase(fast, 'document').ms * 8);
  assert.equal(phase(slow, 'document').rtts, 0);
});

test('a new connection pays a slow-start allowance a warm one does not', () => {
  const cold = plan({ ...baseline, connection: 'new' });
  const warm = plan({ ...baseline, connection: 'reused' });
  assert.equal(cold.slowStart, 1.4);
  assert.equal(warm.slowStart, 1.1);
  assert.ok(phase(cold, 'document').ms > phase(warm, 'document').ms);
});

test('HTTP/1.1 queues eight assets into two rounds, HTTP/2 does it in one', () => {
  const h1 = plan({ ...baseline, http: 'h1', assets: 8 });
  const h2 = plan({ ...baseline, http: 'h2', assets: 8 });

  assert.equal(h1.assetRounds, 2);
  assert.equal(h2.assetRounds, 1);
  assert.equal(phase(h1, 'assets').rtts, 2);
  assert.equal(phase(h2, 'assets').rtts, 1);
  assert.equal(phase(h1, 'assets').ms - phase(h2, 'assets').ms, baseline.rtt + baseline.serverMs);
});

test('twenty assets over HTTP/1.1 need four rounds, and HTTP/3 still needs one', () => {
  assert.equal(plan({ ...baseline, http: 'h1', assets: 20 }).assetRounds, 4);
  assert.equal(plan({ ...baseline, http: 'h3', assets: 20 }).assetRounds, 1);
  assert.equal(plan({ ...baseline, http: 'h2', assets: 40 }).assetRounds, 1);
});

test('no assets means no asset phase work and no asset bytes', () => {
  const result = plan({ ...baseline, assets: 0 });
  assert.equal(phase(result, 'assets').ms, 0);
  assert.equal(phase(result, 'assets').rtts, 0);
  assert.equal(phase(result, 'assets').bytes, 0);
  assert.match(phase(result, 'assets').label, /No subresources/);
});

test('asset bytes grow with the number and size of the assets', () => {
  const few = plan({ ...baseline, assets: 4, assetKb: 20 });
  const many = plan({ ...baseline, assets: 8, assetKb: 20 });
  const bigger = plan({ ...baseline, assets: 4, assetKb: 40 });

  assert.ok(phase(many, 'assets').bytes > phase(few, 'assets').bytes);
  assert.ok(phase(bigger, 'assets').bytes > phase(few, 'assets').bytes);
});

test('HTTP/2 request headers are smaller than HTTP/1.1 headers', () => {
  const h1 = plan({ ...baseline, http: 'h1' });
  const h2 = plan({ ...baseline, http: 'h2' });
  assert.ok(phase(h2, 'request').bytes < phase(h1, 'request').bytes);
});

test('the round-trip counter matches the work in the timeline', () => {
  const result = plan(baseline);
  assert.equal(result.rtts, result.phases.reduce((sum, entry) => sum + entry.rtts, 0));
  assert.equal(result.rtts, 1 + 1 + 1 + 1 + 1, 'dns, tcp, tls, request, one asset round');

  const h1 = plan({ ...baseline, http: 'h1', assets: 20 });
  assert.equal(h1.rtts, 1 + 1 + 1 + 1 + 4);
});

test('first byte is measured at the end of the request phase, not at the end of the page', () => {
  const result = plan(baseline);
  assert.equal(result.firstByteMs, phase(result, 'request').end);
  assert.ok(result.firstByteMs < result.total);
});

test('paint is the last phase and has no bytes', () => {
  const result = plan(baseline);
  const last = result.phases[result.phases.length - 1];
  assert.equal(last.id, 'paint');
  assert.equal(last.bytes, 0);
  assert.equal(last.end, result.total);
});

test('the insight names whichever phase dominates', () => {
  const setupHeavy = plan({ ...baseline, rtt: 400, mbps: 500, serverMs: 5, documentKb: 5, assets: 0, paintMs: 0 });
  assert.match(setupHeavy.insight, /before the server has written a single byte/);

  const transferHeavy = plan({ ...baseline, rtt: 5, mbps: 1, documentKb: 4000, assets: 0, paintMs: 0, serverMs: 0 });
  assert.match(transferHeavy.insight, /bandwidth is the limit/);

  const serverHeavy = plan({ ...baseline, rtt: 5, mbps: 500, documentKb: 5, assets: 0, paintMs: 0, serverMs: 900 });
  assert.match(serverHeavy.insight, /spent getting to the first byte/);
});

test('every phase explains itself and carries a caveat', () => {
  for (const entry of plan(baseline).phases) {
    assert.ok(entry.detail.length > 40, `${entry.id} has no real explanation`);
    assert.ok(entry.note.length > 30, `${entry.id} has no note`);
    assert.ok(entry.label.length > 2, `${entry.id} has no label`);
  }
});

test('the model is deterministic', () => {
  assert.deepEqual(plan(baseline), plan({ ...baseline }));
});

test('extreme but legal inputs stay finite and ordered', () => {
  const wild = plan({ rtt: 1000, serverMs: 5000, documentKb: 20000, assets: 200, assetKb: 5000, mbps: 0.5, paintMs: 2000 });
  assert.ok(Number.isFinite(wild.total));
  assert.ok(wild.total > 0);
  for (const entry of wild.phases) {
    assert.ok(Number.isFinite(entry.ms) && entry.ms >= 0, `${entry.id} is not finite`);
  }
  assert.equal(wild.total, wild.phases.reduce((sum, entry) => sum + entry.ms, 0));
});

test('describe reads like a settings line, not a debug dump', () => {
  const text = describe({ ...baseline, dns: 'cold' });
  assert.match(text, /40 ms RTT/);
  assert.match(text, /cold DNS/);
  assert.match(text, /TLS 1\.3/);
  assert.match(text, /HTTP\/2/);
  assert.doesNotMatch(text, /\[object|undefined|NaN/);
});

test('formatMs switches to seconds only when it helps', () => {
  assert.equal(formatMs(0), '<1 ms');
  assert.equal(formatMs(8), '8 ms');
  assert.equal(formatMs(999), '999 ms');
  assert.equal(formatMs(1000), '1.00 s');
  assert.equal(formatMs(1842), '1.84 s');
  assert.equal(formatMs(24000), '24.0 s');
  assert.equal(formatMs(NaN), '—');
});

test('formatBytes keeps the units honest', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('transferMs is linear in size and inverse in bandwidth', () => {
  // 1 KB is 1024 bytes here, so 1 KB at 8 Mbps is 1024 ms.
  assert.equal(transferMs(1000, 8), 1024);
  assert.equal(transferMs(2000, 8), 2048);
  assert.equal(transferMs(1000, 16), 512);
  assert.equal(transferMs(1000, 8, 1.5), 1536);
});

test('every preset produces a usable timeline', () => {
  for (const preset of PRESETS) {
    const result = plan(preset.options);
    assert.ok(result.total > 0, `${preset.id} has no duration`);
    assert.equal(result.total, result.phases.reduce((sum, entry) => sum + entry.ms, 0));
    assert.ok(result.phases.length >= 6, `${preset.id} is missing phases`);
    assert.ok(preset.blurb.length > 20, `${preset.id} has no blurb`);
  }
});

test('the warm revisit is faster than the cold visit on the same link', () => {
  const cold = plan(PRESETS.find((p) => p.id === 'cold').options);
  const warm = plan(PRESETS.find((p) => p.id === 'warm').options);
  assert.ok(warm.total < cold.total);
  assert.ok(warm.rtts < cold.rtts);
});

test('the legacy preset really is slower than the modern one', () => {
  const modern = plan({ ...PRESETS.find((p) => p.id === 'legacy').options, tls: '1.3', http: 'h2' });
  const legacy = plan(PRESETS.find((p) => p.id === 'legacy').options);
  assert.ok(legacy.total > modern.total);
  assert.ok(legacy.rtts > modern.rtts);
});

test('the report is plain text, aligned, and says it is a model', () => {
  const report = toReport(plan(baseline));
  assert.match(report, /HTTPS PAGE LOAD — MODEL/);
  assert.match(report, /TIMELINE/);
  assert.match(report, /TOTAL \d/);
  assert.match(report, /round trips/);
  assert.match(report, /not a measurement of a real one/);
  const timeline = report.split('\n').filter((line) => /^\s{2}\S/.test(line) && /RTT/.test(line));
  assert.ok(timeline.length >= 6, 'expected a line per phase');
  for (const line of timeline) {
    assert.equal(line.includes('undefined'), false);
    assert.equal(line.includes('NaN'), false);
  }
});
