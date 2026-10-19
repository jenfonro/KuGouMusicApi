// Read the pinned pkg 6.23.0 GZip format without executing the prelude.
// Use base-runtime marker offsets, so Mach-O signatures and Windows paths are supported too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');

module.exports = (binary, base, source) => {
  const original = fs.readFileSync(base);
  const fd = fs.openSync(binary, 'r');
  function read(position, length) {
    const buffer = Buffer.alloc(length);
    assert.equal(fs.readSync(fd, buffer, 0, length, position), length);
    return buffer;
  }
  try {
    const offsets = {};
    for (const name of ['PAYLOAD_POSITION', 'PRELUDE_POSITION', 'PRELUDE_SIZE']) {
      const marker = `// ${name} //`;
      const values = [];
      for (let pos = original.indexOf(marker); pos !== -1; pos = original.indexOf(marker, pos + marker.length)) {
        const value = read(pos, marker.length).toString().trim();
        // The base also contains an unchanged JS string literal; only the injected numeric slot counts.
        if (/^\d+$/.test(value)) values.push(Number(value));
      }
      assert.equal(values.length, 1, `Expected exactly one patched ${name}`);
      offsets[name] = values[0];
    }
    const prelude = read(offsets.PRELUDE_POSITION, offsets.PRELUDE_SIZE).toString();
    const parts = prelude.split('return module.exports; })(),\n');
    assert.equal(parts.length, 2, 'Unexpected pkg prelude');
    assert.match(parts[1], /\n\);\n\}\)$/);
    const values = JSON.parse(`[${parts[1].slice(0, parts[1].lastIndexOf('\n);'))}]`);
    assert.equal(values.length, 5);
    const [vfs, entrypoint, , dictionary, compression] = values;
    assert.equal(compression, 1, 'Expected GZip');
    assert.match(entrypoint.replaceAll('\\', '/'), /\/app\.js$/);
    const reverse = Object.fromEntries(Object.entries(dictionary).map(([key, value]) => [value, key]));
    const matches = Object.entries(vfs).filter(([key]) =>
      key.split('/').map((part) => reverse[part]).join('/').endsWith('/module/user_listen_report.js'));
    assert.equal(matches.length, 1, 'Report module missing or ambiguous in snapshot');
    const entry = matches[0][1];
    assert.equal(entry['0'], undefined, 'Report must be source, not V8 bytecode');
    assert.ok(entry['1'], 'Report source content missing');
    const [start, length] = entry['1'];
    const content = gunzipSync(read(offsets.PAYLOAD_POSITION + start, length));
    assert.ok(content.equals(fs.readFileSync(source)), 'Embedded report differs from the payload-tested source');
    return { module: 'module/user_listen_report.js', byteEqual: true, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
};
