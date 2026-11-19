'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  facts, foreignRecords, implicitLogGroups, databaseKeys, supabaseBases, parseStateList, stamp,
  inventory, prepare, cleanup, result, AwsError,
} = require('./destroy.js');

// Estado como el de `terraform show -json` de un ambiente con Postgres (RDS),
// Aurora, DynamoDB, SPA, dominio en Route 53, Cognito, Keycloak y secretos.
// Los `values` traen, como el real, una contraseña que nunca debe salir.
function stateFixture({ production = false } = {}) {
  const r = (address, type, values) => ({ address, mode: 'managed', type, name: address.split('.').pop(), values });
  return {
    format_version: '1.0',
    values: {
      root_module: {
        resources: [],
        child_modules: [
          {
            address: 'module.db_app_db',
            resources: [
              r('module.db_app_db.aws_db_instance.this', 'aws_db_instance', {
                identifier: 'shop-dev-app-db', engine: 'postgres', allocated_storage: 20,
                deletion_protection: production, kms_key_id: 'arn:aws:kms:us-east-1:111111111111:key/k-db',
                password: 'super-secreta',
              }),
              r('module.db_app_db.aws_kms_key.this', 'aws_kms_key', { key_id: 'k-db', arn: 'arn:aws:kms:us-east-1:111111111111:key/k-db' }),
              r('module.db_app_db.aws_kms_alias.this', 'aws_kms_alias', { name: 'alias/shop-dev-app-db-db' }),
              r('module.db_app_db.aws_db_proxy.this', 'aws_db_proxy', { name: 'shop-dev-app-db' }),
              r('module.db_app_db.aws_secretsmanager_secret.app', 'aws_secretsmanager_secret', {
                arn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:shop-dev-app-db-app-AbC', name: 'shop-dev-app-db-app',
              }),
              { address: 'module.db_app_db.data.aws_region.this', mode: 'data', type: 'aws_region', name: 'this', values: {} },
            ],
          },
          {
            address: 'module.db_events',
            resources: [
              r('module.db_events.aws_rds_cluster.this', 'aws_rds_cluster', {
                cluster_identifier: 'shop-dev-events', engine: 'aurora-postgresql', deletion_protection: true,
                kms_key_id: 'arn:aws:kms:us-east-1:111111111111:key/k-ev',
              }),
              r('module.db_events.aws_rds_cluster_instance.this[0]', 'aws_rds_cluster_instance', {
                identifier: 'shop-dev-events-1', cluster_identifier: 'shop-dev-events',
              }),
              r('module.db_events.aws_kms_key.this', 'aws_kms_key', { key_id: 'k-ev', arn: 'arn:aws:kms:us-east-1:111111111111:key/k-ev' }),
            ],
          },
          {
            address: 'module.table_orders',
            resources: [r('module.table_orders.aws_dynamodb_table.this', 'aws_dynamodb_table', { name: 'shop-dev-orders', deletion_protection_enabled: true })],
          },
          {
            address: 'module.frontend',
            resources: [
              r('module.frontend.aws_s3_bucket.site', 'aws_s3_bucket', { bucket: 'shop-dev-web-111111111111' }),
              r('module.frontend.aws_cloudfront_distribution.site', 'aws_cloudfront_distribution', { id: 'E1' }),
            ],
          },
          {
            address: 'module.domain',
            resources: [
              r('module.domain.aws_route53_zone.this[0]', 'aws_route53_zone', { zone_id: 'Z123', name: 'dev.shop.com' }),
              r('module.domain.aws_route53_record.alias["dev.shop.com/A"]', 'aws_route53_record', { zone_id: 'Z123', name: 'dev.shop.com', type: 'A' }),
              r('module.domain.aws_route53_record.validation["x"]', 'aws_route53_record', { zone_id: 'Z123', name: '_abc.dev.shop.com', type: 'CNAME' }),
            ],
          },
          {
            address: 'module.identity',
            resources: [
              r('module.identity.aws_cognito_user_pool.this', 'aws_cognito_user_pool', { id: 'us-east-1_pool', name: 'shop-dev-users', deletion_protection: 'ACTIVE' }),
              r('module.identity.aws_ecs_cluster.this', 'aws_ecs_cluster', { name: 'shop-dev-keycloak' }),
              r('module.identity.aws_secretsmanager_secret.admin', 'aws_secretsmanager_secret', {
                arn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:shop-dev-keycloak-admin-XyZ', name: 'shop-dev-keycloak-admin',
              }),
            ],
          },
        ],
      },
    },
  };
}

