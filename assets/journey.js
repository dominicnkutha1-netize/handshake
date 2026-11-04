/**
 * The page-load model.
 *
 * This is a model, not a measurement. Nothing here opens a connection: it
 * computes what a page load *should* cost from a small set of quantities that
 * are easy to observe (round-trip time, bandwidth, server think time) and a
 * handful of protocol facts that are not opinions (TLS 1.3 needs one round
 * trip, TLS 1.2 needs two; DNS is cached or it is not).
 *
 * Pure functions, no DOM, no clock, no randomness: the same options always
 * produce the same timeline, which is what makes the numbers on the page worth
 * arguing about in a code review.
 */

export const DEFAULTS = Object.freeze({
  rtt: 40,            // ms, one network round trip
  dns: 'resolver',    // 'os' | 'resolver' | 'cold'
  connection: 'new',  // 'new' | 'reused'
  tls: '1.3',         // '1.3' | '1.2'
  http: 'h2',         // 'h1' | 'h2' | 'h3'
  serverMs: 60,       // ms the server spends before the first byte
  documentKb: 180,    // size of the HTML document
  assets: 8,          // number of subresources (scripts, CSS, images)
  assetKb: 25,        // average size of one subresource
  mbps: 20,           // downstream bandwidth
  paintMs: 120,       // parse + layout + first paint, an estimate
});

export const LIMITS = Object.freeze({
  rtt: [1, 1000],
  serverMs: [0, 5000],
  documentKb: [1, 20000],
  assets: [0, 200],
  assetKb: [1, 5000],
  mbps: [0.5, 1000],
  paintMs: [0, 2000],
});

const ENUMS = {
  dns: ['os', 'resolver', 'cold'],
  connection: ['new', 'reused'],
  tls: ['1.3', '1.2'],
  http: ['h1', 'h2', 'h3'],
};

/** Bytes on the wire, roughly. Labelled "approx" wherever it is shown. */
const BYTES = {
  dnsQuery: 90,
  dnsExtra: 40,      // per additional round trip of the cold path
  tcp: 130,
  quic: 1400,        // QUIC + TLS 1.3 crypto in the handshake
  tls13: 3000,       // certificates dominate
  tls12: 5200,
  requestHeaders: { h1: 780, h2: 210, h3: 190 },
  responseHeaders: 300,
  assetOverhead: 300,
};

/** Browsers open up to six connections per host for HTTP/1.1; streams for h2/h3. */
const CONCURRENCY = { h1: 6, h2: 100, h3: 100 };

export function normaliseOptions(input = {}) {
  const options = { ...DEFAULTS };

  for (const [key, raw] of Object.entries(input ?? {})) {
    if (key in LIMITS) {
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const [min, max] = LIMITS[key];
      const clamped = Math.min(max, Math.max(min, value));
      // One decimal is enough for a slider and keeps the report stable.
      options[key] = Math.round(clamped * 10) / 10;
    } else if (key in ENUMS) {
      const value = String(raw);
      if (ENUMS[key].includes(value)) options[key] = value;
    }
  }

  options.assets = Math.round(options.assets);
  return options;
}

/** ms to move `kb` over `mbps`, with an allowance for TCP slow start. */
export function transferMs(kb, mbps, slowStart = 1) {
  const bits = kb * 1024 * 8;
  const seconds = bits / (mbps * 1e6);
  return Math.round(seconds * 1000 * slowStart);
}

function roundTripMs(rtt) {
  return Math.round(rtt);
}

/**
 * Build the timeline.
 *
 * Every phase carries the sentence that explains it and the caveat that stops
 * it being over-read, because the numbers are the easy part and the meaning is
 * the point.
 */
