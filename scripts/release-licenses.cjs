// Inventory only installed production packages, plus the two tools whose code patches the runtime.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { root, sha256, nodeVersion } = require('./release-build.cjs');

module.exports = async (platform, out) => {
  const dir = path.join(root, 'dist', `licenses-${platform}-x64`);
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
  const nodeLicenseURL = `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`;
  const response = await fetch(nodeLicenseURL, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `Node LICENSE download failed: ${response.status}`);
  const nodeLicense = path.join(dir, 'Node-LICENSE');
  fs.writeFileSync(nodeLicense, Buffer.from(await response.arrayBuffer()));
  assert.equal(sha256(nodeLicense), 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4');
  const tools = path.join(root, 'tools/build/node_modules');
  const patch = `node.v${nodeVersion}.cpp.patch`;
  fs.copyFileSync(path.join(tools, '@yao-pkg/pkg-fetch/patches', patch), path.join(dir, patch));

  // pnpm's real package directories; ignore symlinks so shared dependencies appear only once.
  function packagesAt(modules) {
    return fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const full = path.join(modules, entry.name);
      return entry.name.startsWith('@') ? packagesAt(full)
        : fs.existsSync(path.join(full, 'package.json')) ? [full] : [];
    });
  }
  const store = path.join(root, 'node_modules/.pnpm');
  const packages = fs.readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .flatMap((entry) => packagesAt(path.join(store, entry.name, 'node_modules')));
  packages.push(path.join(tools, '@yao-pkg/pkg'), path.join(tools, '@yao-pkg/pkg-fetch'));
  const inventory = packages.map((pkgDir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const dest = path.join(dir, 'packages', `${pkg.name.replace('/', '__')}@${pkg.version}`);
    fs.mkdirSync(dest, { recursive: true });
    const notices = fs.readdirSync(pkgDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(licen[sc]e|copying|notice|copyright|authors)([._-]|$)/i.test(entry.name))
      .map((entry) => entry.name);
    // cookie-signature@1.0.6 ships its full MIT notice in Readme.md rather than LICENSE.
    if (!notices.length) {
      const readme = fs.readdirSync(pkgDir).find((file) => /^readme([._-]|$)/i.test(file));
      if (readme && /licen[sc]e|copyright/i.test(fs.readFileSync(path.join(pkgDir, readme), 'utf8'))) notices.push(readme);
    }
    for (const file of ['package.json', ...notices]) fs.copyFileSync(path.join(pkgDir, file), path.join(dest, file));
    return { name: pkg.name, version: pkg.version, license: pkg.license || pkg.licenses || null, notices };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const manifest = {
    application: { license: 'MIT', file: 'LICENSE' },
    node: { version: nodeVersion, license: 'Node-LICENSE', source: `https://nodejs.org/dist/v${nodeVersion}/`, patch, licenseURL: nodeLicenseURL },
    packages: inventory,
    missingNoticeFiles: inventory.filter((pkg) => pkg.notices.length === 0).map((pkg) => `${pkg.name}@${pkg.version}`),
    scope: 'Installed production packages; pkg and pkg-fetch runtime/prelude notices. Package metadata retained when no standalone notice is shipped.',
  };
  assert.ok(inventory.length > 2, 'Production dependency license inventory is empty');
  if (manifest.missingNoticeFiles.length) console.warn('No standalone notice shipped:', manifest.missingNoticeFiles);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = path.join(out, `${path.basename(dir)}.tar.gz`);
  await require(path.join(tools, 'tar')).c({ gzip: true, portable: true, cwd: path.dirname(dir), file: archive }, [path.basename(dir)]);
  return archive;
};
