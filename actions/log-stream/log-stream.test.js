// node --test actions/log-stream
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const {
  Redactor, LineSplitter, LogStream, Sender, parseArgs, streamingEnabled,
  counterFile, readCounter, writeCounter, cutBytes, MASK,
} = require('./log-stream.js');

const SCRIPT = path.join(__dirname, 'log-stream.js');

// --- redacción ---------------------------------------------------------------

test('redacta las credenciales de AWS del entorno', () => {
  const r = new Redactor({
    AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEEXAMPLE12',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    AWS_SESSION_TOKEN: 'IQoJb3JpZ2luX2VjEXAMPLETOKEN',
  });
  const out = r.redact('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY token=IQoJb3JpZ2luX2VjEXAMPLETOKEN');
  assert.equal(out, `export AWS_SECRET_ACCESS_KEY=${MASK} token=${MASK}`);
});

test('redacta las variables listadas en NF_MASK_ENV, separadas por coma o espacio', () => {
  const r = new Redactor({ NF_MASK_ENV: 'DB_PASSWORD, API_KEY  STRIPE', DB_PASSWORD: 'hunter2hunter2', API_KEY: 'k-123456', STRIPE: 'sk_live_abcdef' });
  assert.equal(r.redact('db=hunter2hunter2 key=k-123456 s=sk_live_abcdef'), `db=${MASK} key=${MASK} s=${MASK}`);
});

test('no enmascara valores demasiado cortos ni variables vacías', () => {
  const r = new Redactor({ NF_MASK_ENV: 'SHORT,MISSING', SHORT: 'ab' });
  assert.equal(r.redact('ab abc'), 'ab abc');
});

test('redacta patrones de credenciales aunque nadie los haya declarado', () => {
  const r = new Redactor({});
  const cases = [
    ['key AKIAIOSFODNN7EXAMPLE end', `key ${MASK} end`],
    ['ASIAY34FZKBOKMUTVV7A', MASK],
    [`ghp_${'a'.repeat(36)}`, MASK],
    [`x ghs_${'B1'.repeat(18)} y`, `x ${MASK} y`],
    [`gho_${'c'.repeat(36)}`, MASK],
    [`github_pat_${'11ABCDEFG0'.repeat(4)}_xyz`, MASK],
    ['Authorization: Bearer eyJhbGciOi.J9.abc-_= rest', `Authorization: Bearer ${MASK} rest`],
    ['curl -H "authorization: bearer abc.def"', `curl -H "authorization: bearer ${MASK}"`],
    ['{"key":"-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----"}', `{"key":"${MASK}"}`],
  ];
  for (const [line, want] of cases) assert.equal(r.redact(line), want, line);
});

test('tapa un bloque PEM de varias líneas entero', () => {
  const r = new Redactor({});
  const lines = ['antes', '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAABG5vbmU=', '-----END OPENSSH PRIVATE KEY-----', 'después'];
  assert.deepEqual(lines.map((l) => r.redact(l)), ['antes', MASK, MASK, MASK, MASK, 'después']);
});

test('aprende los valores de ::add-mask:: y no los reenvía', () => {
  const r = new Redactor({});
  assert.equal(r.redact('::add-mask::s3cr3t-value'), `::add-mask::${MASK}`);
  assert.equal(r.redact('using s3cr3t-value now'), `using ${MASK} now`);
});

test('el secreto más largo se tapa entero aunque contenga a otro', () => {
  const r = new Redactor({ NF_MASK_ENV: 'A B', A: 'abcd', B: 'abcdefgh' });
  assert.equal(r.redact('abcdefgh'), MASK);
});

// --- líneas ------------------------------------------------------------------

test('parte en líneas, quita \\r y no rompe caracteres UTF-8 entre trozos', () => {
  const s = new LineSplitter();
  const bytes = Buffer.from('uno\r\ndós\ntr', 'utf8');
  // Corta en mitad de la "ó" (2 bytes).
  const cut = bytes.indexOf(0xc3) + 1;
  assert.deepEqual(s.push(bytes.subarray(0, cut)), ['uno']);
  assert.deepEqual(s.push(bytes.subarray(cut)), ['dós']);
  assert.deepEqual(s.end(), ['tr']);
});

test('corta a bytes sin partir un carácter', () => {
  const out = cutBytes('a'.repeat(4095) + '€€', 4096);
  assert.equal(out, 'a'.repeat(4095));
  assert.ok(Buffer.byteLength(out) <= 4096);
});

