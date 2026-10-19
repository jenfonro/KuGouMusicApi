// Only this job has a write token. A failed upload/digest check leaves a draft, never a partial latest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { check, sha256, root, nodeVersion } = require('./release-build.cjs');

async function publish() {
  const { repository, tag, commit } = check();
  const out = path.join(root, 'dist/release');
  const expected = [];
  for (const [platform, binary] of [['linux', 'app_linux'], ['win', 'app_win.exe'], ['macos', 'app_macos']]) {
    const notices = `licenses-${platform}-x64.tar.gz`;
    expected.push(binary, `${binary}.metadata.json`, notices);
    const meta = JSON.parse(fs.readFileSync(path.join(out, `${binary}.metadata.json`), 'utf8'));
    assert.deepEqual([meta.repository, meta.tag, meta.commit, meta.platform, meta.arch, meta.node],
      [repository, tag, commit, platform, 'x64', nodeVersion]);
    assert.equal(meta.packaging, 'pkg (not SEA)');
    assert.deepEqual(meta.tools, { pkg: '6.23.0', pkgFetch: '3.6.6', pnpm: '10.34.7' });
    assert.equal(meta.sourceTest.result, 'passed');
    assert.equal(meta.snapshot.byteEqual, true);
    assert.equal(meta.snapshot.sha256, sha256(path.join(root, 'module/user_listen_report.js')));
    assert.equal(meta.smoke.result, 'passed');
    assert.equal(meta.smoke.helper.node, `v${nodeVersion}`);
    assert.equal(meta.smoke.helper.sea, false);
    assert.equal(meta.binary.name, binary);
    assert.equal(meta.binary.size, fs.statSync(path.join(out, binary)).size);
    assert.equal(meta.binary.sha256, sha256(path.join(out, binary)));
    assert.equal(meta.notices.name, notices);
    assert.equal(meta.notices.sha256, sha256(path.join(out, notices)));
    for (const [file, digest] of Object.entries(meta.inputs)) assert.equal(digest, sha256(path.join(root, file)), file);
  }
  assert.deepEqual(fs.readdirSync(out).sort(), expected.sort(), 'Missing or unexpected matrix assets');
  const source = `KuGouMusicApi-${tag}-source.tar.gz`;
  execFileSync('git', ['archive', '--format=tar.gz', `--prefix=KuGouMusicApi-${tag}/`, `--output=${path.join(out, source)}`, commit], { cwd: root });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  const files = fs.readdirSync(out).sort();
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), files.map((name) => `${sha256(path.join(out, name))}  ${name}\n`).join(''));
  files.push('SHA256SUMS');

  const apiRoot = `https://api.github.com/repos/${repository}`;
  async function api(method, route, body) {
    const response = await fetch(`${apiRoot}${route}`, {
      method, headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
      }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  assert.ok(process.env.GH_TOKEN, 'Publish token is required');
  const notes = [
    `Songloft fork release of KuGouMusicApi, not an upstream MakcRe release. Tag: ${tag}; commit: ${commit}.`,
    '',
    'x64 assets: app_linux (glibc Linux, tested on Ubuntu 22.04), app_win.exe (Windows Server 2022),',
    'app_macos (Intel macOS, tested on macOS 15). Built with Node 22.23.2 and @yao-pkg/pkg 6.23.0;',
    'traditional pkg with PKG_INVOKE_NODEJS helper mode, not SEA. No Windows signing or Apple notarization.',
    'All three native binaries passed helper and HTTP smoke against a non-forwarding local mock;',
    'the embedded report matches the payload-tested source byte-for-byte on each platform.',
    'No live KuGou reporting/account test was performed.',
    '',
    'SHA256SUMS covers every payload. Keep using the GitHub release asset digest (sha256:...) when downloading;',
    'it is verified before this draft is published. Published release assets must not be overwritten.',
    'Per-platform metadata records inputs/toolchain/runtime hashes and smoke results.',
    'The source archive contains the exact tagged application, workflow, scripts and both dependency locks.',
    'LICENSE is the existing application MIT license; licenses-*-x64.tar.gz includes Node notices,',
    'the pkg Node patch, actual production dependency licenses/package metadata and a missing-notice inventory.',
  ].join('\n');
  let release = await api('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  if (release) {
    assert.ok(release.draft, 'Refuse to replace assets of an already published release');
    assert.equal(release.target_commitish, commit, 'Existing draft belongs to another commit');
  } else {
    release = await api('POST', '/releases', {
      tag_name: tag, target_commitish: commit, name: `KuGouMusicApi ${tag} (Songloft fork)`,
      body: notes, draft: true, prerelease: false, make_latest: 'false',
    });
  }
  // Retrying a failed run may replace draft assets only. gh uploads raw assets, preserving GitHub digests.
  execFileSync('gh', ['release', 'upload', tag, '--repo', repository, '--clobber', ...files.map((name) => path.join(out, name))], { stdio: 'inherit' });
  let assets;
  for (let attempt = 0; attempt < 6; attempt++) {
    assets = await api('GET', `/releases/${release.id}/assets?per_page=100`);
    if (assets?.length === files.length && assets.every((asset) => asset.digest)) break;
    await sleep(2000);
  }
  assert.deepEqual(assets.map((asset) => asset.name).sort(), [...files].sort());
  for (const asset of assets) {
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, fs.statSync(path.join(out, asset.name)).size);
    assert.equal(asset.digest, `sha256:${sha256(path.join(out, asset.name))}`, asset.name);
  }
  const published = await api('PATCH', `/releases/${release.id}`, {
    body: notes, draft: false, prerelease: false, make_latest: 'true',
  });
  assert.equal(published.draft, false);
  console.log(published.html_url);
}

publish().catch((error) => { console.error(error); process.exitCode = 1; });
