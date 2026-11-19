#!/usr/bin/env node
// log-stream — filtro de tubería que reenvía a NanoFlow, en vivo, la salida de
// un paso del workflow:
//
//   set -o pipefail
//   bash -euo pipefail "$script" 2>&1 | node "$NF_LOG_STREAM" --job "$GITHUB_JOB" --step build
//
// Cada línea se vuelve a imprimir en stdout en cuanto llega (GitHub sigue
// mostrando y guardando todo), se redacta y se envía por lotes (≈1 s o 200
// líneas) a POST ${NF_API_URL}/v1/ci/logs con el token OIDC del job.
//
// Tres reglas que mandan sobre todo lo demás:
//
//   1. Nunca falla ni bloquea el comando. Sale siempre con 0 (con pipefail, un
//      código distinto de 0 aquí fallaría un build que salió bien). Si la API
//      deja de responder, no se rinde: guarda las líneas en cola, avisa con un
//      ::warning:: en ese momento, espera y vuelve a intentar; al recuperarse
//      envía lo acumulado. Al final, un ::warning:: solo si algo se perdió.
//   2. Redacta ANTES de enviar. ::add-mask:: solo afecta al log que guarda
//      GitHub; lo que llega por la tubería es la salida cruda del comando.
//   3. Sin dependencias: corre con el node que traen los runners (≥ 20, fetch
//      global), sin npm install.
//
// Sin NF_API_URL, NF_AUDIENCE o el permiso id-token: write, pasa a modo
// solo-eco: imprime y no envía nada.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

// Límites del contrato de /v1/ci/logs: 500 líneas y 256 KiB por lote, 4 KiB por
// línea. Se envía bastante por debajo para no rozarlos nunca.
const BATCH_LINES = 200;
const BATCH_BYTES = 192 * 1024;
const LINE_BYTES = 4 * 1024;
const FLUSH_MS = 1000;
// Una línea sin salto de línea no puede crecer sin límite en memoria (un
// binario volcado a la salida, una barra de progreso con \r).
const PARTIAL_BYTES = 64 * 1024;
// Si la API va más lenta que el comando, lo que no cabe se descarta y se cuenta.
const MAX_QUEUED_LINES = 20000;
// Tiempo total para vaciar lo pendiente al cerrarse stdin.
const CLOSE_DEADLINE_MS = 10000;
// Una API lenta (arranque en frío, pooler de la base) no es una API caída.
const REQUEST_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 4 * 60 * 1000;
// Reintentos por lote: 0,5 s · 1 s · 2 s.
const RETRY_DELAYS_MS = [500, 1000, 2000];
// Tres lotes seguidos sin llegar (cada uno tras sus reintentos) y se hace una
// pausa antes de volver a intentar; las líneas esperan en la cola. Antes se
// dejaba de enviar para siempre: en un apply largo, tres respuestas lentas
// seguidas congelaban el log en vivo hasta el final del paso.
const MAX_CONSECUTIVE_FAILURES = 3;
const OUTAGE_PAUSE_MS = 30 * 1000;
// Un rechazo (401 aun con token nuevo, 403, 404) puede ser pasajero (la API sin
// sus claves de GitHub un momento, el catálogo actualizándose): se reintenta
// también, con más calma.
const REFUSED_PAUSE_MS = 60 * 1000;
// Un valor enmascarado de menos de 4 caracteres taparía medio log sin proteger
// nada.
const MIN_SECRET_LENGTH = 4;
const MASK = '***';

// --- redacción ---------------------------------------------------------------

