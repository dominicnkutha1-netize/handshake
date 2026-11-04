/**
 * Four scenarios worth comparing, and the honest one-line reason each exists.
 *
 * They are not "good" and "bad" configurations: the legacy stack is what a
 * great many real sites still run, and the 4G preset is what most people
 * actually hold in their hand.
 */

export const PRESETS = [
  {
    id: 'cold',
    label: 'Cold visit, fibre',
    blurb: 'First visit to a site: nothing cached, new connection, modern stack.',
    options: {
      rtt: 15,
      dns: 'cold',
      connection: 'new',
      tls: '1.3',
      http: 'h2',
      serverMs: 40,
      documentKb: 180,
      assets: 20,
      assetKb: 30,
      mbps: 50,
      paintMs: 120,
    },
  },
  {
    id: 'warm',
    label: 'Warm revisit',
    blurb: 'The same site, a minute later: DNS cached, connection still open.',
    options: {
      rtt: 15,
      dns: 'os',
      connection: 'reused',
      tls: '1.3',
      http: 'h2',
      serverMs: 40,
      documentKb: 60,
      assets: 0,
      assetKb: 30,
      mbps: 50,
      paintMs: 90,
    },
  },
  {
    id: 'mobile',
    label: 'Mobile 4G',
    blurb: 'A phone on a good mobile network: high latency, modest bandwidth.',
    options: {
      rtt: 120,
      dns: 'cold',
      connection: 'new',
      tls: '1.3',
      http: 'h2',
      serverMs: 220,
      documentKb: 220,
      assets: 30,
      assetKb: 40,
      mbps: 6,
      paintMs: 400,
    },
  },
  {
    id: 'legacy',
    label: 'Legacy stack',
    blurb: 'TLS 1.2 and HTTP/1.1, the combination a lot of internal tools still ship.',
    options: {
      rtt: 60,
      dns: 'resolver',
      connection: 'new',
      tls: '1.2',
      http: 'h1',
      serverMs: 120,
      documentKb: 200,
      assets: 20,
      assetKb: 30,
      mbps: 10,
      paintMs: 250,
    },
  },
];

export const DEFAULT_PRESET = 'cold';
