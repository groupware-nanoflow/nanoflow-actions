#!/usr/bin/env node
// reconcile — empareja, en un plan de Terraform (`terraform show -json tfplan`),
// cada recurso que se destruye con el que se crea del mismo tipo y el mismo
// nombre físico, y escribe esos pares como bloques `moved` (consola, doc 32 §8.1).
//
//   node reconcile.js plan.json --dir envs/development --summary moved.md
//
// Por qué: si un módulo cambia de dirección (un renombre, un módulo escrito a
// mano que NanoFlow reemplaza por el generado), Terraform destruye la dirección
// vieja y crea la nueva EN PARALELO; con el mismo nombre físico, AWS rechaza la
// creación («EntityAlreadyExists», «ResourceAlreadyExistsException»). Un `moved`
// lleva el objeto a la dirección nueva: sin destruir ni crear, o con un
// reemplazo ordenado si algo lo exige.
//
// Un par 1:1 es un `moved`; varios con la misma identidad (N:M) son una colisión
// que NanoFlow no resuelve sola. El archivo de `moved` no se versiona: se
// recalcula en cada run mientras haga falta (tras el apply, el estado ya tiene
// las direcciones nuevas y no quedan pares). Sin dependencias: corre con el
// node de los runners.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MOVED_FILE = 'nanoflow_moved.tf';

// La identidad física por tipo: los atributos que AWS usa como nombre único
// (con su ámbito cuando el nombre no es global). El orden importa solo para leer.
const IDENTITY = {
  aws_iam_role_policy_attachment: ['role', 'policy_arn'],
  aws_iam_role_policy: ['role', 'name'],
  aws_lambda_permission: ['function_name', 'statement_id'],
  aws_apigatewayv2_route: ['api_id', 'route_key'],
  aws_apigatewayv2_stage: ['api_id', 'name'],
  aws_security_group: ['vpc_id', 'name'],
  aws_ecs_service: ['cluster', 'name'],
  aws_lambda_function: ['function_name'],
  aws_s3_bucket: ['bucket'],
  aws_cloudwatch_metric_alarm: ['alarm_name'],
};

// El resto: el primero presente de estos. `filename` es de `local_file`, para
// la prueba local sin AWS.
const FALLBACK = ['name', 'function_name', 'bucket', 'role_name', 'filename'];

const isText = (v) => typeof v === 'string' && v.trim() !== '';

function attrs(type, values, unknown) {
  const known = (k) => values && isText(values[k]) && !(unknown && unknown[k]);
  const keys = IDENTITY[type];
  if (keys) {
    if (!keys.every(known)) return null;
    return keys.map((k) => [k, values[k]]);
  }
  for (const k of FALLBACK) {
    if (known(k)) return [[k, values[k]]];
  }
  return null;
}

/**
 * La identidad física de un cambio: el lado `before` de una destrucción, el
 * `after` (conocido) de una creación. null = no se puede emparejar.
 */
function identityOf(rc) {
  const ch = rc.change || {};
  const actions = Array.isArray(ch.actions) ? ch.actions : [];
  if (actions.length !== 1) return null;
  if (actions[0] === 'delete') return attrs(rc.type, ch.before, null);
  if (actions[0] === 'create') return attrs(rc.type, ch.after, ch.after_unknown);
  return null;
}

/**
 * @returns {{moves: {type:string, identity:string, from:string, to:string}[],
 *            collisions: {type:string, identity:string, deletes:string[], creates:string[]}[]}}
 */
function reconcile(plan) {
  const groups = new Map();
  for (const rc of (plan && plan.resource_changes) || []) {
    if (rc.mode && rc.mode !== 'managed') continue; // data sources
    if (rc.deposed) continue; // objetos depuestos de un create_before_destroy
    const id = identityOf(rc);
    if (!id) continue;
    const identity = id.map(([k, v]) => `${k}=${v}`).join(' ');
    const key = `${rc.type}\u0000${identity}`;
    if (!groups.has(key)) groups.set(key, { type: rc.type, identity, deletes: [], creates: [] });
    const g = groups.get(key);
    (rc.change.actions[0] === 'delete' ? g.deletes : g.creates).push(rc.address);
  }
  const moves = [];
  const collisions = [];
  for (const g of groups.values()) {
    if (g.deletes.length === 0 || g.creates.length === 0) continue;
    if (g.deletes.length === 1 && g.creates.length === 1) {
      moves.push({ type: g.type, identity: g.identity, from: g.deletes[0], to: g.creates[0] });
    } else {
      collisions.push({ type: g.type, identity: g.identity, deletes: [...g.deletes].sort(), creates: [...g.creates].sort() });
    }
  }
  // Orden por código (no por locale): el mismo archivo en cualquier runner.
  const byCode = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  moves.sort((a, b) => byCode(a.to, b.to));
  collisions.sort((a, b) => byCode(`${a.type} ${a.identity}`, `${b.type} ${b.identity}`));
  return { moves, collisions };
}