test('lee los argumentos en las dos formas', () => {
  assert.deepEqual(parseArgs(['--job', 'deploy', '--step=build', '--step-number', '7']), { job: 'deploy', step: 'build', stepNumber: 7 });
  assert.deepEqual(parseArgs(['--job', 'x', '--step', 'y', '--step-number', 'nope']), { job: 'x', step: 'y', stepNumber: 0 });
});

test('pasa a solo-eco sin API, sin audiencia, sin id-token o con live-logs apagado', () => {
  const args = { job: 'j', step: 's' };
  const full = { NF_API_URL: 'https://api', NF_AUDIENCE: 'nanoflow-dev', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://t?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'tok' };
  assert.equal(streamingEnabled(full, args), true);
  for (const k of Object.keys(full)) assert.equal(streamingEnabled({ ...full, [k]: '' }, args), false, k);
  assert.equal(streamingEnabled({ ...full, NF_LIVE_LOGS: 'false' }, args), false);
  assert.equal(streamingEnabled(full, { job: 'j', step: '' }), false);
});

// --- agrupado y numeración ---------------------------------------------------

// results: lo que devuelve cada envío en orden; cuando se acaban, `then`.
function fakeSender({ fail = false, results = [], then } = {}) {
  return {
    lastError: fail ? 'HTTP 503' : '',
    batches: [],
    results: [...results],
    async send(payload) {
      this.batches.push(JSON.parse(JSON.stringify(payload)));
      if (this.results.length > 0) return this.results.shift();
      return then || (fail ? 'unavailable' : 'ok');
    },
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('agrupa de a 200 líneas y numera desde 1 por paso', async () => {
  const sender = fakeSender();
  const s = new LogStream({ job: 'deploy', step: 'build', stepNumber: 5, checkRunId: 42, sender, redactor: new Redactor({}), flushMs: 60000 });
  for (let i = 0; i < 450; i++) s.push(`line ${i + 1}`);
  await s.close(1000);

  assert.deepEqual(sender.batches.map((b) => b.lines.length), [200, 200, 50]);
  const ns = sender.batches.flatMap((b) => b.lines.map((l) => l.n));
  assert.deepEqual(ns, Array.from({ length: 450 }, (_, i) => i + 1));
  const first = sender.batches[0];
  assert.equal(first.job, 'deploy');
  assert.equal(first.step, 'build');
  assert.equal(first.stepNumber, 5);
  assert.equal(first.checkRunId, 42);
  assert.equal(first.lines[0].text, 'line 1');
  assert.ok(!Number.isNaN(Date.parse(first.lines[0].t)));
  assert.equal(s.dropped, 0);
  assert.equal(s.warning(), '');
});

test('envía lo acumulado al pasar el intervalo aunque no lleguen 200 líneas', async () => {
  const sender = fakeSender();
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}), flushMs: 20 });
  s.push('a');
  s.push('b');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sender.batches.length, 1);
  assert.deepEqual(sender.batches[0].lines.map((l) => l.text), ['a', 'b']);
  await s.close(100);
});

test('omite checkRunId y stepNumber cuando no se conocen', async () => {
  const sender = fakeSender();
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}) });
  s.push('a');
  await s.close(1000);
  assert.equal('checkRunId' in sender.batches[0], false);
  assert.equal('stepNumber' in sender.batches[0], false);
});

test('respeta el tope de bytes por lote', async () => {
  const sender = fakeSender();
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}), batchBytes: 10 * 1024, flushMs: 60000 });
  for (let i = 0; i < 10; i++) s.push('x'.repeat(4000));
  await s.close(1000);
  assert.ok(sender.batches.length >= 4);
  for (const b of sender.batches) {
    assert.ok(b.lines.reduce((n, l) => n + l.text.length, 0) <= 10 * 1024);
  }
});

test('redacta antes de encolar y corta cada línea a 4 KiB', async () => {
  const sender = fakeSender();
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({ AWS_SESSION_TOKEN: 'SECRETTOKEN' }) });
  s.push('t=SECRETTOKEN');
  s.push('y'.repeat(10000));
  await s.close(1000);
  const [a, b] = sender.batches[0].lines;
  assert.equal(a.text, `t=${MASK}`);
  assert.equal(Buffer.byteLength(b.text), 4096);
});

test('continúa la numeración de una invocación anterior del mismo paso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ls-'));
  const file = counterFile(dir, 'deploy', 'build/x');
  assert.equal(readCounter(file), 0);
  writeCounter(file, 17);
  assert.equal(readCounter(file), 17);
  assert.equal(path.basename(file), 'deploy__build_x.n');

  const sender = fakeSender();
  const s = new LogStream({ job: 'deploy', step: 'build', sender, redactor: new Redactor({}), startN: readCounter(file) });
  s.push('a');
  assert.equal(s.n, 18);
});

