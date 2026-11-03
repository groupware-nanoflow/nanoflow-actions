// node --test actions/reconcile-moves/reconcile.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { reconcile, identityOf, movedHCL, markdown, collisionMessage, MOVED_FILE } = require('./reconcile.js');

const del = (address, type, before) => ({ address, type, mode: 'managed', change: { actions: ['delete'], before, after: null } });
const add = (address, type, after, unknown = {}) => ({
  address, type, mode: 'managed', change: { actions: ['create'], before: null, after, after_unknown: unknown },
});

// El plan del 02-nov del ERP (corrida 41532250632): NanoFlow regeneró la infra y
// el módulo escrito a mano (module.employees_service) pasó a ser el generado
// (module.lambda_employees), con los mismos nombres físicos.
const ROLE = 'erp-d50c00-dev-employees';
const VPC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole';
const XRAY = 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess';
const erpPlan = {
  resource_changes: [
    del('module.employees_service.aws_cloudwatch_log_group.this', 'aws_cloudwatch_log_group', { name: `/aws/lambda/${ROLE}`, retention_in_days: 14 }),
    del('module.employees_service.aws_iam_role.this', 'aws_iam_role', { name: ROLE, arn: `arn:aws:iam::397614038374:role/${ROLE}` }),
    del('module.employees_service.aws_iam_role_policy.this', 'aws_iam_role_policy', { name: 'app', role: ROLE }),
    del('module.employees_service.aws_iam_role_policy_attachment.vpc', 'aws_iam_role_policy_attachment', { role: ROLE, policy_arn: VPC }),
    del('module.employees_service.aws_iam_role_policy_attachment.xray', 'aws_iam_role_policy_attachment', { role: ROLE, policy_arn: XRAY }),
    del('module.employees_service.aws_lambda_function.this', 'aws_lambda_function', { function_name: ROLE, role: `arn:aws:iam::397614038374:role/${ROLE}` }),
    del('module.employees_service.aws_lambda_permission.api[0]', 'aws_lambda_permission', { function_name: ROLE, statement_id: 'AllowApiGatewayInvoke' }),
    del('module.api.aws_apigatewayv2_route.this["ANY /v1/{proxy+}"]', 'aws_apigatewayv2_route', { api_id: 'tzvjo3c796', route_key: 'ANY /v1/{proxy+}' }),
    del('module.network.aws_vpc_endpoint.interface["xray"]', 'aws_vpc_endpoint', { service_name: 'com.amazonaws.us-east-1.xray' }),
    add('module.lambda_employees.aws_cloudwatch_log_group.this', 'aws_cloudwatch_log_group', { name: `/aws/lambda/${ROLE}` }),
    add('module.lambda_employees.aws_cloudwatch_metric_alarm.errors[0]', 'aws_cloudwatch_metric_alarm', { alarm_name: `${ROLE}-errors` }),
    add('module.lambda_employees.aws_iam_role.this', 'aws_iam_role', { name: ROLE }, { arn: true, id: true }),
    add('module.lambda_employees.aws_iam_role_policy.access[0]', 'aws_iam_role_policy', { name: 'data-and-messaging' }, { role: true }),
    add('module.lambda_employees.aws_iam_role_policy_attachment.logs', 'aws_iam_role_policy_attachment', {
      role: ROLE, policy_arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    }),
    add('module.lambda_employees.aws_iam_role_policy_attachment.vpc[0]', 'aws_iam_role_policy_attachment', { role: ROLE, policy_arn: VPC }),
    add('module.lambda_employees.aws_iam_role_policy_attachment.xray[0]', 'aws_iam_role_policy_attachment', { role: ROLE, policy_arn: XRAY }),
    add('module.lambda_employees.aws_lambda_function.this', 'aws_lambda_function', { function_name: ROLE }, { role: true }),
    add('module.api.aws_lambda_permission.service["employees"]', 'aws_lambda_permission', { function_name: ROLE, statement_id: 'AllowApiGateway' }),
    add('module.api.aws_apigatewayv2_route.service["employees-proxy-get"]', 'aws_apigatewayv2_route', { api_id: 'tzvjo3c796', route_key: 'GET /employees/{proxy+}' }),
    add('module.api.aws_apigatewayv2_stage.default', 'aws_apigatewayv2_stage', { api_id: 'tzvjo3c796', name: '$default' }),
    { address: 'data.aws_iam_policy_document.assume', type: 'aws_iam_policy_document', mode: 'data', change: { actions: ['read'] } },
    { address: 'module.identity.aws_ecs_task_definition.this', type: 'aws_ecs_task_definition', mode: 'managed', change: { actions: ['delete', 'create'], before: { family: 'x' }, after: { family: 'x' } } },
  ],
};

