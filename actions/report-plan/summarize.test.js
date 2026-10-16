// node --test actions/report-plan
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { summarize, markdown, trivyFindings, kindOf } = require('./summarize.js');

const rc = (type, actions, mode = 'managed') => ({ type, mode, change: { actions } });

test('clasifica las acciones de Terraform', () => {
  assert.equal(kindOf(['create']), 'create');
  assert.equal(kindOf(['update']), 'update');
  assert.equal(kindOf(['delete']), 'delete');
  assert.equal(kindOf(['delete', 'create']), 'replace');
  assert.equal(kindOf(['create', 'delete']), 'replace');
  assert.equal(kindOf(['no-op']), null);
  assert.equal(kindOf(['read']), null);
  assert.equal(kindOf(undefined), null);
});

test('resume por total y por tipo, sin data sources ni no-op', () => {
  const s = summarize({
    resource_changes: [
      rc('aws_lambda_function', ['create']),
      rc('aws_lambda_function', ['create']),
      rc('aws_iam_role', ['update']),
      rc('aws_s3_bucket', ['delete', 'create']),
      rc('aws_s3_object', ['delete']),
      rc('aws_sns_topic', ['no-op']),
      rc('aws_caller_identity', ['read'], 'data'),
    ],
  });
  assert.deepEqual(
    { create: s.create, update: s.update, delete: s.delete, replace: s.replace },
    { create: 2, update: 1, delete: 1, replace: 1 },
  );
  assert.deepEqual(s.by_type.map((t) => t.type), ['aws_iam_role', 'aws_lambda_function', 'aws_s3_bucket', 'aws_s3_object']);
  assert.deepEqual(s.by_type[1], { type: 'aws_lambda_function', create: 2, update: 0, delete: 0, replace: 0 });
});

test('un plan vacío o ausente es "sin cambios"', () => {
  for (const p of [null, {}, { resource_changes: [] }]) {
    const s = summarize(p);
    assert.equal(s.create + s.update + s.delete + s.replace, 0);
    assert.match(markdown(s, { env: 'development', marker: '<!-- m -->' }), /Sin cambios/);
  }
});

test('el comentario lleva el marcador, la tabla y el aviso de destrucción', () => {
  const s = summarize({ resource_changes: [rc('aws_s3_bucket', ['delete', 'create'])] });
  const md = markdown(s, { env: 'production', marker: '<!-- nanoflow:terraform-plan:production -->', runUrl: 'https://x/run' });
  assert.ok(md.startsWith('<!-- nanoflow:terraform-plan:production -->\n'));
  assert.match(md, /\| `aws_s3_bucket` \|  \|  \| 1 \|  \|/);
  assert.match(md, /destruye o reemplaza/);
  assert.match(md, /\[Log del job\]\(https:\/\/x\/run\)/);
  assert.match(markdown(s, { env: 'production', marker: 'm', status: 'failed' }), /El plan falló/);
});

test('cuenta solo los hallazgos HIGH y CRITICAL que fallan', () => {
  const f = trivyFindings({
    Results: [{
      Target: 'modules/x/main.tf',
      Misconfigurations: [
        { AVDID: 'AVD-AWS-0011', Severity: 'HIGH', Status: 'FAIL', Title: 'WAF' },
        { AVDID: 'AVD-AWS-0001', Severity: 'CRITICAL', Status: 'FAIL', Title: 'c' },
        { AVDID: 'AVD-AWS-0010', Severity: 'MEDIUM', Status: 'FAIL', Title: 'm' },
        { AVDID: 'AVD-AWS-0002', Severity: 'HIGH', Status: 'PASS', Title: 'ok' },
      ],
    }],
  });
  assert.equal(f.high, 1);
  assert.equal(f.critical, 1);
  assert.deepEqual(f.items.map((i) => i.id), ['AVD-AWS-0011', 'AVD-AWS-0001']);
  assert.match(markdown(summarize(null), { env: 'd', marker: 'm', findings: f }), /\*\*1\*\* críticos y \*\*1\*\* altos/);
});

test('la CLI escribe resumen, hallazgos y comentario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-plan-'));
  const plan = path.join(dir, 'plan.json');
  const trivy = path.join(dir, 'trivy.json');
  fs.writeFileSync(plan, JSON.stringify({ resource_changes: [rc('aws_lambda_function', ['create'])] }));
  fs.writeFileSync(trivy, JSON.stringify({ Results: [] }));
  const out = execFileSync(process.execPath, [path.join(__dirname, 'summarize.js'), plan,
    '--env', 'development', '--trivy', trivy,
    '--summary', path.join(dir, 's.json'), '--findings', path.join(dir, 'f.json'), '--markdown', path.join(dir, 'c.md')], { encoding: 'utf8' });
  assert.equal(out, 'create=1 update=0 replace=0 delete=0\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).create, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'f.json'), 'utf8')).high, 0);
  assert.match(fs.readFileSync(path.join(dir, 'c.md'), 'utf8'), /<!-- nanoflow:terraform-plan:development -->/);
});