export function plan(input = {}) {
  const options = normaliseOptions(input);
  const { rtt, serverMs, http } = options;

  const reused = options.connection === 'reused';
  const quic = http === 'h3';
  const slowStart = reused ? 1.1 : 1.4;

  const dnsRtts = { os: 0, resolver: 1, cold: 3 }[options.dns];
  const connectRtts = reused ? 0 : 1;
  const tlsRtts = reused || quic ? 0 : options.tls === '1.3' ? 1 : 2;
  const concurrency = CONCURRENCY[http];
  const assetRounds = options.assets > 0 ? Math.ceil(options.assets / concurrency) : 0;

  const phases = [];
  let cursor = 0;

  const add = ({ id, kind, lane, label, ms, rtts = 0, bytes = 0, shape = 'roundtrip', detail, note }) => {
    const duration = Math.max(0, Math.round(ms));
    phases.push({
      id,
      kind,
      lane,
      label,
      shape,
      ms: duration,
      rtts,
      bytes,
      detail,
      note,
      start: cursor,
      end: cursor + duration,
    });
    cursor += duration;
  };

  add({
    id: 'dns',
    kind: 'dns',
    lane: 'resolver',
    label: 'DNS lookup',
    ms: dnsRtts * rtt,
    rtts: dnsRtts,
    bytes: dnsRtts === 0 ? 0 : BYTES.dnsQuery + (dnsRtts - 1) * BYTES.dnsExtra,
    shape: 'roundtrip',
    detail: {
      os: 'The name was resolved moments ago, so the operating system cache answers without a packet leaving the machine. This is the difference between a first visit and a reload.',
      resolver: 'One round trip to the resolver. The answer is cached there but not on this machine, so the lookup is cheap, not free.',
      cold: 'Three round trips: the root servers, then the TLD servers, then the domain\u2019s authoritative server. This is the full cold path, and the reason DNS TTLs are worth caring about.',
    }[options.dns],
    note: {
      os: 'Cached DNS is why the second visit to a site feels different from the first.',
      resolver: 'Your ISP or public resolver usually has the answer cached. That is the normal case.',
      cold: 'A cold lookup is a fixed cost paid once per TTL window, not once per request.',
    }[options.dns],
  });

  add({
    id: 'connect',
    kind: 'connect',
    lane: 'server',
    label: quic ? 'QUIC connect' : 'TCP connect',
    ms: connectRtts * rtt,
    rtts: connectRtts,
    bytes: connectRtts === 0 ? 0 : quic ? BYTES.quic : BYTES.tcp,
    shape: 'roundtrip',
    detail: reused
      ? 'The connection is already open, so there is nothing to set up. This is what keep-alive buys on a second request.'
      : quic
        ? 'QUIC combines the transport handshake and the TLS 1.3 handshake in one flight. There is no separate TLS step afterwards.'
        : 'SYN, SYN-ACK, ACK: one full round trip before a single byte of the request can be sent. On a 40 ms link that is 40 ms of complete silence.',
    note: reused
      ? 'Connection reuse removes this cost entirely, which is why connection pools exist.'
      : quic
        ? 'HTTP/3 pays for security once, inside the transport handshake.'
        : 'This cost is per connection, not per request, which is why HTTP/2 multiplexes over one.',
  });

  add({
    id: 'tls',
    kind: 'tls',
    lane: 'server',
    label: 'TLS handshake',
    ms: tlsRtts * rtt,
    rtts: tlsRtts,
    bytes: tlsRtts === 0 ? 0 : options.tls === '1.3' ? BYTES.tls13 : BYTES.tls12,
    shape: 'roundtrip',
    detail: quic
      ? 'Encryption is part of the QUIC handshake in the previous step, so there is no second handshake here.'
      : reused
        ? 'The connection was already encrypted, so the session continues without a new handshake.'
        : options.tls === '1.3'
          ? 'TLS 1.3 needs one round trip: the client guesses the key-exchange parameters and the server confirms them in the same flight. The certificate arrives encrypted.'
          : 'TLS 1.2 needs two round trips, and the certificate travels in the clear. This is the entire timing difference between the versions on a fresh connection.',
    note: quic
      ? 'HTTP/3 folds this into the transport, which is where its one-round-trip advantage comes from.'
      : reused
        ? 'Session resumption and keep-alive both exist to avoid paying this twice.'
        : 'Certificate size is why TLS costs more bytes than a TCP handshake, even at the same round-trip count.',
  });

  add({
    id: 'request',
    kind: 'request',
    lane: 'server',
    label: 'Request \u2192 first byte',
    ms: roundTripMs(rtt) + serverMs,
    rtts: 1,
    bytes: BYTES.requestHeaders[http] + 60 + BYTES.responseHeaders,
    shape: 'request',
    detail: `The request travels to the server (half a round trip), the server does its work (${serverMs} ms of think time), and the first byte comes back (half a round trip). Round trips are latency; server time is somebody else's code.`,
    note: 'This is the number people mean by "the server is slow". It is the only phase a front-end change cannot fix.',
  });

  const documentMs = transferMs(options.documentKb, options.mbps, slowStart);
  add({
    id: 'document',
    kind: 'transfer',
    lane: 'browser',
    label: 'Download document',
    ms: documentMs,
    rtts: 0,
    bytes: options.documentKb * 1024 + BYTES.responseHeaders,
    shape: 'stream',
    detail: `The response body at ${options.mbps} Mbps, with a slow-start allowance because a new TCP connection cannot use the whole pipe immediately.`,
    note: 'On a fast link this is short. On a slow one it competes with every other byte on the connection.',
  });

  const assetTotalKb = options.assets * options.assetKb;
  const assetMs = assetRounds === 0 ? 0 : assetRounds * (rtt + serverMs) + transferMs(assetTotalKb, options.mbps, slowStart);
  add({
    id: 'assets',
    kind: 'assets',
    lane: 'browser',
    label: options.assets === 0 ? 'No subresources' : `${options.assets} subresource${options.assets === 1 ? '' : 's'}`,
    ms: assetMs,
    rtts: assetRounds,
    bytes: options.assets === 0 ? 0 : options.assets * (options.assetKb * 1024 + BYTES.requestHeaders[http] + BYTES.assetOverhead),
    shape: 'stream',
    detail: options.assets === 0
      ? 'Nothing else to fetch, so the page is just its document.'
      : `${options.assets} extra requests, ${concurrency} at a time over ${http === 'h1' ? 'separate connections (HTTP/1.1 cannot multiplex)' : 'one multiplexed connection'}. That is ${assetRounds} round${assetRounds === 1 ? '' : 's'} of request-and-response before the last byte.`,
    note: options.assets === 0
      ? 'Removing requests is the cheapest optimisation there is: a request that is never made costs nothing.'
      : http === 'h1'
        ? 'HTTP/1.1 queues requests per connection, so assets arrive in waves. Bundling or upgrading to HTTP/2 removes the waves.'
        : 'Multiplexing is why HTTP/2 and HTTP/3 win on asset-heavy pages: the round trips do not stack up.',
  });

  add({
    id: 'paint',
    kind: 'paint',
    lane: 'browser',
    label: 'Parse and first paint',
    ms: options.paintMs,
    rtts: 0,
    bytes: 0,
    shape: 'bar',
    detail: 'Parsing, layout and the first paint. This is the roughest number here: it depends on the device, the JavaScript on the page and what counts as "painted".',
    note: 'Everything above is network. This is where the device finally gets to do some work.',
  });

  const total = phases.reduce((sum, phase) => sum + phase.ms, 0);
  const rtts = phases.reduce((sum, phase) => sum + phase.rtts, 0);
  const bytes = phases.reduce((sum, phase) => sum + phase.bytes, 0);
  const setupMs = phases.filter((p) => ['dns', 'connect', 'tls'].includes(p.id)).reduce((s, p) => s + p.ms, 0);
  const firstByteMs = phases.find((p) => p.id === 'request')?.end ?? 0;
  const transferMsTotal = phases.filter((p) => p.id === 'document' || p.id === 'assets').reduce((s, p) => s + p.ms, 0);

  return {
    options,
    phases,
    total,
    rtts,
    bytes,
    setupMs,
    firstByteMs,
    transferMs: transferMsTotal,
    slowStart,
    quic,
    reused,
    assetRounds,
    concurrency,
    insight: insightFor({
      total,
      setupMs,
      transferMs: transferMsTotal,
      firstByteMs,
      paintMs: phases.find((p) => p.id === 'paint')?.ms ?? 0,
      rtts,
    }),
  };
}