test('ERP: mueve los cinco recursos con el mismo nombre físico y nada más', () => {
  const { moves, collisions } = reconcile(erpPlan);
  assert.deepEqual(collisions, []);
  assert.deepEqual(moves.map((m) => [m.from, m.to]), [
    ['module.employees_service.aws_cloudwatch_log_group.this', 'module.lambda_employees.aws_cloudwatch_log_group.this'],
    ['module.employees_service.aws_iam_role.this', 'module.lambda_employees.aws_iam_role.this'],
    ['module.employees_service.aws_iam_role_policy_attachment.vpc', 'module.lambda_employees.aws_iam_role_policy_attachment.vpc[0]'],
    ['module.employees_service.aws_iam_role_policy_attachment.xray', 'module.lambda_employees.aws_iam_role_policy_attachment.xray[0]'],
    ['module.employees_service.aws_lambda_function.this', 'module.lambda_employees.aws_lambda_function.this'],
  ]);
});

test('identidad por tipo: compuesta, de reserva, desconocida o ausente', () => {
  assert.deepEqual(identityOf(del('a', 'aws_iam_role_policy_attachment', { role: 'r', policy_arn: 'p' })), [['role', 'r'], ['policy_arn', 'p']]);
  assert.deepEqual(identityOf(del('a', 'aws_iam_role_policy', { name: 'n' })), null, 'sin role no hay identidad');
  assert.deepEqual(identityOf(add('a', 'aws_sqs_queue', { name: 'q' })), [['name', 'q']]);
  assert.deepEqual(identityOf(add('a', 'aws_sqs_queue', { name: 'q' }, { name: true })), null, 'nombre conocido solo tras el apply');
  assert.deepEqual(identityOf(add('a', 'aws_vpc', { cidr_block: '10.0.0.0/16' })), null);
  assert.deepEqual(identityOf(add('a', 'local_file', { filename: './x.txt' })), [['filename', './x.txt']]);
  assert.deepEqual(identityOf(add('a', 'aws_cloudwatch_metric_alarm', { alarm_name: 'e' })), [['alarm_name', 'e']]);
  assert.equal(identityOf({ address: 'a', type: 'aws_sqs_queue', change: { actions: ['update'], before: { name: 'q' }, after: { name: 'q' } } }), null);
  assert.equal(identityOf({ address: 'a', type: 'aws_sqs_queue', change: { actions: ['delete', 'create'], before: { name: 'q' }, after: { name: 'q' } } }), null);
});

test('el ámbito separa nombres que no son globales', () => {
  const { moves } = reconcile({
    resource_changes: [
      del('aws_apigatewayv2_stage.old', 'aws_apigatewayv2_stage', { api_id: 'A', name: '$default' }),
      add('aws_apigatewayv2_stage.new', 'aws_apigatewayv2_stage', { api_id: 'B', name: '$default' }),
      del('aws_security_group.old', 'aws_security_group', { vpc_id: 'v1', name: 'web' }),
      add('aws_security_group.new', 'aws_security_group', { vpc_id: 'v1', name: 'web' }),
    ],
  });
  assert.deepEqual(moves.map((m) => m.to), ['aws_security_group.new']);
});

test('tipos distintos con el mismo nombre no se emparejan', () => {
  const { moves, collisions } = reconcile({
    resource_changes: [
      del('module.a.aws_iam_role.this', 'aws_iam_role', { name: 'x' }),
      add('module.b.aws_lambda_function.this', 'aws_lambda_function', { function_name: 'x' }),
    ],
  });
  assert.deepEqual(moves, []);
  assert.deepEqual(collisions, []);
});