const planFixture = {
  resource_changes: [
    { address: 'a', mode: 'managed', type: 'aws_db_instance', change: { actions: ['delete'] } },
    { address: 'b', mode: 'managed', type: 'aws_s3_bucket', change: { actions: ['delete'] } },
    { address: 'c', mode: 'data', type: 'aws_region', change: { actions: ['read'] } },
  ],
  configuration: {
    root_module: {
      module_calls: {
        db_app_db: { source: '../../modules/data/postgres' },
        db_billing: { source: '../../modules/data/supabase' },
      },
    },
  },
};

const zoneRecords = [
  { Name: 'dev.shop.com.', Type: 'SOA', ResourceRecords: [{ Value: 'x' }] },
  { Name: 'dev.shop.com.', Type: 'NS', ResourceRecords: [{ Value: 'ns-1.awsdns' }] },
  { Name: 'dev.shop.com.', Type: 'A', AliasTarget: { DNSName: 'd1.cloudfront.net.' } },
  { Name: '_abc.dev.shop.com.', Type: 'CNAME', ResourceRecords: [{ Value: 'acm' }] },
  { Name: 'dev.shop.com.', Type: 'MX', ResourceRecords: [{ Value: '10 mail' }] },
  { Name: '\\052.dev.shop.com.', Type: 'TXT', ResourceRecords: [{ Value: '"v=1"' }] },
];

/**
 * deps falsos: registran cada llamada a la CLI y responden por prefijo
 * ("s3api list-object-versions", …). Un handler puede lanzar un AwsError.
 */
function fakeDeps(handlers = {}) {
  const calls = [];
  const tf = [];
  const logs = [];
  return {
    calls, tf, logs,
    aws(args) {
      calls.push(args);
      const key = Object.keys(handlers).filter((k) => args.join(' ').startsWith(k)).sort((a, b) => b.length - a.length)[0];
      const h = key ? handlers[key] : null;
      return typeof h === 'function' ? h(args, calls) : (h ?? null);
    },
    terraform(args) { tf.push(args); },
    log(msg) { logs.push(msg); },
    now: () => new Date(Date.UTC(2026, 9, 28, 20, 15)),
    sleep() {},
  };
}

const awsErr = (stderr) => () => { throw new AwsError(['x', 'y'], stderr); };
const did = (deps, prefix) => deps.calls.some((c) => c.join(' ').startsWith(prefix));
const callsOf = (deps, prefix) => deps.calls.filter((c) => c.join(' ').startsWith(prefix));

test('facts: solo recursos gestionados y sin valores sensibles', () => {
  const f = facts(stateFixture());
  assert.equal(f.total, 17);
  assert.deepEqual(f.instances.map((i) => i.identifier), ['shop-dev-app-db']);
  assert.deepEqual(f.clusters.map((c) => c.identifier), ['shop-dev-events']);
  assert.equal(f.distributions, 1);
  assert.equal(JSON.stringify(f).includes('super-secreta'), false);
});

test('foreignRecords: deja SOA/NS del apex y lo gestionado; normaliza \\052 y el punto final', () => {
  const f = facts(stateFixture());
  const foreign = foreignRecords(f.zones[0], zoneRecords, f.records);
  assert.deepEqual(foreign.map((r) => `${r.Name} ${r.Type}`), ['dev.shop.com. MX', '\\052.dev.shop.com. TXT']);
});

test('implicitLogGroups y databaseKeys', () => {
  const f = facts(stateFixture());
  assert.deepEqual(implicitLogGroups(f), [
    '/aws/rds/instance/shop-dev-app-db/postgresql',
    '/aws/rds/cluster/shop-dev-events/postgresql',
    '/aws/rds/proxy/shop-dev-app-db',
    '/aws/ecs/containerinsights/shop-dev-keycloak/performance',
  ]);
  assert.deepEqual(databaseKeys(f).map((k) => k.address), ['module.db_app_db.aws_kms_key.this', 'module.db_events.aws_kms_key.this']);
});

test('supabaseBases, parseStateList y stamp', () => {
  assert.deepEqual(supabaseBases(planFixture), [{ kind: 'supabase', name: 'billing' }]);
  assert.deepEqual([...parseStateList('module.a.aws_x.y\ndata.aws_region.r\nmodule.b.data.aws_caller_identity.c\n\n')], ['module.a.aws_x.y']);
  assert.equal(stamp(new Date(Date.UTC(2026, 0, 2, 3, 4))), '202601020304');
});

