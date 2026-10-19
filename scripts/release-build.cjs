// Dedicated fork packaging: never invokes the legacy package.json pkg scripts or SEA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nodeVersion = '22.23.2';
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function check() {
  assert.equal(process.version, `v${nodeVersion}`);
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_REPOSITORY, 'jenfonro/KuGouMusicApi');
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag');
  assert.match(process.env.GITHUB_REF || '', /^refs\/tags\/v\d+\.\d+\.\d+-songloft\.[1-9]\d*$/);
  const tag = process.env.GITHUB_REF.slice('refs/tags/'.length);
  assert.ok(tag.startsWith(`v${require('../package.json').version}-songloft.`));
  assert.equal(git('rev-parse', 'HEAD'), process.env.GITHUB_SHA);
  assert.equal(git('rev-parse', `${process.env.GITHUB_REF}^{commit}`), process.env.GITHUB_SHA);
  assert.match(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), /^lockfileVersion: '9\.0'/);
  git('diff', '--exit-code', 'HEAD');
  return { repository: process.env.GITHUB_REPOSITORY, tag, commit: process.env.GITHUB_SHA };
}

async function build() {
  const identity = check();
  if (process.argv[2] === '--check') return;
  process.chdir(root);
  const platform = { linux: 'linux', win32: 'win', darwin: 'macos' }[process.platform];
  assert.ok(platform, 'Unsupported platform');
  const toolRoot = path.join(root, 'tools/build/node_modules');
  const tool = (name) => path.join(toolRoot, name);
  assert.equal(require(tool('@yao-pkg/pkg/package.json')).version, '6.23.0');
  assert.equal(require(tool('@yao-pkg/pkg-fetch/package.json')).version, '3.6.6');
  assert.equal(require(tool('pnpm/package.json')).version, '10.34.7');
  const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  // These dependency-free vm mocks inspect the real report payload, not live accounts.
  run(['--test', 'tests/user_listen_report.test.js']);

  const out = path.join(root, 'dist/release');
  fs.mkdirSync(out, { recursive: true });
  assert.equal(fs.readdirSync(out).length, 0, 'Refuse to mix old and new build assets');
  process.env.PKG_CACHE_PATH = path.join(root, 'dist/pkg-cache');
  for (const key of ['PKG_NODE_PATH', 'PKG_IGNORE_TAG', 'PKG_EXECPATH']) delete process.env[key];
  // Fetch-only fails closed instead of silently compiling a different Node runtime.
  const base = await require(tool('@yao-pkg/pkg-fetch')).need({
    nodeRange: `node${nodeVersion}`, platform, arch: 'x64', forceFetch: true,
  });
  const asset = platform === 'win' ? 'app_win.exe' : `app_${platform}`;
  const target = `node${nodeVersion}-${platform}-x64`;
  const flags = [
    '.', '--targets', target, '--compress', 'GZip', '--no-bytecode',
    '--public', '--public-packages', '*', '--no-native-build', '--no-sea',
    '--output', path.join(out, asset),
  ];
  run([tool('@yao-pkg/pkg/lib-es5/bin.js'), ...flags]);
  const snapshot = require('./release-snapshot.cjs')(
    path.join(out, asset), base, path.join(root, 'module/user_listen_report.js'));
  const smokeFile = path.join(root, 'dist/smoke.json');
  run(['scripts/release-smoke.cjs', path.join(out, asset), smokeFile]);
  const notices = await require('./release-licenses.cjs')(platform, out);
  git('diff', '--exit-code', 'HEAD');
  const inputs = [
    'package.json', 'pnpm-lock.yaml', 'tools/build/package.json', 'tools/build/package-lock.json',
    'tests/user_listen_report.test.js', 'module/user_listen_report.js',
  ];
  const metadata = {
    ...identity, platform, arch: 'x64', target, packaging: 'pkg (not SEA)', node: nodeVersion,
    tools: { pkg: '6.23.0', pkgFetch: '3.6.6', pnpm: '10.34.7' },
    runner: { os: os.release(), image: process.env.ImageOS, imageVersion: process.env.ImageVersion },
    build: { run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
    base: { file: path.basename(base), sha256: sha256(base) },
    flags: flags.slice(0, -1).concat(asset),
    inputs: Object.fromEntries(inputs.map((file) => [file, sha256(path.join(root, file))])),
    sourceTest: { command: 'node --test tests/user_listen_report.test.js', result: 'passed' },
    snapshot,
    smoke: JSON.parse(fs.readFileSync(smokeFile, 'utf8')),
    binary: { name: asset, size: fs.statSync(path.join(out, asset)).size, sha256: sha256(path.join(out, asset)) },
    notices: { name: path.basename(notices), sha256: sha256(notices) },
  };
  fs.writeFileSync(path.join(out, `${asset}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`);
}

module.exports = { check, sha256, root, nodeVersion };
if (require.main === module) build().catch((error) => { console.error(error); process.exitCode = 1; });
