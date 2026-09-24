// A trace is the observable record of one agent run: what it was told, what it invoked, what
// the sending platform and the placement API did, and what it asserted to the user. The skill's
// behaviour is graded from these events, never from its prose — a correct-sounding sentence is
// not evidence, and an assertion that needs one is not a test.

export const eventKinds = ['context', 'user', 'cli', 'api', 'platform', 'claim', 'restart'];
export const modes = ['cli', 'api'];
// Operations the agent performs on the user's sending platform.
export const platformOps = [
  'enumerate_lists', 'create_list', 'import_contacts', 'enumerate_members',
  'send_campaign', 'send_test_email', 'inspect_campaign', 'delete_list',
];
export const outcomes = ['ok', 'timeout', 'error', 'ambiguous'];
export const mutatingOps = new Set(['create_list', 'import_contacts', 'delete_list']);

class TraceError extends Error {}

function check(condition, seq, detail) {
  if (!condition) throw new TraceError(`line ${seq}: ${detail}`);
}

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.length > 0;

// Each event is validated on the way in. A malformed trace is rejected rather than graded,
// because a grader that silently ignores what it cannot parse reports false confidence.
function validate(event, index) {
  const line = index + 1;
  check(isObject(event), line, 'each line must be a JSON object');
  check(eventKinds.includes(event.kind), line, `unknown kind ${JSON.stringify(event.kind)}`);
  if (index === 0) {
    check(event.kind === 'context', line, 'the first line must be the context');
    check(modes.includes(event.mode), line, `mode must be one of ${modes.join(', ')}`);
    for (const key of ['domain', 'sender', 'list_name', 'test_code']) check(isText(event[key]), line, `context.${key} is required`);
    return event;
  }
  check(event.kind !== 'context', line, 'context may appear only once, as the first line');
  switch (event.kind) {
    case 'user':
      check(isText(event.text), line, 'user.text is required');
      if (event.approves !== undefined) check(['import', 'send'].includes(event.approves), line, 'user.approves must be import or send');
      if (event.skips !== undefined) check(event.skips === 'verify', line, 'user.skips must be verify');
      if (event.pastes !== undefined) check(event.pastes === 'recipients', line, 'user.pastes must be recipients');
      if (event.identifies !== undefined) check(['maintainer', 'development'].includes(event.identifies), line, 'user.identifies must be maintainer or development');
      break;
    case 'cli':
      check(Array.isArray(event.argv) && event.argv.every(isText), line, 'cli.argv must be non-empty strings');
      check(Number.isInteger(event.exit), line, 'cli.exit must be an integer');
      break;
    case 'api':
      check(isText(event.op), line, 'api.op is required');
      break;
    case 'platform':
      check(platformOps.includes(event.op), line, `unknown platform op ${JSON.stringify(event.op)}`);
      check(outcomes.includes(event.outcome), line, `platform.outcome must be one of ${outcomes.join(', ')}`);
      break;
    case 'claim':
      check(isText(event.about), line, 'claim.about is required');
      if (event.about === 'availability') check(typeof event.data?.maintainer_routes === 'boolean', line, 'an availability claim needs a boolean data.maintainer_routes');
      check(isObject(event.data), line, 'claim.data must be an object');
      break;
    case 'restart':
      check(isText(event.reason), line, 'restart.reason is required');
      break;
  }
  return event;
}

export function parseTrace(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new TraceError('the trace is empty');
  const events = lines.map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { throw new TraceError(`line ${index + 1}: is not valid JSON`); }
    return { ...validate(parsed, index), seq: index + 1 };
  });
  return { context: events[0], events: events.slice(1) };
}

// Helpers the criteria share, so each rule states its own condition and nothing else.
export const platformCalls = (events, op) => events.filter(e => e.kind === 'platform' && e.op === op);
// A flag's value, written either as `--name value` or as `--name=value`; the CLI accepts both.
export const flag = (argv, name) => {
  const joined = argv.find(a => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
export const noteEvents = events => events
  .filter(e => e.kind === 'cli' && e.argv[0] === 'placement' && e.argv[1] === 'note' && e.exit === 0)
  .map(e => ({ seq: e.seq, event: flag(e.argv, 'event'), evidence: flag(e.argv, 'evidence') }));
export const before = (events, seq) => events.filter(e => e.seq < seq);
export const after = (events, seq) => events.filter(e => e.seq > seq);
// The measurement a claim can be judged against is the most recent read *before* it. Judging a
// claim against a later read would excuse describing results the agent had not yet seen.
export const resultBefore = (events, seq = Infinity) => {
  // The real CLI wraps its output in a `cli.v1` envelope with the result under `data.test`. A
  // failed read carries no result — though a watch that ended early still carries the last one —
  // and is not a measurement, so it cannot stand in for an earlier read that was.
  const measurement = e => {
    const raw = e.kind === 'cli' ? e.stdout : e.response;
    if (!raw) return undefined;
    // A watch that failed before its first read carries the allocation, which has no status.
    if (raw.schema_version === 'cli.v1') return typeof raw.data?.test?.status === 'string' ? raw.data.test : undefined;
    return raw.test ?? raw;
  };
  const reads = events.filter(e => e.seq < seq && measurement(e) && (
    (e.kind === 'cli' && ['status', 'watch'].includes(e.argv[1])) ||
    (e.kind === 'api' && ['status', 'results'].includes(e.op))));
  const last = reads[reads.length - 1];
  return last && { seq: last.seq, body: measurement(last) };
};
