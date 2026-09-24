#!/usr/bin/env node
// Grade one or more trace files. Exits non-zero when any criterion is violated, so a real agent
// run can be graded in a script. `--json` prints the full report for further analysis.
import { readFile } from 'node:fs/promises';
import { grade, formatReport } from './grade.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const only = args.filter(a => /^C\d\d$/.test(a));
const files = args.filter(a => !a.startsWith('--') && !/^C\d\d$/.test(a));

if (!files.length) {
  process.stderr.write('usage: node evals/src/cli.mjs <trace.jsonl> [more.jsonl] [C06 C14 …] [--json]\n');
  process.exit(2);
}

let violated = 0;
const reports = [];
for (const file of files) {
  let report;
  try { report = grade(await readFile(file, 'utf8'), only); }
  catch (error) {
    process.stderr.write(`${file}: ${error.message}\n`);
    process.exit(2);
  }
  violated += report.counts.violated;
  reports.push({ file, ...report });
  if (!json) process.stdout.write(`\n${file}\n${formatReport(report)}\n`);
}
if (json) process.stdout.write(JSON.stringify({ reports }, null, 2) + '\n');
process.exit(violated ? 1 : 0);
