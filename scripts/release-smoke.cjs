// Run against the actual native binary, from an empty cwd, without account/config inheritance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

function helper() {
  assert.equal(process.version, 'v22.23.2');
  assert.equal(process.arch, 'x64');
  assert.equal(require('node:sea').isSea(), false, 'SEA cannot replace pkg helper mode');
  assert.equal(process.argv[3], 'helper-check');
  assert.ok(fs.readFileSync(__filename, 'utf8').includes('helper-check'));
  assert.equal(require('node:crypto').createHash('sha256').update('abc').digest('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(require('node:vm').runInNewContext('answer + 1', { answer: 41 }), 42);
  const zlib = require('node:zlib');
  assert.equal(zlib.inflateSync(zlib.deflateSync('helper-check')).toString(), 'helper-check');
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, sea: false }));
}

function request(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP smoke request timed out')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function smoke() {
  const binary = path.resolve(process.argv[2]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kugou-smoke-'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG)$/i.test(key)));
  Object.assign(env, { HOME: cwd, USERPROFILE: cwd });
  let child;
  let childError;
  let logs = '';
  const seen = [];
  // A sink, not a forwarding proxy. Even unexpected requests receive only a local response.
  const proxy = http.createServer((req, res) => {
    req.resume();
    seen.push({ path: new URL(req.url, 'http://mock.invalid').pathname, router: req.headers['x-router'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 1, offline_mock: true, path: seen.at(-1).path }));
  });
  try {
    const helperResult = JSON.parse(execFileSync(binary, [__filename, '--helper', 'helper-check'], {
      cwd, env: { ...env, PKG_EXECPATH: 'PKG_INVOKE_NODEJS' }, encoding: 'utf8', timeout: 15000,
    }));
    assert.equal(helperResult.platform, process.platform);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(binary, [], {
      cwd, env: {
        ...env, HOST: '127.0.0.1', PORT: String(port), KUGOU_API_PROXY: proxyURL,
        HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL, NO_PROXY: '',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (error) => { childError = error; });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (childError) throw childError;
      assert.equal(child.exitCode, null, `Binary exited:\n${logs}`);
      let response;
      try { response = await request(port, '/'); } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
        await sleep(100);
        continue;
      }
      assert.equal(response.status, 200, response.body);
      assert.match(response.body, /<html/i, 'Bundled public assets are missing');
      ready = true;
      break;
    }
    assert.ok(ready, `Binary failed to start:\n${logs}`);
    const routes = [
      ['/playlist/tracks/sort', '/v1/modify_song_sort'],
      ['/playlist/sort', '/v1/modify_list_sort'],
      ['/playlist/update', '/v1/modify_list'],
    ];
    for (const [route, upstreamPath] of routes) {
      const response = await request(port, route, { listid: 9, data: '9|0|1' });
      assert.equal(response.status, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { status: 1, offline_mock: true, path: upstreamPath });
    }
    // Missing cookie, then missing event: both must fail before any report/session request.
    for (const body of [
      { event: 'start' },
      { mixsongid: 1, cookie: { token: 'smoke-only', userid: 1, KUGOU_API_GUID: 'a'.repeat(32), KUGOU_API_MID: 'smoke-mid' } },
    ]) {
      const response = await request(port, '/user/listen/report', body);
      assert.equal(response.status, 400, response.body);
      assert.equal(JSON.parse(response.body).status, 0);
    }
    assert.deepEqual(seen, routes.map(([, upstreamPath]) => ({ path: upstreamPath, router: 'cloudlist.service.kugou.com' })));
    const result = {
      result: 'passed', helper: helperResult, http: { static: 200, routes, reportRejections: [400, 400] },
      upstream: 'Non-forwarding loopback mock only; no real report/account requests', mockRequests: seen,
    };
    if (process.argv[3]) fs.writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    // Terminate only the service child created above; never search/kill by process name or port.
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--helper') helper();
else smoke().catch((error) => { console.error(error); process.exitCode = 1; });
