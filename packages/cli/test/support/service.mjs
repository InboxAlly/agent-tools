// Test-only stand-in for the real placement service's two free-tier routes, shaped as the derived
// contract describes (docs/placement-service-contract.md). It answers through an injected fetch,
// so no socket is opened, and it can lose a response after acting on the request. Synthetic data
// only: every address is on a reserved example domain.

const SEEDS = Array.from({ length: 15 }, (_, i) => ({
  email: `seed${String(i + 1).padStart(2, '0')}@example.net`,
  provider: i < 6 ? 'gmail' : i < 11 ? 'outlook' : 'yahoo',
}));

export function fakeService({ now = () => Date.now() } = {}) {
  const tests = new Map();
  const calls = [];
  // loseCreates: act, then drop the connection. cutBody: 'create' or 'read' sends headers, then
  // breaks the body once. noDetectedAt: seen seeds carry no timestamp. bareRetry: a 429 without
  // Retry-After. detected: per-seed detection times by seed index, as providers report them out of
  // order. oversize: the next read's body is padded past the client's limit with multibyte text.
  // deadlines: the create response states the service's own deadlines, as after its split clocks.
  const controls = { loseCreates: 0, status: null, cutBody: null, noDetectedAt: false, bareRetry: false, detected: {}, oversize: false, summary: null, deadlines: false };
  let counter = 0;

  // The service's own figures, as the first live run showed them: junk counts as spam, missing
  // includes seeds not yet checked, and seeds it could not check leave the scored total.
  // controls.summary, if set, edits them to simulate a disagreeing or unfamiliar summary.
  const figures = test => {
    const of = s => test.placements[s.email] ?? null;
    const tally = seeds => ({ inbox: seeds.filter(s => of(s) === 'inbox').length, spam: seeds.filter(s => ['spam', 'junk'].includes(of(s))).length,
      missing: seeds.filter(s => [null, 'missing'].includes(of(s))).length, error: seeds.filter(s => of(s) === 'error').length });
    const rate = (part, whole) => whole ? Math.round((100 * part) / whole) : 0;
    const counts = tally(SEEDS);
    const scoredTotal = SEEDS.length - counts.error;
    const byProvider = ['gmail', 'outlook', 'yahoo'].map(provider => {
      const c = tally(SEEDS.filter(s => s.provider === provider));
      const total = c.inbox + c.spam + c.missing;
      return { provider, inbox: c.inbox, spam: c.spam, missing: c.missing, total, inboxRate: rate(c.inbox, total) };
    }).filter(p => p.total > 0);
    const figures = {
      verdict: { label: 'Mixed Delivery', subtitle: 'Synthetic subtitle.', level: 'warning', inboxRate: rate(counts.inbox, scoredTotal), deliveryRate: rate(counts.inbox + counts.spam, scoredTotal) },
      stats: { counts, scoredTotal, totalTesters: SEEDS.length, unreachable: counts.error, byProvider },
    };
    return controls.summary ? controls.summary(figures) : figures;
  };

  const results = test => ({
    testCode: test.testCode, uuid: test.uuid, emailAddress: test.emailAddress, status: test.status,
    totalSeeds: 15, foundCount: 0, missingCount: 0, overallScore: null,
    subject: test.fromEmail ? 'Synthetic subject' : null, fromEmail: test.fromEmail, fromDomain: test.fromEmail?.split('@')[1] ?? null,
    createdAt: test.createdAt, emailReceivedAt: test.emailReceivedAt, testWindowMinutes: 10,
    serverNow: new Date(now()).toISOString(),
    summary: {}, ...figures(test), freeMail: null,
    ...(controls.deadlines ? { sentinelWaitMinutes: 240, maxMeasurementMinutes: 60,
      expiresAt: test.emailReceivedAt ? null : new Date(Date.parse(test.createdAt) + 240 * 60000).toISOString() } : {}),
    rateLimit: controls.rateLimit !== undefined ? controls.rateLimit : test.status === 'rate_limited' ? { domain: test.fromEmail?.split('@')[1] ?? null, retryAfter: new Date(Date.parse(test.createdAt) + 86400000).toISOString(),
      retryAfterHours: 24, bypassHint: 'Add the access keyword to your subject.' } : null,
    seedAddresses: SEEDS.map(s => s.email),
    results: SEEDS.map(s => ({ provider: s.provider, seedEmail: s.email, placement: test.placements[s.email] ?? null,
      folder: null, latencyMs: null, auth: { spf: null, dkim: null, dmarc: null },
      detectedAt: !controls.noDetectedAt && test.placements[s.email] && test.placements[s.email] !== 'missing'
        ? controls.detected[SEEDS.indexOf(s)] ?? test.emailReceivedAt : null, scl: null, bcl: null })),
  });

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const cut = () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('connection reset')); } }), { status: 200 });

  async function fetch(url, init = {}) {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? 'GET', pathname, body: init.body ?? null, redirect: init.redirect });
    if (controls.status !== null && pathname !== '/api/generate-test') {
      const status = controls.status;
      if (status === 'network') throw new TypeError('fetch failed');
      return json(status, { detail: 'synthetic' }, status === 429 && !controls.bareRetry ? { 'retry-after': '30' } : {});
    }
    if (pathname === '/api/health') return json(200, { status: 'ok' });
    if (pathname === '/api/generate-test' && init.method === 'POST') {
      const { uuid } = JSON.parse(init.body);
      let test = tests.get(uuid);
      if (!test) {
        counter++;
        const testCode = `synthetic${counter}`;
        test = { uuid, testCode, emailAddress: `${testCode}@example.com`, status: 'pending',
          createdAt: new Date(now()).toISOString(), emailReceivedAt: null, fromEmail: null, placements: {} };
        tests.set(uuid, test);
      }
      if (controls.loseCreates > 0) { controls.loseCreates--; throw new TypeError('fetch failed'); }
      if (controls.cutBody === 'create') { controls.cutBody = null; return cut(); }
      const deadlines = controls.deadlines ? { sentinelWaitMinutes: 240, maxMeasurementMinutes: 60,
        expiresAt: test.emailReceivedAt ? null : new Date(Date.parse(test.createdAt) + 240 * 60000).toISOString() } : {};
      return json(200, { testCode: test.testCode, emailAddress: test.emailAddress, uuid: test.uuid, seedAddresses: SEEDS.map(s => s.email), status: test.status, ...deadlines });
    }
    const match = pathname.match(/^\/api\/results\/(.+)$/);
    if (match) {
      const code = decodeURIComponent(match[1]);
      const test = [...tests.values()].find(t => t.testCode === code);
      if (!test) return json(404, { detail: 'Test not found' });
      if (controls.cutBody === 'read') { controls.cutBody = null; return cut(); }
      // Under a million characters, but over a mebibyte once encoded.
      if (controls.oversize) { controls.oversize = false; return json(200, { ...results(test.latest ?? test), padding: 'é'.repeat(600000) }); }
      return json(200, results(test.latest ?? test));
    }
    return json(404, { detail: 'Not found' });
  }

  // Move a test along, as the service would.
  const arrive = (uuid, { from, placements = {}, status = 'processing' }) => {
    const test = tests.get(uuid);
    // The campaign arrives once; later calls only move the measurement along.
    Object.assign(test, { status, fromEmail: from, emailReceivedAt: test.emailReceivedAt ?? new Date(now()).toISOString(),
      placements: Object.fromEntries(SEEDS.map((s, i) => [s.email, placements[i] ?? null])) });
    return test;
  };

  return { fetch, tests, calls, controls, arrive, SEEDS };
}