test('inventory: cuenta lo que tiene datos con lecturas, y un fallo es un aviso', () => {
  const deps = fakeDeps({
    'rds describe-db-snapshots': { DBSnapshots: [{ DBSnapshotIdentifier: 'shop-dev-app-db-pre-0003-9-1', SnapshotCreateTime: '2026-10-01T00:00:00Z' }] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [] },
    's3api list-objects-v2': { KeyCount: 1000, IsTruncated: true },
    'dynamodb describe-table': { Table: { ItemCount: 42, DeletionProtectionEnabled: true } },
    'cognito-idp describe-user-pool': awsErr('An error occurred (AccessDeniedException)'),
    'route53 list-resource-record-sets': { ResourceRecordSets: zoneRecords },
    'logs describe-log-groups': (args) => ({ logGroups: args[3].includes('/aws/rds/instance/') ? [{ logGroupName: args[3] }] : [] }),
  });
  const { summary, inventory: inv } = inventory(stateFixture(), planFixture, deps);
  assert.equal(summary.delete, 2);
  assert.equal(inv.resources, 17);
  assert.equal(inv.noState, false);
  assert.deepEqual(inv.databases.map((d) => [d.kind, d.identifier, d.snapshots.length]), [['rds', 'shop-dev-app-db', 1], ['aurora', 'shop-dev-events', 0]]);
  assert.deepEqual(inv.buckets, [{ name: 'shop-dev-web-111111111111', objects: 1000, truncated: true }]);
  assert.deepEqual(inv.tables, [{ name: 'shop-dev-orders', items: 42, deletionProtection: true }]);
  assert.deepEqual(inv.userPools, [{ id: 'us-east-1_pool', name: 'shop-dev-users', users: null }]);
  assert.equal(inv.zones[0].foreignRecords.length, 2);
  assert.equal(inv.secrets, 2);
  assert.equal(inv.distributions, 1);
  assert.equal(inv.kmsKeys, 2);
  assert.deepEqual(inv.logGroups, ['/aws/rds/instance/shop-dev-app-db/postgresql']);
  assert.deepEqual(inv.survives, [{ kind: 'supabase', name: 'billing' }]);
  assert.equal(inv.warnings.length, 1);
  assert.match(inv.warnings[0], /user pool shop-dev-users/);
  // Solo lecturas.
  assert.ok(deps.calls.every((c) => /^(describe|list)-/.test(c[1])), deps.calls.map((c) => c[1]).join(','));
  assert.equal(JSON.stringify(inv).includes('super-secreta'), false);
});

test('inventory: un estado vacío es noState', () => {
  const { inventory: inv } = inventory({ values: { root_module: {} } }, { resource_changes: [] }, fakeDeps());
  assert.equal(inv.resources, 0);
  assert.equal(inv.noState, true);
});

test('prepare sin conservar: vacía, quita protecciones, borra bases sin snapshot y los registros ajenos', () => {
  let page = 0;
  const deps = fakeDeps({
    's3api list-object-versions': () => (page++ === 0
      ? { Versions: [{ Key: 'index.html', VersionId: 'null' }, { Key: 'app.js', VersionId: 'v2' }], DeleteMarkers: [{ Key: 'old.js', VersionId: 'm1' }] }
      : {}),
    's3api delete-objects': {},
    'rds describe-db-snapshots': { DBSnapshots: [{ DBSnapshotIdentifier: 'mine-by-hand' }, { DBSnapshotIdentifier: 'shop-dev-app-db-pre-0003-9-1' }] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [] },
    'route53 list-resource-record-sets': { ResourceRecordSets: zoneRecords },
  });
  const out = prepare(stateFixture(), { keepSnapshots: false }, deps);

  assert.equal(out.cleaned.objects, 3);
  const del = JSON.parse(callsOf(deps, 's3api delete-objects')[0][5]);
  assert.deepEqual(del.Objects.map((o) => o.Key), ['index.html', 'app.js', 'old.js']);

  assert.equal(did(deps, 'rds create-db-snapshot'), false);
  assert.equal(did(deps, 'rds create-db-cluster-snapshot'), false);
  assert.ok(did(deps, 'rds modify-db-cluster --db-cluster-identifier shop-dev-events --no-deletion-protection'));
  assert.equal(did(deps, 'rds modify-db-instance'), false); // dev: sin protección
  assert.ok(did(deps, 'rds delete-db-instance --db-instance-identifier shop-dev-events-1'));
  assert.ok(did(deps, 'rds delete-db-cluster --db-cluster-identifier shop-dev-events --skip-final-snapshot --delete-automated-backups'));
  assert.ok(did(deps, 'rds delete-db-instance --db-instance-identifier shop-dev-app-db --skip-final-snapshot --delete-automated-backups'));
  assert.ok(did(deps, 'rds wait db-instance-deleted --db-instance-identifier shop-dev-app-db'));

  assert.ok(did(deps, 'dynamodb update-table --table-name shop-dev-orders --no-deletion-protection-enabled'));
  assert.equal(did(deps, 'dynamodb create-backup'), false);
  assert.ok(did(deps, 'cognito-idp update-user-pool --user-pool-id us-east-1_pool --deletion-protection INACTIVE'));

  const batch = JSON.parse(callsOf(deps, 'route53 change-resource-record-sets')[0][5]);
  assert.deepEqual(batch.Changes.map((c) => `${c.Action} ${c.ResourceRecordSet.Type}`), ['DELETE MX', 'DELETE TXT']);
  assert.equal(out.cleaned.records, 2);

  assert.deepEqual(deps.tf, []); // la llave KMS se va con Terraform
  assert.deepEqual(out.snapshots, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /mine-by-hand/); // el snapshot del usuario queda sin llave
});