test('si la API no responde, pausa, avisa en el momento y entrega lo acumulado al volver', async () => {
  const notes = [];
  const sender = fakeSender({ results: ['unavailable', 'unavailable', 'unavailable'], then: 'ok' });
  sender.lastError = 'The operation was aborted due to timeout';
  const s = new LogStream({ job: 'apply', step: 'apply', sender, redactor: new Redactor({}), flushMs: 5,
    outagePauseMs: 40, notify: (t) => notes.push(t) });
  for (let i = 0; i < 5; i++) s.push(`l${i}`);
  await tick(20);
  // Tres envíos fallidos del mismo lote y la pausa: nada se perdió.
  assert.equal(sender.batches.length, 3);
  assert.equal(s.queue.length, 5);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^::warning::El log en vivo de apply\/apply no llega a NanoFlow \(The operation was aborted due to timeout\)\. Se reintenta cada 0 s/);
  // Durante la pausa siguen llegando líneas: esperan en la cola.
  s.push('l5');
  await tick(80);
  assert.equal(s.queue.length, 0);
  assert.equal(s.dropped, 0);
  assert.deepEqual(sender.batches.at(-1).lines.map((l) => l.text), ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /^::notice::El log en vivo de apply\/apply volvió a llegar a NanoFlow/);
  await s.close(100);
  assert.equal(s.warning(), '', 'sin pérdidas no hay aviso final');
});

test('un rechazo (401, 403, 404) pausa más tiempo y se reintenta', async () => {
  const notes = [];
  const sender = fakeSender({ results: ['refused'], then: 'ok' });
  sender.lastError = 'HTTP 404';
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}), flushMs: 5,
    outagePauseMs: 1000, refusedPauseMs: 30, notify: (t) => notes.push(t) });
  s.push('a');
  await tick(15);
  assert.equal(sender.batches.length, 1, 'un rechazo pausa de inmediato');
  assert.match(notes[0], /\(HTTP 404\)/);
  await tick(60);
  assert.equal(sender.batches.length, 2);
  assert.equal(s.sent, 1);
});

test('un lote que la API no quiere (400, 413) se descarta y se sigue', async () => {
  const sender = fakeSender({ results: ['rejected'], then: 'ok' });
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}), flushMs: 60000, batchLines: 2 });
  for (const t of ['a', 'b', 'c']) s.push(t);
  await s.close(1000);
  assert.equal(s.dropped, 2);
  assert.equal(s.sent, 1);
});

test('si la API sigue caída al cerrar, descarta lo pendiente y deja un único aviso final', async () => {
  const notes = [];
  const sender = fakeSender({ fail: true });
  const s = new LogStream({ job: 'deploy', step: 'build', sender, redactor: new Redactor({}), flushMs: 60000,
    notify: (t) => notes.push(t) });
  for (let i = 0; i < 1000; i++) s.push(`l${i}`);
  await s.close(1000);
  assert.equal(s.dropped, 1000);
  assert.match(s.warning(), /^::warning::NanoFlow no recibió 1000 líneas del log en vivo de deploy\/build \(HTTP 503\)/);
  assert.ok(notes.length <= 1, 'a lo sumo el aviso del corte');
});

test('el cierre no espera más que su tope', async () => {
  const sender = { lastError: '', send: () => new Promise(() => {}) };
  const s = new LogStream({ job: 'j', step: 's', sender, redactor: new Redactor({}) });
  s.push('a');
  const started = Date.now();
  await s.close(100);
  assert.ok(Date.now() - started < 1000);
  assert.equal(s.dropped, 1);
});

// --- Sender ------------------------------------------------------------------

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Sender pide el token con la audiencia, lo cachea y reintenta con backoff', async () => {
  const calls = [];
  let posts = 0;
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts]);
    if (url.startsWith('https://token')) return response(200, { value: 'oidc-token' });
    posts++;
    return posts === 1 ? response(503) : response(202, { accepted: 1 });
  };
  const waits = [];
  const sender = new Sender({
    apiUrl: 'https://api.example.com/',
    audience: 'nanoflow-dev',
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req' },
    fetchImpl,
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(await sender.send({ job: 'j', step: 's', lines: [] }), 'ok');
  assert.equal(await sender.send({ job: 'j', step: 's', lines: [] }), 'ok');

  const tokenCalls = calls.filter(([u]) => u.startsWith('https://token'));
  assert.equal(tokenCalls.length, 1, 'el token se cachea');
  assert.equal(tokenCalls[0][0], 'https://token.example?api-version=2.0&audience=nanoflow-dev');
  assert.equal(tokenCalls[0][1].headers.Authorization, 'bearer req');
  const post = calls.find(([u]) => u === 'https://api.example.com/v1/ci/logs');
  assert.equal(post[1].headers.Authorization, 'Bearer oidc-token');
  assert.deepEqual(waits, [500]);
});

