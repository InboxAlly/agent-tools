import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'inboxally-package-check-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check using npm run package:check.');
const env = { ...process.env };
delete env.INBOXALLY_API_KEY;
const npm = (args, cwd) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', env });
  if (result.error || result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
};

try {
  const pack = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, 'packages/cli')))[0];
  for (const file of pack.files) {
    assert.ok(file.path === 'package.json' || file.path === 'README.md' || file.path === 'LICENSE' || /^dist\/[a-z-]+\.(js|d\.ts)$/.test(file.path), `Unexpected packaged path: ${file.path}`);
  }
  assert.ok(pack.files.some(f => f.path === 'dist/index.js'));
  assert.ok(pack.files.some(f => f.path === 'LICENSE'), 'The published package must carry its license.');
  const installDir = join(temporary, 'install');
  await mkdir(installDir);
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'synthetic-package-check', private: true }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temporary, 'npm-cache'), join(temporary, pack.filename)], installDir);
  const metadata = JSON.parse(await readFile(join(installDir, 'node_modules/@inboxally/cli/package.json'), 'utf8'));
  assert.notEqual(metadata.private, true, 'The released package must be publishable.');
  assert.doesNotMatch(metadata.version, /-dev/, 'A released package carries a release version.');
  assert.equal(metadata.repository?.url, 'git+https://github.com/InboxAlly/agent-tools.git', 'Provenance needs the public repository.');
  assert.equal(metadata.bin.inboxally, 'dist/index.js');
  const version = npm(['exec', '--offline', '--', 'inboxally', '--version'], installDir).trim();
  assert.equal(version, metadata.version);
  assert.match(npm(['exec', '--offline', '--', 'inboxally', '--help'], installDir), /^InboxAlly CLI /);
  // Offline, so the package check never reaches the placement service: live is the default.
  const doctor = spawnSync(process.execPath, [join(installDir, 'node_modules/@inboxally/cli/dist/index.js'), 'doctor', '--json'], { encoding: 'utf8', env: { ...env, INBOXALLY_LIVE: '0' } });
  assert.equal(doctor.status, 6);
  assert.equal(JSON.parse(doctor.stdout).error.code, 'INTEGRATION_NOT_CONFIGURED');
  console.log(`Packed ${pack.files.length} intended files; clean install with an isolated cache, bin, version, help, and doctor verified.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