test('prepare conservando (producción): snapshots, backup, la llave KMS sale del estado', () => {
  const deps = fakeDeps({
    's3api list-object-versions': {},
    'rds describe-db-snapshots': { DBSnapshots: [{ DBSnapshotIdentifier: 'shop-dev-app-db-pre-0003-9-1' }] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [] },
    'dynamodb create-backup': { BackupDetails: { BackupArn: 'arn:aws:dynamodb:backup/1' } },
    'route53 list-resource-record-sets': { ResourceRecordSets: [] },
  });
  const out = prepare(stateFixture({ production: true }), { keepSnapshots: true }, deps);

  assert.ok(did(deps, 'rds create-db-snapshot --db-instance-identifier shop-dev-app-db --db-snapshot-identifier shop-dev-app-db-nanoflow-202610282015'));
  assert.ok(did(deps, 'rds wait db-snapshot-available --db-snapshot-identifier shop-dev-app-db-nanoflow-202610282015'));
  assert.ok(did(deps, 'rds create-db-cluster-snapshot --db-cluster-identifier shop-dev-events --db-cluster-snapshot-identifier shop-dev-events-nanoflow-202610282015'));
  assert.ok(did(deps, 'rds modify-db-instance --db-instance-identifier shop-dev-app-db --no-deletion-protection'));
  // El snapshot va antes que el borrado.
  const order = deps.calls.map((c) => c.slice(0, 4).join(' '));
  assert.ok(order.indexOf('rds create-db-snapshot --db-instance-identifier shop-dev-app-db')
    < order.indexOf('rds delete-db-instance --db-instance-identifier shop-dev-app-db'));
  assert.ok(did(deps, 'dynamodb create-backup --table-name shop-dev-orders --backup-name shop-dev-orders-nanoflow-202610282015'));

  assert.deepEqual(deps.tf, [['state', 'rm', 'module.db_app_db.aws_kms_key.this', 'module.db_events.aws_kms_key.this']]);
  assert.equal(out.retained.length, 2);
  assert.ok(out.retained.every((r) => r.type === 'aws_kms_key'));
  assert.deepEqual(out.snapshots.map((s) => `${s.kind}:${s.origin}`), ['aurora:destroy', 'rds:destroy', 'rds:pre-migration', 'dynamodb:destroy']);
});

test('prepare: «no existe» es hecho; otro error corta', () => {
  const ok = fakeDeps({
    's3api list-object-versions': awsErr('An error occurred (NoSuchBucket) when calling ListObjectVersions'),
    'rds delete-db-instance': awsErr('An error occurred (DBInstanceNotFound)'),
    'rds delete-db-cluster': awsErr('An error occurred (DBClusterNotFoundFault)'),
    'rds wait': awsErr('Waiter DBInstanceDeleted failed: DBInstanceNotFound'),
    'rds describe-db-snapshots': { DBSnapshots: [] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [] },
    'route53 list-resource-record-sets': awsErr('An error occurred (NoSuchHostedZone)'),
  });
  assert.doesNotThrow(() => prepare(stateFixture(), {}, ok));

  const bad = fakeDeps({
    's3api list-object-versions': awsErr('An error occurred (AccessDenied) when calling ListObjectVersions'),
  });
  assert.throws(() => prepare(stateFixture(), {}, bad), /AccessDenied/);
});