test('Sender: un 404 es un rechazo, pero no se queda apagado', async () => {
  let posts = 0;
  let tokens = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://token')) return response(200, { value: `t${++tokens}` });
    return ++posts === 1 ? response(404) : response(202);
  };
  const sender = new Sender({ apiUrl: 'https://api', audience: 'a', env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token?x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' }, fetchImpl, wait: async () => {} });
  assert.equal(await sender.send({}), 'refused');
  assert.equal(sender.lastError, 'HTTP 404');
  assert.equal(await sender.send({}), 'ok');
  assert.equal(tokens, 2, 'tras un rechazo se pide un token nuevo');
});

test('Sender: 400 es un lote rechazado y 5xx tras los reintentos, no disponible', async () => {
  const mk = (status) => new Sender({ apiUrl: 'https://api', audience: 'a', env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token?x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' },
    fetchImpl: async (url) => (url.startsWith('https://token') ? response(200, { value: 't' }) : response(status)), wait: async () => {} });
  assert.equal(await mk(400).send({}), 'rejected');
  assert.equal(await mk(503).send({}), 'unavailable');
});

test('Sender renueva el token una vez ante un 401', async () => {
  let tokens = 0;
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://token')) return response(200, { value: `t${++tokens}` });
    return ++posts === 1 ? response(401) : response(202);
  };
  const sender = new Sender({ apiUrl: 'https://api', audience: 'a', env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token?x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' }, fetchImpl, wait: async () => {} });
  assert.equal(await sender.send({}), 'ok');
  assert.equal(tokens, 2);
});

test('Sender nunca lanza aunque la red falle', async () => {
  const sender = new Sender({ apiUrl: 'https://api', audience: 'a', env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token?x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, wait: async () => {} });
  assert.equal(await sender.send({}), 'unavailable');
  assert.equal(sender.lastError, 'ECONNREFUSED');
});

// --- de punta a punta, como filtro de tubería --------------------------------

function run(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--job', 'deploy', '--step', 'build'], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('en modo solo-eco es un cat que sale con 0', async () => {
  const { code, out } = await run({}, 'hola\nmundo sin salto');
  assert.equal(code, 0);
  assert.equal(out, 'hola\nmundo sin salto');
});

test('reenvía redactado a la API y sigue imprimiendo todo', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/token')) {
        res.end(JSON.stringify({ value: 'oidc' }));
        return;
      }
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = 202;
      res.end('{"accepted":1}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ls-'));
  try {
    const { code, out } = await run({
      NF_API_URL: base,
      NF_AUDIENCE: 'nanoflow-dev',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req',
      AWS_SECRET_ACCESS_KEY: 'topsecretvalue',
      NF_CHECK_RUN_ID: '31415926535',
      RUNNER_TEMP: tmp,
    }, 'npm run build\nkey=topsecretvalue\n');
    assert.equal(code, 0);
    assert.equal(out, 'npm run build\nkey=topsecretvalue\n', 'el eco es crudo: GitHub enmascara lo suyo');
    const lines = received.flatMap((r) => r.body.lines);
    assert.deepEqual(lines.map((l) => [l.n, l.text]), [[1, 'npm run build'], [2, `key=${MASK}`]]);
    assert.equal(received[0].url, '/v1/ci/logs');
    assert.equal(received[0].auth, 'Bearer oidc');
    assert.equal(received[0].body.checkRunId, 31415926535);
    assert.equal(readCounter(counterFile(tmp, 'deploy', 'build')), 2);
  } finally {
    server.close();
  }
});

test('con la API caída sale con 0 y un único aviso al final', async () => {
  const { code, out } = await run({
    NF_API_URL: 'http://127.0.0.1:9',
    NF_AUDIENCE: 'nanoflow-dev',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1:9/token?x=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req',
  }, 'a\nb');
  assert.equal(code, 0);
  const warnings = out.split('\n').filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.ok(out.startsWith('a\nb\n::warning::'), 'el aviso empieza en su propia línea');
});