/** One sentence that names the dominant cost, so the page says something. */
function insightFor({ total, setupMs, transferMs, firstByteMs, paintMs, rtts }) {
  if (total === 0) return 'Nothing to do: every phase is free in this configuration.';

  const share = (value) => Math.round((value / total) * 100);

  if (setupMs / total >= 0.5) {
    return `${share(setupMs)}% of this happens before the server has written a single byte: it is connection set-up, not a slow page. That percentage is why keep-alive and HTTP/3 matter.`;
  }
  if (transferMs / total >= 0.5) {
    return `${share(transferMs)}% is moving bytes, so bandwidth is the limit here. More latency would barely change it; a smaller page would.`;
  }
  if (firstByteMs / total >= 0.6) {
    return `${share(firstByteMs)}% is spent getting to the first byte. The network is fine; the waiting is at the other end.`;
  }
  if (paintMs / total >= 0.5) {
    return `${share(paintMs)}% is the device parsing and painting, not the network. Here the round trips are already paid for; the page itself is the cost.`;
  }
  return `${rtts} round trips, and no single phase dominates. This is what a page load looks like when nothing is obviously wrong.`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 100 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LABEL_HTTP = { h1: 'HTTP/1.1', h2: 'HTTP/2', h3: 'HTTP/3' };
const LABEL_DNS = { os: 'DNS cached by the OS', resolver: 'DNS cached by the resolver', cold: 'cold DNS' };

export function describe(options) {
  const o = normaliseOptions(options);
  return [
    `${o.rtt} ms RTT`,
    LABEL_DNS[o.dns],
    o.connection === 'new' ? 'new connection' : 'reused connection',
    `TLS ${o.tls}`,
    LABEL_HTTP[o.http],
    `${o.assets} assets`,
    `${o.mbps} Mbps`,
  ].join(' \u00b7 ');
}

/** Plain text for a ticket or a post. Screenshots do not paste. */
export function toReport(result) {
  const { options, phases, total, rtts, bytes } = result;
  const lines = [];
  const pad = (value, width) => String(value).padEnd(width);

  lines.push('HTTPS PAGE LOAD \u2014 MODEL');
  lines.push('===========================');
  lines.push('');
  lines.push(`Settings: ${describe(options)}`);
  lines.push('');
  lines.push('TIMELINE');
  for (const phase of phases) {
    lines.push(
      `  ${pad(formatMs(phase.start), 9)}${pad(phase.label, 26)}${pad(formatMs(phase.ms), 9)}${pad(`${phase.rtts} RTT`, 8)}${formatBytes(phase.bytes)}`
    );
  }
  lines.push('');
  lines.push(`TOTAL ${formatMs(total)} \u00b7 ${rtts} round trips \u00b7 ${formatBytes(bytes)} on the wire (approx)`);
  lines.push('');
  lines.push('WHAT DOMINATES');
  lines.push(`  ${result.insight}`);
  lines.push('');
  lines.push('This is a model of a page load, not a measurement of a real one. It counts');
  lines.push('protocol round trips and transfers at the stated bandwidth; it does not');
  lines.push('observe your network, your device or the server.');
  return lines.join('\n');
}
