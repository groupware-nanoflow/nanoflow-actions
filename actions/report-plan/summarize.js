#!/usr/bin/env node
// summarize — resume un plan de Terraform (`terraform show -json tfplan`) en
// lo que NanoFlow y el PR muestran: cuántos recursos se crean, cambian,
// destruyen o reemplazan, en total y por tipo.
//
//   node summarize.js plan.json --env development --summary summary.json --markdown comment.md
//
// Sin dependencias: corre con el node de los runners. Las acciones `no-op` y
// `read` no cuentan; ["delete","create"] y ["create","delete"] son un reemplazo.
'use strict';

const fs = require('node:fs');

const KINDS = ['create', 'update', 'delete', 'replace'];

function kindOf(actions) {
  const a = Array.isArray(actions) ? actions : [];
  if (a.length === 2 && a.includes('create') && a.includes('delete')) return 'replace';
  if (a.length === 1 && ['create', 'update', 'delete'].includes(a[0])) return a[0];
  return null;
}

/** @returns {{create:number, update:number, delete:number, replace:number, by_type:object[]}} */
function summarize(plan) {
  const total = { create: 0, update: 0, delete: 0, replace: 0 };
  const byType = new Map();
  for (const rc of (plan && plan.resource_changes) || []) {
    if (rc.mode && rc.mode !== 'managed') continue; // data sources
    const kind = kindOf(rc.change && rc.change.actions);
    if (!kind) continue;
    total[kind]++;
    if (!byType.has(rc.type)) byType.set(rc.type, { type: rc.type, create: 0, update: 0, delete: 0, replace: 0 });
    byType.get(rc.type)[kind]++;
  }
  const by_type = [...byType.values()].sort((x, y) => x.type.localeCompare(y.type));
  return { ...total, by_type };
}

function hasChanges(s) {
  return KINDS.some((k) => s[k] > 0);
}

/** Markdown del comentario del PR. `marker` permite actualizarlo en lugar de duplicarlo. */
function markdown(s, { env, marker, status = 'succeeded', findings = null, runUrl = '' }) {
  const lines = [marker, `### Terraform plan · ${env}`, ''];
  if (status !== 'succeeded') {
    lines.push('❌ El plan falló. Revisa el log del job.');
  } else if (!hasChanges(s)) {
    lines.push('Sin cambios: la infraestructura ya coincide con el código.');
  } else {
    lines.push(`**${s.create}** a crear · **${s.update}** a cambiar · **${s.replace}** a reemplazar · **${s.delete}** a destruir`, '');
    lines.push('| Tipo | Crear | Cambiar | Reemplazar | Destruir |', '|---|---:|---:|---:|---:|');
    for (const t of s.by_type) {
      lines.push(`| \`${t.type}\` | ${t.create || ''} | ${t.update || ''} | ${t.replace || ''} | ${t.delete || ''} |`);
    }
    if (s.delete > 0 || s.replace > 0) {
      lines.push('', '⚠️ Este plan destruye o reemplaza recursos: revísalo con cuidado antes de aprobar.');
    }
  }
  if (findings && (findings.high || findings.critical)) {
    lines.push('', `🛡️ ${findings.tool}: **${findings.critical || 0}** críticos y **${findings.high || 0}** altos. El check falla hasta resolverlos o justificarlos.`);
  }
  if (runUrl) lines.push('', `[Log del job](${runUrl})`);
  lines.push('', '<sub>Generado por NanoFlow.</sub>');
  return lines.join('\n') + '\n';
}

/** Resumen de un reporte JSON de `trivy config`: severidades HIGH y CRITICAL. */
function trivyFindings(report) {
  const out = { tool: 'trivy', high: 0, critical: 0, items: [] };
  for (const r of (report && report.Results) || []) {
    for (const m of r.Misconfigurations || []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      if (m.Severity === 'HIGH') out.high++;
      else if (m.Severity === 'CRITICAL') out.critical++;
      else continue;
      if (out.items.length < 50) {
        out.items.push({ id: m.AVDID || m.ID, severity: m.Severity, title: m.Title, file: r.Target });
      }
    }
  }
  return out;
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

function readJSON(path) {
  if (!path || !fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function main(argv) {
  const args = parseArgs(argv);
  const plan = readJSON(args._[0]);
  const s = summarize(plan);
  const findings = args.trivy ? trivyFindings(readJSON(args.trivy)) : null;
  if (args.summary) fs.writeFileSync(args.summary, JSON.stringify(s) + '\n');
  if (args.findings && findings) fs.writeFileSync(args.findings, JSON.stringify(findings) + '\n');
  if (args.markdown) {
    fs.writeFileSync(args.markdown, markdown(s, {
      env: args.env || '?',
      marker: `<!-- nanoflow:terraform-plan:${args.env || '?'} -->`,
      status: args.status || 'succeeded',
      findings,
      runUrl: args['run-url'] || '',
    }));
  }
  process.stdout.write(`create=${s.create} update=${s.update} replace=${s.replace} delete=${s.delete}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { summarize, markdown, trivyFindings, kindOf, hasChanges, parseArgs };