test('N:M es una colisión y no escribe moved para ese grupo', () => {
  const { moves, collisions } = reconcile({
    resource_changes: [
      del('module.a.local_file.x', 'local_file', { filename: './same.txt' }),
      del('module.c.local_file.x', 'local_file', { filename: './same.txt' }),
      add('module.b.local_file.x', 'local_file', { filename: './same.txt' }),
      del('module.a.local_file.y', 'local_file', { filename: './y.txt' }),
      add('module.b.local_file.y', 'local_file', { filename: './y.txt' }),
    ],
  });
  assert.deepEqual(moves.map((m) => m.to), ['module.b.local_file.y']);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].deletes, ['module.a.local_file.x', 'module.c.local_file.x']);
  assert.deepEqual(collisions[0].creates, ['module.b.local_file.x']);
  const msg = collisionMessage(collisions);
  assert.match(msg, /^El plan destruye y vuelve a crear recursos con el mismo nombre físico y NanoFlow no pudo emparejarlos: /);
  assert.match(msg, /local_file filename=\.\/same\.txt \(2 por destruir, 1 por crear\)/);
});

test('ignora data sources, objetos depuestos y planes vacíos', () => {
  assert.deepEqual(reconcile(null), { moves: [], collisions: [] });
  assert.deepEqual(reconcile({}), { moves: [], collisions: [] });
  const { moves } = reconcile({
    resource_changes: [
      { ...del('module.a.local_file.x', 'local_file', { filename: 'f' }), deposed: 'abcd1234' },
      add('module.b.local_file.x', 'local_file', { filename: 'f' }),
      { ...del('data.local_file.x', 'local_file', { filename: 'g' }), mode: 'data' },
      add('module.b.local_file.g', 'local_file', { filename: 'g' }),
    ],
  });
  assert.deepEqual(moves, []);
});

test('el HCL tiene el formato de terraform fmt y el markdown lista los pares', () => {
  const { moves } = reconcile(erpPlan);
  const hcl = movedHCL(moves);
  assert.match(hcl, /^# Generado por NanoFlow en este run; no se versiona/);
  assert.match(hcl, /\nmoved \{\n {2}from = module\.employees_service\.aws_iam_role_policy_attachment\.vpc\n {2}to {3}= module\.lambda_employees\.aws_iam_role_policy_attachment\.vpc\[0\]\n\}\n/);
  assert.equal((hcl.match(/^moved \{$/gm) || []).length, 5);
  const md = markdown({ moves, collisions: [] });
  assert.match(md, /^#### 🔀 NanoFlow movió 5 recursos de dirección \(mismo nombre físico\)/);
  assert.match(md, /\| `aws_iam_role` \| name=erp-d50c00-dev-employees \| `module\.employees_service\.aws_iam_role\.this` \| `module\.lambda_employees\.aws_iam_role\.this` \|/);
  assert.equal(markdown({ moves: [], collisions: [] }), '');
});

test('CLI: escribe nanoflow_moved.tf solo con pares, el resumen y el mensaje', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-moves-'));
  const plan = path.join(dir, 'plan.json');
  const script = path.join(__dirname, 'reconcile.js');

  fs.writeFileSync(plan, JSON.stringify(erpPlan));
  let out = execFileSync('node', [script, plan, '--dir', dir, '--summary', path.join(dir, 's.md'), '--message', path.join(dir, 'm.txt')], { encoding: 'utf8' });
  assert.equal(out, 'moved=5 collisions=0\n');
  assert.ok(fs.existsSync(path.join(dir, MOVED_FILE)));
  assert.ok(!fs.existsSync(path.join(dir, 'm.txt')));
  assert.match(fs.readFileSync(path.join(dir, 's.md'), 'utf8'), /🔀/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-moves-'));
  fs.writeFileSync(plan, JSON.stringify({ resource_changes: [] }));
  out = execFileSync('node', [script, plan, '--dir', empty, '--summary', path.join(empty, 's.md')], { encoding: 'utf8' });
  assert.equal(out, 'moved=0 collisions=0\n');
  assert.ok(!fs.existsSync(path.join(empty, MOVED_FILE)));
  assert.equal(fs.readFileSync(path.join(empty, 's.md'), 'utf8'), '');

  const bad = spawnSync('node', [script, path.join(dir, 'missing.json'), '--dir', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no existe el plan JSON/);
});
