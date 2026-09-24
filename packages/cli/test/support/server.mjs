import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { manifest, resultSnapshot } from './fixtures.mjs';
import { CliError } from '../../dist/errors.js';

// Test-only stand-in for the placement service. It models what the deployed service does:
// creation mints run identity and reserves no allowance, so a lost response leaves an unnamed
// test rather than a reservation to recover. `allowance` models a generic server-side refusal,
// not the real per-domain daily limit, which is applied after the campaign arrives.
// This server is excluded from the npm artifact.
export async function fixtureServer({ loseFirstResponse = false, loseFirstReadResponse = false, allowance = 1, stages = ['awaiting', 'partial', 'complete'] } = {}) {
  const records = new Map();
  // Sending domains whose free test has been spent: a campaign reached one of their tests.
  const spent = new Set();
  const domainOf = address => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  const metrics = { requests: 0, allocations: 0, charges: 0, reads: 0 };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/fixture/results/')) {
        metrics.reads++;
        const testId = decodeURIComponent(req.url.slice('/fixture/results/'.length));
        const record = [...records.values()].find(r => r.test.test_id === testId);
        if (!record) { res.writeHead(404).end(); return; }
        if (loseFirstReadResponse) { loseFirstReadResponse = false; req.socket.destroy(); return; }
        const stage = stages[Math.min(record.resultIndex, stages.length - 1)] ?? 'awaiting';
        record.resultIndex++;
        const snapshot = resultSnapshot(record.test, stage);
        if (snapshot.received_count > 0) spent.add(domainOf(record.test.expected_from));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
        return;
      }
      if (req.url !== '/fixture/create' || req.method !== 'POST') { res.writeHead(404).end(); return; }
      metrics.requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (metrics.allocations >= allowance) { res.writeHead(429).end(); return; }
      // Identity is minted here, not proposed by the caller.
      const test = await manifest();
      test.run_uuid = randomUUID();
      test.test_id = `pt_fixture_${randomUUID()}`;
      test.list_name = `SYNTHETIC InboxAlly Placement Test ${test.test_id}`;
      test.report_url = `https://reports.example.com/placement/${test.test_id}`;
      test.expected_from = body.expected_from;
      // Creation spends nothing, but a domain that already spent today's test shows it spent.
      if (spent.has(domainOf(body.expected_from))) test.quota = { ...test.quota, remaining: 0 };
      test.sending_platform = body.sending_platform;
      const record = { body, test, resultIndex: 0 };
      records.set(test.run_uuid, record);
      metrics.allocations++;
      metrics.charges++;
      if (loseFirstResponse) { loseFirstResponse = false; req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record.test));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const api = {
    environment: 'mock', reportOrigins: ['https://reports.example.com'],
    assertAvailable() {},
    async get(testId, signal) {
      let response;
      try {
        response = await fetch('http://127.0.0.1:' + address.port + '/fixture/results/' + encodeURIComponent(testId), {
          redirect: 'error', signal: signal ?? AbortSignal.timeout(2000),
        });
      } catch { throw new CliError('NETWORK_ERROR', 'Synthetic result connection loss.', 6, true); }
      if (!response.ok) throw new CliError('TEST_NOT_FOUND', 'Synthetic test is unavailable.', 2);
      return response.json();
    },
    async create(body) {
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${address.port}/fixture/create`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } catch { throw new CliError('ALLOCATION_UNKNOWN', 'Synthetic connection loss. A test may exist that this client cannot name.', 6, true); }
      if (response.status === 429) throw new CliError('FREE_DAILY_LIMIT_REACHED', 'Synthetic allowance exhausted.', 4);
      if (!response.ok) throw new CliError('SERVICE_UNAVAILABLE', 'Synthetic service failure.', 6);
      return response.json();
    },
  };
  return { api, metrics, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