test('prepare: un borrado que choca con una modificación en curso se reintenta', () => {
  let n = 0;
  const deps = fakeDeps({
    's3api list-object-versions': {},
    'rds describe-db-snapshots': { DBSnapshots: [] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [] },
    'rds delete-db-instance --db-instance-identifier shop-dev-app-db': () => {
      if (n++ < 2) throw new AwsError(['rds', 'delete-db-instance'], 'An error occurred (InvalidDBInstanceState)');
      return {};
    },
    'route53 list-resource-record-sets': { ResourceRecordSets: [] },
  });
  prepare(stateFixture(), {}, deps);
  assert.equal(callsOf(deps, 'rds delete-db-instance --db-instance-identifier shop-dev-app-db').length, 3);
});

test('cleanup: solo lo que ya no está en el estado; secretos sin recuperación y snapshots de pre-migración', () => {
  const remaining = parseStateList('module.identity.aws_secretsmanager_secret.admin\nmodule.identity.aws_ecs_cluster.this\n');
  const deps = fakeDeps({
    'secretsmanager delete-secret': awsErr('An error occurred (InvalidRequestException): You can\'t perform this operation on the secret because it was marked for deletion.'),
    'secretsmanager restore-secret': {},
    'logs delete-log-group --log-group-name /aws/rds/cluster': awsErr('An error occurred (ResourceNotFoundException)'),
    'rds describe-db-snapshots': { DBSnapshots: [{ DBSnapshotIdentifier: 'shop-dev-app-db-pre-0003-9-1' }, { DBSnapshotIdentifier: 'mine-by-hand' }] },
    'rds describe-db-cluster-snapshots': { DBClusterSnapshots: [{ DBClusterSnapshotIdentifier: 'shop-dev-events-pre-0001-1-1' }] },
  });
  // El primer delete-secret falla (programado) → restore + delete otra vez.
  let first = true;
  const orig = deps.aws;
  deps.aws = (args) => {
    if (args[1] === 'delete-secret' && !first) { deps.calls.push(args); return {}; }
    if (args[1] === 'delete-secret') first = false;
    return orig(args);
  };
  const out = cleanup(stateFixture(), remaining, { keepSnapshots: false }, deps);

  const secretIds = callsOf(deps, 'secretsmanager delete-secret').map((c) => c[3]);
  assert.ok(secretIds.every((id) => id.includes('shop-dev-app-db-app')), secretIds.join(','));
  assert.ok(did(deps, 'secretsmanager restore-secret'));
  assert.equal(out.cleaned.secrets, 1);
  // El ECS sigue en el estado: su log group no se toca; el del clúster no existía.
  assert.equal(did(deps, 'logs delete-log-group --log-group-name /aws/ecs/'), false);
  assert.equal(out.cleaned.logGroups, 2); // instance + proxy
  assert.ok(did(deps, 'rds delete-db-snapshot --db-snapshot-identifier shop-dev-app-db-pre-0003-9-1'));
  assert.equal(did(deps, 'rds delete-db-snapshot --db-snapshot-identifier mine-by-hand'), false);
  assert.ok(did(deps, 'rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier shop-dev-events-pre-0001-1-1'));
  assert.equal(out.cleaned.snapshots, 2);
});

test('cleanup conservando: no borra snapshots; los fallos son avisos', () => {
  const deps = fakeDeps({
    'secretsmanager delete-secret': awsErr('An error occurred (AccessDeniedException)'),
  });
  const out = cleanup(stateFixture(), new Set(), { keepSnapshots: true }, deps);
  assert.equal(did(deps, 'rds describe-db-snapshots'), false);
  assert.equal(out.cleaned.secrets, 0);
  assert.equal(out.warnings.length, 2);
});

test('result: arma el resultado de §5.4', () => {
  const r = result(stateFixture(), new Set(['module.frontend.aws_s3_bucket.site']),
    { snapshots: [{ kind: 'rds', id: 's1' }], retained: [{ type: 'aws_kms_key', id: 'k' }], cleaned: { objects: 3, records: 2 }, warnings: ['a'] },
    { cleaned: { secrets: 1, logGroups: 2, snapshots: 0 }, warnings: ['b'] }, 2);
  assert.deepEqual(r, {
    remaining: 1, destroyed: 15, attempts: 2,
    snapshots: [{ kind: 'rds', id: 's1' }],
    retained: [{ type: 'aws_kms_key', id: 'k' }],
    cleaned: { objects: 3, records: 2, secrets: 1, logGroups: 2, snapshots: 0 },
    warnings: ['a', 'b'],
  });
  assert.equal(result(stateFixture(), new Set(), null, null, 1).remaining, 0);
});