/** El archivo de `moved`, con el formato de `terraform fmt`. */
function movedHCL(moves) {
  const lines = [
    '# Generado por NanoFlow en este run; no se versiona (consola, doc 32 §8.1).',
    '# El plan destruía y volvía a crear estos recursos con el mismo nombre físico:',
    '# cada `moved` lleva el objeto existente a su dirección nueva.',
  ];
  for (const m of moves) {
    lines.push('', 'moved {', `  from = ${m.from}`, `  to   = ${m.to}`, '}');
  }
  return lines.join('\n') + '\n';
}

/** El mensaje de una colisión sin resolver (lo reconoce el clasificador: TF_NAME_COLLISION). */
function collisionMessage(collisions) {
  const items = collisions.map((c) => `${c.type} ${c.identity} (${c.deletes.length} por destruir, ${c.creates.length} por crear)`);
  return 'El plan destruye y vuelve a crear recursos con el mismo nombre físico y NanoFlow no pudo emparejarlos: ' +
    items.join('; ') + '. Agrega los bloques `moved` que correspondan o quita el Terraform escrito a mano.';
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** Markdown para el comentario del PR y el resumen del job ('' si no hay nada). */
function markdown({ moves, collisions }) {
  const lines = [];
  if (moves.length > 0) {
    const n = moves.length;
    lines.push(`#### 🔀 NanoFlow movió ${n} ${n === 1 ? 'recurso' : 'recursos'} de dirección (mismo nombre físico)`, '');
    lines.push(
      'El plan destruía y volvía a crear estos recursos con el mismo nombre; en paralelo, AWS rechaza la creación («already exists»). ' +
        'NanoFlow los movió con bloques `moved` que no se versionan (el plan de arriba ya los incluye).',
      '',
    );
    lines.push('| Tipo | Nombre | De | A |', '|---|---|---|---|');
    for (const m of moves) {
      lines.push(`| \`${m.type}\` | ${cell(m.identity)} | \`${cell(m.from)}\` | \`${cell(m.to)}\` |`);
    }
  }
  if (collisions.length > 0) {
    if (lines.length) lines.push('');
    lines.push('#### ⛔ Recursos con el mismo nombre físico sin emparejar', '');
    lines.push(collisionMessage(collisions), '');
    lines.push('| Tipo | Nombre | Por destruir | Por crear |', '|---|---|---|---|');
    for (const c of collisions) {
      lines.push(`| \`${c.type}\` | ${cell(c.identity)} | ${c.deletes.map((a) => `\`${cell(a)}\``).join('<br>')} | ${c.creates.map((a) => `\`${cell(a)}\``).join('<br>')} |`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i] ?? '';
    else args._.push(a);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const file = args._[0];
  if (!file || !fs.existsSync(file)) throw new Error(`no existe el plan JSON: ${file || '(vacío)'}`);
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = reconcile(plan);
  if (result.moves.length > 0) {
    if (!args.dir) throw new Error('falta --dir');
    fs.writeFileSync(path.join(args.dir, MOVED_FILE), movedHCL(result.moves));
  }
  if (args.summary) fs.writeFileSync(args.summary, markdown(result));
  if (args.message && result.collisions.length > 0) fs.writeFileSync(args.message, collisionMessage(result.collisions) + '\n');
  process.stdout.write(`moved=${result.moves.length} collisions=${result.collisions.length}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`reconcile-moves: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { reconcile, identityOf, movedHCL, markdown, collisionMessage, parseArgs, MOVED_FILE, IDENTITY, FALLBACK };