// Patrones de credenciales que se tapan aunque nadie los haya declarado.
const PATTERNS = [
  // Claves de acceso de AWS (larga duración y temporales).
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  // Tokens de GitHub: personales, OAuth, de instalación, de usuario, de refresco.
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,255}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, MASK],
  // Authorization: Bearer … (el esquema se conserva, el token no).
  [/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${MASK}`],
  // Un bloque PEM entero en una sola línea (p. ej. dentro de un JSON con \n).
  [/-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g, MASK],
];
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*KEY-----/;
const ADD_MASK = /^\s*::add-mask::(.*)$/;

class Redactor {
  // env: las variables del proceso. Se leen una vez: las credenciales de AWS ya
  // están en el entorno del paso cuando arranca.
  constructor(env = process.env) {
    this.secrets = [];
    this.inPem = false;
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      this.add(env[name]);
    }
    for (const name of String(env.NF_MASK_ENV || '').split(/[\s,]+/)) {
      if (name) this.add(env[name]);
    }
  }

  add(value) {
    if (typeof value !== 'string') return;
    // Un secreto multilínea se tapa línea a línea: es así como llega.
    for (const part of value.split(/\r?\n/)) {
      const v = part.trim();
      if (v.length >= MIN_SECRET_LENGTH && !this.secrets.includes(v)) {
        this.secrets.push(v);
      }
    }
    // El más largo primero: si uno contiene a otro, se tapa entero.
    this.secrets.sort((a, b) => b.length - a.length);
  }

  redact(line) {
    // Un bloque PEM de varias líneas: todo lo que hay entre BEGIN y END.
    if (this.inPem) {
      if (PEM_END.test(line)) this.inPem = false;
      return MASK;
    }
    // ::add-mask:: declara un secreto: se aprende y la propia línea no lo lleva.
    const m = ADD_MASK.exec(line);
    if (m) {
      this.add(m[1]);
      return line.slice(0, line.indexOf('::add-mask::')) + '::add-mask::' + MASK;
    }
    let out = line;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    for (const [re, replacement] of PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, replacement);
    }
    if (PEM_BEGIN.test(line) && !PEM_END.test(line)) this.inPem = true;
    return out;
  }
}

// --- líneas ------------------------------------------------------------------

// cutBytes corta a `max` bytes UTF-8 sin partir un carácter.
function cutBytes(s, max) {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  // Un carácter partido se decodifica como U+FFFD al final: fuera.
  while (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}

// LineSplitter convierte trozos de stdin en líneas completas.
class LineSplitter {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
  }

  push(chunk) {
    const text = this.partial + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const parts = text.split('\n');
    this.partial = parts.pop();
    if (Buffer.byteLength(this.partial, 'utf8') > PARTIAL_BYTES) {
      parts.push(this.partial);
      this.partial = '';
    }
    return parts.map(clean);
  }

  end() {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    return rest === '' ? [] : [clean(rest)];
  }
}

function clean(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// --- numeración --------------------------------------------------------------

// La numeración va por (job, step) y empieza en 1. Si el mismo paso se invoca
// dos veces en un job (dos comandos con --step build), la segunda sigue donde
// terminó la primera: con n repetido, la API descartaría sus líneas como
// reintentos. El contador vive en RUNNER_TEMP, que es del job.
function counterFile(runnerTemp, job, step) {
  if (!runnerTemp) return '';
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(runnerTemp, 'nf-log-stream', `${safe(job)}__${safe(step)}.n`);
}

function readCounter(file) {
  if (!file) return 0;
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCounter(file, n) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(n));
  } catch {
    // Sin contador el siguiente paso con el mismo nombre repetiría números; no
    // es motivo para tocar el build.
  }
}

// --- envío -------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sender habla con GitHub (token OIDC) y con NanoFlow (lotes).
class Sender {
  constructor({ apiUrl, audience, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, wait = sleep }) {
    this.url = `${String(apiUrl).replace(/\/+$/, '')}/v1/ci/logs`;
    this.audience = audience;
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.token = '';
    this.tokenAt = 0;
    this.lastError = '';
  }

  async getToken(force = false) {
    if (!force && this.token && this.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    const reqUrl = `${this.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(this.audience)}`;
    const res = await this.fetch(reqUrl, {
      headers: { Authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token OIDC: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.value !== 'string' || body.value === '') throw new Error('token OIDC vacío');
    this.token = body.value;
    this.tokenAt = this.now();
    return this.token;
  }

  // send devuelve cómo terminó el lote. Nunca lanza.
  //   'ok'          guardado.
  //   'rejected'    la API no lo quiere (400, 413): reintentarlo no lo arregla.
  //   'unavailable' no llegó tras sus reintentos (red, timeout, 429, 5xx, token
  //                 OIDC): el lote sigue siendo bueno.
  //   'refused'     401 aun con token nuevo, 403 o 404: no lo acepta ahora.
  async send(payload, deadline = Infinity) {
    const body = JSON.stringify(payload);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let retry = false;
      try {
        const token = await this.getToken();
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - this.now()))),
        });
        if (res.status >= 200 && res.status < 300) return 'ok';
        this.lastError = `HTTP ${res.status}`;
        if (res.status === 401 && !refreshed) {
          // El token pudo caducar entre la caché y el envío: uno nuevo, una vez.
          refreshed = true;
          this.token = '';
          retry = true;
        } else if (res.status === 401 || res.status === 403 || res.status === 404) {
          // El siguiente intento (tras la pausa) pide un token nuevo.
          this.token = '';
          return 'refused';
        } else if (res.status === 429 || res.status >= 500) {
          retry = true;
        } else {
          return 'rejected'; // 400, 413
        }
      } catch (err) {
        this.lastError = err && err.message ? err.message : String(err);
        retry = true;
      }
      if (!retry || attempt >= RETRY_DELAYS_MS.length) return 'unavailable';
      const delay = RETRY_DELAYS_MS[attempt];
      if (this.now() + delay >= deadline) return 'unavailable';
      await this.wait(delay);
    }
  }
}

// --- el stream ---------------------------------------------------------------

class LogStream {
  constructor({
    job, step, stepNumber, checkRunId, sender, redactor,
    startN = 0, flushMs = FLUSH_MS, batchLines = BATCH_LINES, batchBytes = BATCH_BYTES,
    now = Date.now, notify = () => {},
    outagePauseMs = OUTAGE_PAUSE_MS, refusedPauseMs = REFUSED_PAUSE_MS,
  }) {
    this.job = job;
    this.step = step;
    this.stepNumber = stepNumber;
    this.checkRunId = checkRunId;
    this.sender = sender;
    this.redactor = redactor;
    this.n = startN;
    this.flushMs = flushMs;
    this.batchLines = batchLines;
    this.batchBytes = batchBytes;
    this.now = now;
    this.queue = [];
    this.timer = null;
    this.sending = null;
    this.inflight = 0;
    this.failures = 0;
    this.sent = 0;
    this.dropped = 0;
    // notify imprime un comando de workflow (::warning::, ::notice::) en el log
    // del paso en el momento: el corte y la vuelta del log en vivo se ven en
    // GitHub mientras pasan, no solo al terminar.
    this.notify = notify;
    this.outagePauseMs = outagePauseMs;
    this.refusedPauseMs = refusedPauseMs;
    // Durante una pausa no se envía; las líneas esperan en la cola.
    this.pausedUntil = 0;
    this.resumeTimer = null;
    this.outage = false;
    this.outageLines = 0;
  }

  get active() {
    return Boolean(this.sender);
  }

  // push recibe una línea ya impresa. La numera siempre (aunque no se envíe) para
  // que n siga siendo la posición real de la línea en el paso.
  push(text) {
    this.n++;
    if (!this.active) return;
    const redacted = this.redactor.redact(text);
    if (this.queue.length >= MAX_QUEUED_LINES) {
      this.dropped++;
      return;
    }
    this.queue.push({ n: this.n, t: new Date(this.now()).toISOString(), text: cutBytes(redacted, LINE_BYTES) });
    if (this.queue.length >= this.batchLines) {
      this.kick();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  // takeBatch saca de la cola el siguiente lote: hasta batchLines líneas y
  // batchBytes bytes de texto (al menos una línea).
  takeBatch() {
    let count = 0;
    let bytes = 0;
    while (count < this.queue.length && count < this.batchLines) {
      const size = Buffer.byteLength(this.queue[count].text, 'utf8') + 64;
      if (count > 0 && bytes + size > this.batchBytes) break;
      bytes += size;
      count++;
    }
    return this.queue.splice(0, count);
  }

  payload(lines) {
    const p = { job: this.job, step: this.step, lines };
    if (this.checkRunId) p.checkRunId = this.checkRunId;
    if (this.stepNumber) p.stepNumber = this.stepNumber;
    return p;
  }

  // kick arranca un envío si no hay uno en curso. Uno a la vez: el orden de los
  // lotes se conserva y una API lenta no recibe una avalancha. final (el
  // cierre) ignora la pausa pero no insiste: un fallo y se termina.
  kick(deadline = Infinity, final = false) {
    if (this.sending) return this.sending;
    const run = async () => {
      try {
        while (this.queue.length > 0 && this.active && this.now() < deadline) {
          if (!final && this.now() < this.pausedUntil) {
            this.scheduleResume();
            break;
          }
          const lines = this.takeBatch();
          this.inflight = lines.length;
          const result = await this.sender.send(this.payload(lines), deadline);
          this.inflight = 0;
          if (result === 'ok') {
            this.sent += lines.length;
            this.failures = 0;
            this.recovered();
          } else if (result === 'rejected') {
            this.dropped += lines.length;
            this.failures = 0;
          } else {
            // El lote vuelve al principio de la cola: llegará tras la pausa.
            this.queue.unshift(...lines);
            if (final) break;
            this.failures++;
            if (result === 'refused') this.pause(this.refusedPauseMs);
            else if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.pause(this.outagePauseMs);
          }
        }
      } catch {
        this.dropped += this.queue.length + this.inflight;
        this.inflight = 0;
        this.queue = [];
      }
    };
    // La marca se limpia DESPUÉS de asignarla: un ciclo que no espera nada (en
    // pausa) termina síncrono, y un `finally` dentro de run la limpiaría antes
    // de la asignación, dejando `sending` ocupado para siempre.
    const sending = run().finally(() => {
      if (this.sending === sending) this.sending = null;
    });
    this.sending = sending;
    return sending;
  }

  // pause deja de enviar durante ms y lo avisa una vez por corte.
  pause(ms) {
    this.pausedUntil = this.now() + ms;
    this.failures = 0;
    if (!this.outage) {
      this.outage = true;
      const why = this.sender.lastError ? ` (${this.sender.lastError})` : '';
      this.notify(`::warning::El log en vivo de ${this.job}/${this.step} no llega a NanoFlow${why}. ` +
        `Se reintenta cada ${Math.round(ms / 1000)} s y las líneas esperan en cola; el log completo sigue en GitHub.`);
    }
    this.scheduleResume();
  }

  scheduleResume() {
    if (this.resumeTimer) return;
    const ms = Math.max(0, this.pausedUntil - this.now());
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.kick();
    }, ms);
    this.resumeTimer.unref?.();
  }

  recovered() {
    if (!this.outage) return;
    this.outage = false;
    this.notify(`::notice::El log en vivo de ${this.job}/${this.step} volvió a llegar a NanoFlow; se envía lo acumulado.`);
  }

  // close vacía lo pendiente, con un tope total. Lo que no llegue a tiempo se
  // descarta: el comando ya terminó y el job no debe esperar a la API.
  async close(deadlineMs = CLOSE_DEADLINE_MS) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const deadline = this.now() + deadlineMs;
    let guard;
    const timeout = new Promise((resolve) => {
      // Sin unref: el tope es lo único que garantiza que close resuelva (y que
      // se imprima el aviso) si la petición en vuelo nunca termina.
      guard = setTimeout(resolve, deadlineMs);
    });
    // Un último intento aunque haya pausa, hasta el tope; si falla, se acaba.
    const drain = (async () => {
      if (this.sending) await this.sending;
      while (this.queue.length > 0 && this.active && this.now() < deadline) {
        const before = this.queue.length;
        await this.kick(deadline, true);
        if (this.queue.length >= before) break;
      }
    })();
    await Promise.race([drain, timeout]);
    clearTimeout(guard);
    // Lo que siga en cola o en vuelo cuenta como descartado: quien llama sale
    // del proceso justo después, sin esperar a esa petición.
    this.dropped += this.queue.length + this.inflight;
    this.inflight = 0;
    this.queue = [];
  }

  // warning es el único aviso que se imprime, y solo si algo se perdió.
  warning() {
    if (this.dropped === 0 || !this.sender) return '';
    const why = this.sender.lastError ? ` (${this.sender.lastError})` : '';
    return `::warning::NanoFlow no recibió ${this.dropped} líneas del log en vivo de ${this.job}/${this.step}${why}. ` +
      'El log completo sigue en GitHub y NanoFlow lo archiva al terminar el job.';
  }
}

// --- argumentos y arranque ---------------------------------------------------

function parseArgs(argv) {
  const out = { job: '', step: '', stepNumber: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (key === '--job') out.job = String(value() || '');
    else if (key === '--step') out.step = String(value() || '');
    else if (key === '--step-number') {
      const n = parseInt(value(), 10);
      out.stepNumber = Number.isFinite(n) && n > 0 ? n : 0;
    }
  }
  return out;
}

function positiveInt(s) {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// streamingEnabled dice si hay con qué enviar. Si no, el filtro es un `cat`.
function streamingEnabled(env, args) {
  if (String(env.NF_LIVE_LOGS || 'true').toLowerCase() === 'false') return false;
  return Boolean(env.NF_API_URL && env.NF_AUDIENCE &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN &&
    args.job && args.step && typeof globalThis.fetch === 'function');
}

function main() {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));
  const stdout = process.stdout;
  // Si quien lee stdout desaparece, no es motivo para morir con EPIPE: el
  // comando decide cómo termina, no este filtro.
  stdout.on('error', () => {});

  let stream = null;
  let counter = '';
  let endsWithNewline = true;
  // Un comando de workflow solo se reconoce al principio de una línea.
  const notify = (text) => {
    stdout.write(`${endsWithNewline ? '' : '\n'}${text}\n`);
    endsWithNewline = true;
  };
  try {
    if (streamingEnabled(env, args)) {
      counter = counterFile(env.RUNNER_TEMP, args.job, args.step);
      stream = new LogStream({
        job: args.job,
        step: args.step,
        stepNumber: args.stepNumber,
        checkRunId: positiveInt(env.NF_CHECK_RUN_ID),
        sender: new Sender({ apiUrl: env.NF_API_URL, audience: env.NF_AUDIENCE, env }),
        redactor: new Redactor(env),
        startN: readCounter(counter),
        notify,
      });
    } else if (env.NF_API_URL && !env.ACTIONS_ID_TOKEN_REQUEST_URL) {
      stdout.write("::debug::log-stream en modo solo-eco: el job no tiene 'permissions: id-token: write'.\n");
    }
  } catch {
    stream = null;
  }

  const splitter = new LineSplitter();
  const feed = (lines) => {
    if (!stream) return;
    for (const line of lines) {
      try {
        stream.push(line);
      } catch {
        // Un fallo al procesar una línea no puede afectar al eco.
      }
    }
  };

  // Una cancelación manda SIGINT/SIGTERM al grupo de procesos. Este filtro no
  // se adelanta: sigue leyendo hasta que el comando cierre la tubería, y así no
  // lo mata con un SIGPIPE antes de tiempo.
  let closeDeadline = CLOSE_DEADLINE_MS;
  const shorten = () => { closeDeadline = Math.min(closeDeadline, 2000); };
  process.on('SIGINT', shorten);
  process.on('SIGTERM', shorten);

  process.stdin.on('data', (chunk) => {
    // El eco va primero y en crudo: GitHub ve exactamente lo que vería sin el
    // filtro. Con contrapresión, para no acumular en memoria.
    if (chunk.length > 0) endsWithNewline = chunk[chunk.length - 1] === 0x0a;
    if (!stdout.write(chunk)) {
      process.stdin.pause();
      stdout.once('drain', () => process.stdin.resume());
    }
    feed(splitter.push(chunk));
  });

  // Sale explícitamente: un reintento o una petición en vuelo no pueden tener
  // abierta la tubería (ni el paso) después del tope de cierre.
  const finish = (text) => {
    stdout.write(text, () => process.exit(0));
  };

  process.stdin.on('end', async () => {
    feed(splitter.end());
    let text = '';
    if (stream) {
      try {
        await stream.close(closeDeadline);
        writeCounter(counter, stream.n);
        const warning = stream.warning();
        // Un comando de workflow solo se reconoce al principio de una línea.
        if (warning) text = `${endsWithNewline ? '' : '\n'}${warning}\n`;
      } catch {
        // nada: el filtro termina igual
      }
    }
    finish(text);
  });

  process.stdin.on('error', () => finish(''));
}

// Pase lo que pase, este proceso no cambia el resultado del paso.
if (require.main === module) {
  process.on('uncaughtException', () => { process.exitCode = 0; });
  process.on('unhandledRejection', () => { process.exitCode = 0; });
  process.on('exit', () => { process.exitCode = 0; });
  main();
}

module.exports = {
  Redactor, LineSplitter, LogStream, Sender, parseArgs, streamingEnabled,
  counterFile, readCounter, writeCounter, cutBytes,
  BATCH_LINES, LINE_BYTES, MASK,
};
