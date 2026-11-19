#!/usr/bin/env node
// destroy — la parte de AWS de terraform-destroy.yml (doc 29 de la consola,
// «Destruir la infraestructura de un ambiente»). Lee el estado de Terraform
// (`terraform show -json`) y hace lo que `terraform destroy` solo no puede con
// los repos ya generados: las protecciones y el snapshot final dependen del
// nombre del ambiente en las plantillas, el bucket del SPA no tiene
// force_destroy, la zona tiene registros que no son de Terraform y quedan
// recursos implícitos fuera del estado.
//
//   node destroy.js inventory <state.json> <plan.json> --out plan-report.json
//   node destroy.js prepare   <state.json> [--keep-snapshots true] --out prepare.json
//   node destroy.js cleanup   <pre-state.json> --remaining state-list.txt [--keep-snapshots true] --out cleanup.json
//   node destroy.js result    <pre-state.json> --remaining state-list.txt [--prepare prepare.json]
//                             [--cleanup cleanup.json] [--attempts n] --out result.json
//
// inventory corre con el rol de PLAN (solo lectura): cuenta lo que tiene datos
// (bases y sus snapshots, objetos de los buckets, ítems, usuarios, registros
// DNS ajenos) para que la consola lo muestre antes de confirmar. prepare y
// cleanup corren con el rol de APPLY, antes y después del destroy.
//
// El estado trae contraseñas: de cada recurso se leen solo tipo, nombre,
// identificadores y ARNs; nunca se imprime ni se reenvía un `values` entero.
// Sin dependencias: corre con el node de los runners y la CLI `aws`.
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { summarize, parseArgs } = require('../report-plan/summarize.js');

// ---------------------------------------------------------------------------
// Lectura del estado (puro)
// ---------------------------------------------------------------------------

/** Recursos gestionados del estado, con el módulo al que pertenecen. */
function resources(state) {
  const out = [];
  const walk = (mod) => {
    if (!mod) return;
    for (const r of mod.resources || []) {
      if (r.mode && r.mode !== 'managed') continue; // data sources
      out.push({ ...r, module: mod.address || '' });
    }
    for (const c of mod.child_modules || []) walk(c);
  };
  walk(state && state.values && state.values.root_module);
  return out;
}

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** Lo que importa de cada recurso para destruir, sin valores sensibles. */
function facts(state) {
  const f = {
    total: 0,
    buckets: [], instances: [], clusters: [], clusterInstances: [], proxies: [],
    tables: [], userPools: [], zones: [], records: [], secrets: [],
    distributions: 0, kmsKeys: [], ecsClusters: [], auth0Connections: [],
  };
  for (const r of resources(state)) {
    f.total++;
    const v = r.values || {};
    const base = { address: r.address, module: r.module };
    switch (r.type) {
      case 'aws_s3_bucket':
        if (str(v.bucket)) f.buckets.push({ ...base, name: v.bucket });
        break;
      case 'aws_db_instance':
        if (str(v.identifier)) {
          f.instances.push({
            ...base, identifier: v.identifier, engine: str(v.engine),
            allocatedGb: Number.isFinite(v.allocated_storage) ? v.allocated_storage : null,
            deletionProtection: v.deletion_protection === true, kmsKeyId: str(v.kms_key_id),
          });
        }
        break;
      case 'aws_rds_cluster':
        if (str(v.cluster_identifier)) {
          f.clusters.push({
            ...base, identifier: v.cluster_identifier, engine: str(v.engine),
            deletionProtection: v.deletion_protection === true, kmsKeyId: str(v.kms_key_id),
          });
        }
        break;
      case 'aws_rds_cluster_instance':
        if (str(v.identifier)) f.clusterInstances.push({ ...base, identifier: v.identifier, cluster: str(v.cluster_identifier) });
        break;
      case 'aws_db_proxy':
        if (str(v.name)) f.proxies.push({ ...base, name: v.name });
        break;
      case 'aws_dynamodb_table':
        if (str(v.name)) f.tables.push({ ...base, name: v.name, deletionProtection: v.deletion_protection_enabled === true });
        break;
      case 'aws_cognito_user_pool':
        if (str(v.id)) f.userPools.push({ ...base, id: v.id, name: str(v.name), deletionProtection: v.deletion_protection === 'ACTIVE' });
        break;
      case 'aws_route53_zone':
        if (str(v.zone_id || v.id) && str(v.name)) f.zones.push({ ...base, id: zoneId(v.zone_id || v.id), name: v.name });
        break;
      case 'aws_route53_record':
        if (str(v.name) && str(v.type)) {
          f.records.push({ zoneId: zoneId(v.zone_id || ''), name: v.name, type: v.type, setIdentifier: v.set_identifier || '' });
        }
        break;
      case 'aws_secretsmanager_secret':
        if (str(v.arn)) f.secrets.push({ ...base, arn: v.arn, name: str(v.name) });
        break;
      case 'aws_cloudfront_distribution':
        f.distributions++;
        break;
      case 'aws_kms_key':
        if (str(v.key_id) || str(v.arn)) f.kmsKeys.push({ ...base, keyId: str(v.key_id), arn: str(v.arn) });
        break;
      case 'aws_ecs_cluster':
        if (str(v.name)) f.ecsClusters.push({ ...base, name: v.name });
        break;
      case 'auth0_connection':
        if (str(v.name)) f.auth0Connections.push(v.name);
        break;
      default:
    }
  }
  return f;
}

const zoneId = (id) => String(id || '').replace(/^\/?hostedzone\//, '');

/** Nombre DNS comparable: minúsculas, sin punto final y con `*` en vez de \052. */
function dnsName(name, zone) {
  let n = String(name || '').toLowerCase().replace(/\\052/g, '*').replace(/\.$/, '');
  const z = zone ? dnsName(zone) : '';
  if (z && n !== z && !n.endsWith('.' + z)) n = `${n}.${z}`; // nombre relativo a la zona
  return n;
}

const recordKey = (name, type, setIdentifier, zone) => `${dnsName(name, zone)}|${type}|${setIdentifier || ''}`;

/**
 * Registros de la zona que Terraform no gestiona (los puso el usuario u otro
 * sistema) y que impiden borrarla. El SOA y el NS del apex quedan: se van con
 * la zona.
 */
function foreignRecords(zone, recordSets, stateRecords) {
  const apex = dnsName(zone.name);
  const managed = new Set(stateRecords
    .filter((r) => !r.zoneId || r.zoneId === zone.id)
    .map((r) => recordKey(r.name, r.type, r.setIdentifier, zone.name)));
  return (recordSets || []).filter((rs) => {
    if (dnsName(rs.Name) === apex && (rs.Type === 'SOA' || rs.Type === 'NS')) return false;
    return !managed.has(recordKey(rs.Name, rs.Type, rs.SetIdentifier, zone.name));
  });
}

/** Log groups que AWS crea solo (fuera de Terraform) para estos recursos. */
function implicitLogGroups(f, keep = () => true) {
  return [
    ...f.instances.filter((i) => keep(i.address)).map((i) => `/aws/rds/instance/${i.identifier}/postgresql`),
    ...f.clusters.filter((c) => keep(c.address)).map((c) => `/aws/rds/cluster/${c.identifier}/postgresql`),
    ...f.proxies.filter((p) => keep(p.address)).map((p) => `/aws/rds/proxy/${p.name}`),
    ...f.ecsClusters.filter((c) => keep(c.address)).map((c) => `/aws/ecs/containerinsights/${c.name}/performance`),
  ];
}

/** Llaves KMS que cifran una base (por ARN o, si no se resolvió, por módulo). */
function databaseKeys(f) {
  const dbs = [...f.instances, ...f.clusters];
  return f.kmsKeys.filter((k) => dbs.some((d) =>
    (d.kmsKeyId && (d.kmsKeyId === k.arn || d.kmsKeyId === k.keyId)) || (!d.kmsKeyId && d.module && d.module === k.module)));
}

/** Bases que usan Supabase (modo connect): sus datos no los creó NanoFlow y quedan. */
function supabaseBases(plan) {
  const calls = (plan && plan.configuration && plan.configuration.root_module && plan.configuration.root_module.module_calls) || {};
  return Object.entries(calls)
    .filter(([, c]) => /(^|\/)data\/supabase\/?$/.test(String((c && c.source) || '')))
    .map(([key]) => ({ kind: 'supabase', name: key.replace(/^db_/, '').replace(/_/g, '-') }));
}

/** Direcciones gestionadas que siguen en el estado (`terraform state list`). */
function parseStateList(text) {
  return new Set(String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/(^|\.)data\./.test(l)));
}

/** yyyymmddhhmm en UTC: sufijo de los snapshots que crea la destrucción. */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// AWS (con dependencias inyectables para las pruebas)
// ---------------------------------------------------------------------------

const NOT_FOUND = /NotFound|NoSuch[A-Za-z]+|ResourceNotFoundException|DBInstanceNotFound|DBClusterNotFoundFault|DBSnapshotNotFound|does not exist|could not be found/i;

class AwsError extends Error {
  constructor(args, stderr) {
    const detail = String(stderr || '').trim().split('\n').filter(Boolean).pop() || 'error desconocido';
    super(`aws ${args.slice(0, 2).join(' ')}: ${detail.slice(0, 300)}`);
    this.stderr = String(stderr || '');
  }
  get notFound() { return NOT_FOUND.test(this.stderr); }
  has(re) { return re.test(this.stderr); }
}

function realDeps(cwd) {
  return {
    aws(args) {
      try {
        const out = execFileSync('aws', [...args, '--output', 'json'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
        });
        return out.trim() ? JSON.parse(out) : null;
      } catch (e) {
        throw new AwsError(args, e.stderr || e.message);
      }
    },
    terraform(args) {
      execFileSync('terraform', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
    log: (msg) => process.stdout.write(msg + '\n'),
    now: () => new Date(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

/** Llamada idempotente: «no existe» cuenta como hecho. Devuelve false en ese caso. */
function idempotent(deps, args) {
  try {
    deps.aws(args);
    return true;
  } catch (e) {
    if (e instanceof AwsError && e.notFound) return false;
    throw e;
  }
}

/** Un waiter de la CLI (máx. ~15–30 min) repetido hasta `rounds` veces. */
function waitFor(deps, args, rounds = 4) {
  for (let i = 1; ; i++) {
    try {
      deps.aws(['rds', 'wait', ...args]);
      return;
    } catch (e) {
      if (e instanceof AwsError && e.has(/Max attempts exceeded/i) && i < rounds) continue;
      if (e instanceof AwsError && e.notFound && /deleted$/.test(args[0])) return;
      throw e;
    }
  }
}

/** Un borrado que puede chocar con una modificación en curso: reintenta. */
function retryBusy(deps, args, tries = 10) {
  for (let i = 1; ; i++) {
    try {
      return idempotent(deps, args);
    } catch (e) {
      if (e instanceof AwsError && e.has(/Invalid(DBInstance|DBCluster)State|ResourceInUse/i) && i < tries) {
        deps.sleep(20000);
        continue;
      }
      throw e;
    }
  }
}

const short = (e) => String((e && e.message) || e).slice(0, 300);

/** Snapshots manuales de una base (sobreviven a la base). */
function manualSnapshots(deps, db, cluster) {
  const res = cluster
    ? deps.aws(['rds', 'describe-db-cluster-snapshots', '--db-cluster-identifier', db.identifier, '--snapshot-type', 'manual'])
    : deps.aws(['rds', 'describe-db-snapshots', '--db-instance-identifier', db.identifier, '--snapshot-type', 'manual']);
  const list = (res && (cluster ? res.DBClusterSnapshots : res.DBSnapshots)) || [];
  return list.map((s) => ({
    id: cluster ? s.DBClusterSnapshotIdentifier : s.DBSnapshotIdentifier,
    createdAt: s.SnapshotCreateTime || null,
  })).filter((s) => s.id);
}

const isPreMigration = (db, snapId) => snapId.startsWith(`${db.identifier}-pre-`);
const isOwn = (db, snapId) => isPreMigration(db, snapId) || snapId.startsWith(`${db.identifier}-nanoflow-`);

// ---------------------------------------------------------------------------
// inventory (rol de plan, solo lectura)
// ---------------------------------------------------------------------------

function inventory(state, plan, deps) {
  const f = facts(state);
  const warnings = [];
  const attempt = (what, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      warnings.push(`No se pudo leer ${what}: ${short(e)}`);
      return fallback;
    }
  };

  const databases = [
    ...f.instances.map((i) => ({
      kind: 'rds', identifier: i.identifier, engine: i.engine, allocatedGb: i.allocatedGb,
      deletionProtection: i.deletionProtection,
      snapshots: attempt(`los snapshots de ${i.identifier}`, () => manualSnapshots(deps, i, false), []),
    })),
    ...f.clusters.map((c) => ({
      kind: 'aurora', identifier: c.identifier, engine: c.engine, allocatedGb: null,
      deletionProtection: c.deletionProtection,
      snapshots: attempt(`los snapshots de ${c.identifier}`, () => manualSnapshots(deps, c, true), []),
    })),
  ];

  const buckets = f.buckets.map((b) => attempt(`el bucket ${b.name}`, () => {
    const r = deps.aws(['s3api', 'list-objects-v2', '--bucket', b.name, '--max-keys', '1000', '--no-paginate']) || {};
    return { name: b.name, objects: r.KeyCount || 0, truncated: r.IsTruncated === true };
  }, { name: b.name, objects: null, truncated: false }));

  const tables = f.tables.map((t) => attempt(`la tabla ${t.name}`, () => {
    const r = (deps.aws(['dynamodb', 'describe-table', '--table-name', t.name]) || {}).Table || {};
    const protectedNow = typeof r.DeletionProtectionEnabled === 'boolean' ? r.DeletionProtectionEnabled : t.deletionProtection;
    return { name: t.name, items: Number.isFinite(r.ItemCount) ? r.ItemCount : null, deletionProtection: protectedNow };
  }, { name: t.name, items: null, deletionProtection: t.deletionProtection }));

  const userPools = f.userPools.map((p) => attempt(`el user pool ${p.name || p.id}`, () => {
    const r = (deps.aws(['cognito-idp', 'describe-user-pool', '--user-pool-id', p.id]) || {}).UserPool || {};
    return { id: p.id, name: p.name, users: Number.isFinite(r.EstimatedNumberOfUsers) ? r.EstimatedNumberOfUsers : null };
  }, { id: p.id, name: p.name, users: null }));

  const zones = f.zones.map((z) => attempt(`la zona ${z.name}`, () => {
    const r = deps.aws(['route53', 'list-resource-record-sets', '--hosted-zone-id', z.id]) || {};
    const foreign = foreignRecords(z, r.ResourceRecordSets, f.records).map((rs) => ({ name: rs.Name, type: rs.Type }));
    return { name: z.name, id: z.id, foreignRecords: foreign };
  }, { name: z.name, id: z.id, foreignRecords: [] }));

  const logGroups = implicitLogGroups(f).filter((name) => attempt(`el log group ${name}`, () => {
    const r = deps.aws(['logs', 'describe-log-groups', '--log-group-name-prefix', name]) || {};
    return (r.logGroups || []).some((g) => g.logGroupName === name);
  }, false));

  return {
    summary: summarize(plan),
    inventory: {
      resources: f.total,
      noState: f.total === 0,
      databases, buckets, tables, userPools,
      auth0: { connections: f.auth0Connections },
      zones,
      secrets: f.secrets.length,
      distributions: f.distributions,
      kmsKeys: f.kmsKeys.length,
      logGroups,
      survives: supabaseBases(plan),
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// prepare (rol de apply, antes del destroy)
// ---------------------------------------------------------------------------

/** Vacía un bucket: todas las versiones y marcas de borrado. Devuelve cuántas borró. */
function emptyBucket(deps, name) {
  let deleted = 0;
  for (let page = 0; page < 100000; page++) {
    let r;
    try {
      r = deps.aws(['s3api', 'list-object-versions', '--bucket', name, '--max-keys', '1000', '--no-paginate']) || {};
    } catch (e) {
      if (e instanceof AwsError && e.notFound) return deleted;
      throw e;
    }
    const objects = [...(r.Versions || []), ...(r.DeleteMarkers || [])]
      .map((o) => ({ Key: o.Key, VersionId: o.VersionId }))
      .filter((o) => o.Key);
    if (objects.length === 0) return deleted;
    const res = deps.aws(['s3api', 'delete-objects', '--bucket', name, '--delete', JSON.stringify({ Objects: objects, Quiet: true })]) || {};
    if (res.Errors && res.Errors.length) {
      throw new Error(`no se pudieron borrar ${res.Errors.length} objetos de ${name}: ${res.Errors[0].Code || ''} ${res.Errors[0].Message || ''}`.trim());
    }
    deleted += objects.length;
  }
  throw new Error(`el bucket ${name} no terminó de vaciarse`);
}

function prepare(state, { keepSnapshots = false } = {}, deps) {
  const f = facts(state);
  const out = { snapshots: [], retained: [], cleaned: { objects: 0, records: 0 }, warnings: [] };
  const ts = stamp(deps.now());

  // 1) Buckets: el deploy de la app los llenó (s3 sync) y no tienen force_destroy.
  for (const b of f.buckets) {
    const n = emptyBucket(deps, b.name);
    out.cleaned.objects += n;
    deps.log(`Bucket ${b.name}: ${n} objetos borrados.`);
  }

  // 2) Aurora: snapshot (si se conserva), sin protección, instancias y clúster
  //    sin snapshot final (el nombre fijo de las plantillas chocaría).
  for (const c of f.clusters) {
    if (keepSnapshots) {
      const id = `${c.identifier}-nanoflow-${ts}`;
      deps.log(`Snapshot ${id} del clúster ${c.identifier}…`);
      deps.aws(['rds', 'create-db-cluster-snapshot', '--db-cluster-identifier', c.identifier, '--db-cluster-snapshot-identifier', id]);
      waitFor(deps, ['db-cluster-snapshot-available', '--db-cluster-snapshot-identifier', id]);
      out.snapshots.push({ kind: 'aurora', id, source: c.identifier, origin: 'destroy' });
      keptPreMigration(deps, c, true, out);
    } else {
      warnUserSnapshots(deps, c, true, out);
    }
    if (c.deletionProtection) {
      idempotent(deps, ['rds', 'modify-db-cluster', '--db-cluster-identifier', c.identifier, '--no-deletion-protection', '--apply-immediately']);
    }
    const members = f.clusterInstances.filter((i) => i.cluster === c.identifier);
    for (const i of members) retryBusy(deps, ['rds', 'delete-db-instance', '--db-instance-identifier', i.identifier]);
    for (const i of members) waitFor(deps, ['db-instance-deleted', '--db-instance-identifier', i.identifier]);
    retryBusy(deps, ['rds', 'delete-db-cluster', '--db-cluster-identifier', c.identifier, '--skip-final-snapshot', '--delete-automated-backups']);
    waitFor(deps, ['db-cluster-deleted', '--db-cluster-identifier', c.identifier]);
    deps.log(`Clúster ${c.identifier} borrado.`);
  }

  // 3) RDS: igual, con la instancia.
  for (const i of f.instances) {
    if (keepSnapshots) {
      const id = `${i.identifier}-nanoflow-${ts}`;
      deps.log(`Snapshot ${id} de ${i.identifier}…`);
      deps.aws(['rds', 'create-db-snapshot', '--db-instance-identifier', i.identifier, '--db-snapshot-identifier', id]);
      waitFor(deps, ['db-snapshot-available', '--db-snapshot-identifier', id]);
      out.snapshots.push({ kind: 'rds', id, source: i.identifier, origin: 'destroy' });
      keptPreMigration(deps, i, false, out);
    } else {
      warnUserSnapshots(deps, i, false, out);
    }
    if (i.deletionProtection) {
      idempotent(deps, ['rds', 'modify-db-instance', '--db-instance-identifier', i.identifier, '--no-deletion-protection', '--apply-immediately']);
    }
    retryBusy(deps, ['rds', 'delete-db-instance', '--db-instance-identifier', i.identifier, '--skip-final-snapshot', '--delete-automated-backups']);
    waitFor(deps, ['db-instance-deleted', '--db-instance-identifier', i.identifier]);
    deps.log(`Base ${i.identifier} borrada.`);
  }

  // 4) DynamoDB: backup bajo demanda (sobrevive a la tabla) y sin protección.
  for (const t of f.tables) {
    if (keepSnapshots) {
      const name = `${t.name}-nanoflow-${ts}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 255);
      const r = deps.aws(['dynamodb', 'create-backup', '--table-name', t.name, '--backup-name', name]) || {};
      out.snapshots.push({ kind: 'dynamodb', id: (r.BackupDetails && r.BackupDetails.BackupArn) || name, source: t.name, origin: 'destroy' });
    }
    if (t.deletionProtection && idempotent(deps, ['dynamodb', 'update-table', '--table-name', t.name, '--no-deletion-protection-enabled'])) {
      deps.aws(['dynamodb', 'wait', 'table-exists', '--table-name', t.name]);
    }
  }

  // 5) Cognito: sin protección (el pool se borra a continuación).
  for (const p of f.userPools.filter((u) => u.deletionProtection)) {
    idempotent(deps, ['cognito-idp', 'update-user-pool', '--user-pool-id', p.id, '--deletion-protection', 'INACTIVE']);
  }

  // 6) Zonas: los registros que no son de Terraform impiden borrarlas.
  for (const z of f.zones) {
    let r;
    try {
      r = deps.aws(['route53', 'list-resource-record-sets', '--hosted-zone-id', z.id]) || {};
    } catch (e) {
      if (e instanceof AwsError && e.notFound) continue;
      throw e;
    }
    const foreign = foreignRecords(z, r.ResourceRecordSets, f.records);
    for (let k = 0; k < foreign.length; k += 100) {
      const changes = foreign.slice(k, k + 100).map((rs) => ({ Action: 'DELETE', ResourceRecordSet: rs }));
      deps.aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', z.id,
        '--change-batch', JSON.stringify({ Comment: 'NanoFlow: destruir el ambiente', Changes: changes })]);
    }
    out.cleaned.records += foreign.length;
    if (foreign.length) deps.log(`Zona ${z.name}: ${foreign.length} registros ajenos borrados.`);
  }

  // 7) La llave KMS de una base cuyos snapshots se conservan sale del estado:
  //    si Terraform la programara para borrarse, los snapshots quedarían
  //    inservibles. El alias sí se borra (si no, recrear el ambiente chocaría).
  if (keepSnapshots) {
    const keys = databaseKeys(f);
    if (keys.length) {
      deps.terraform(['state', 'rm', ...keys.map((k) => k.address)]);
      for (const k of keys) {
        out.retained.push({ type: 'aws_kms_key', id: k.arn || k.keyId, reason: 'cifra los snapshots conservados: bórrala cuando ya no los necesites' });
      }
    }
  }
  return out;
}

/** Con «conservar», los snapshots de pre-migración también se quedan (y se listan). */
function keptPreMigration(deps, db, cluster, out) {
  try {
    for (const s of manualSnapshots(deps, db, cluster).filter((x) => isPreMigration(db, x.id))) {
      out.snapshots.push({ kind: cluster ? 'aurora' : 'rds', id: s.id, source: db.identifier, origin: 'pre-migration' });
    }
  } catch (e) {
    out.warnings.push(`No se pudieron listar los snapshots de ${db.identifier}: ${short(e)}`);
  }
}

/** Sin «conservar»: los snapshots que hizo el usuario quedarán sin su llave. */
function warnUserSnapshots(deps, db, cluster, out) {
  try {
    const user = manualSnapshots(deps, db, cluster).filter((x) => !isOwn(db, x.id));
    if (user.length) {
      out.warnings.push(`${user.length} snapshot(s) manuales de ${db.identifier} (${user.map((s) => s.id).join(', ')}) quedan, pero su llave KMS se programa para borrarse: después ya no se podrán restaurar.`);
    }
  } catch (e) {
    out.warnings.push(`No se pudieron listar los snapshots de ${db.identifier}: ${short(e)}`);
  }
}

// ---------------------------------------------------------------------------
// cleanup (rol de apply, después del destroy)
// ---------------------------------------------------------------------------

/** Borra un secreto sin ventana de recuperación (libera el nombre). */
function forceDeleteSecret(deps, arn) {
  const del = ['secretsmanager', 'delete-secret', '--secret-id', arn, '--force-delete-without-recovery'];
  try {
    deps.aws(del);
    return true;
  } catch (e) {
    if (!(e instanceof AwsError)) throw e;
    if (e.notFound) return false;
    // Ya programado para borrarse: se restaura y se borra en el acto.
    if (e.has(/marked for deletion|scheduled for deletion/i)) {
      deps.aws(['secretsmanager', 'restore-secret', '--secret-id', arn]);
      deps.aws(del);
      return true;
    }
    throw e;
  }
}

function cleanup(preState, remaining, { keepSnapshots = false } = {}, deps) {
  const f = facts(preState);
  const gone = (address) => !remaining.has(address);
  const out = { cleaned: { secrets: 0, logGroups: 0, snapshots: 0 }, warnings: [] };
  const soft = (what, fn) => {
    try {
      return fn();
    } catch (e) {
      out.warnings.push(`No se pudo borrar ${what}: ${short(e)}`);
      return false;
    }
  };

  for (const s of f.secrets.filter((x) => gone(x.address))) {
    if (soft(`el secreto ${s.name || s.arn}`, () => forceDeleteSecret(deps, s.arn))) out.cleaned.secrets++;
  }
  for (const name of implicitLogGroups(f, gone)) {
    if (soft(`el log group ${name}`, () => idempotent(deps, ['logs', 'delete-log-group', '--log-group-name', name]))) out.cleaned.logGroups++;
  }
  if (!keepSnapshots) {
    const dbs = [
      ...f.instances.filter((i) => gone(i.address)).map((d) => [d, false]),
      ...f.clusters.filter((c) => gone(c.address)).map((d) => [d, true]),
    ];
    for (const [db, cluster] of dbs) {
      const snaps = soft(`los snapshots de ${db.identifier}`, () => manualSnapshots(deps, db, cluster)) || [];
      for (const s of snaps.filter((x) => isPreMigration(db, x.id))) {
        const args = cluster
          ? ['rds', 'delete-db-cluster-snapshot', '--db-cluster-snapshot-identifier', s.id]
          : ['rds', 'delete-db-snapshot', '--db-snapshot-identifier', s.id];
        if (soft(`el snapshot ${s.id}`, () => idempotent(deps, args))) out.cleaned.snapshots++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function result(preState, remaining, prepared, cleaned, attempts) {
  const f = facts(preState);
  const p = prepared || {};
  const c = cleaned || {};
  const retained = p.retained || [];
  return {
    remaining: remaining.size,
    destroyed: Math.max(0, f.total - remaining.size - retained.length),
    attempts,
    snapshots: p.snapshots || [],
    retained,
    cleaned: {
      objects: (p.cleaned && p.cleaned.objects) || 0,
      records: (p.cleaned && p.cleaned.records) || 0,
      secrets: (c.cleaned && c.cleaned.secrets) || 0,
      logGroups: (c.cleaned && c.cleaned.logGroups) || 0,
      snapshots: (c.cleaned && c.cleaned.snapshots) || 0,
    },
    warnings: [...(p.warnings || []), ...(c.warnings || [])],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJSON(path) {
  if (!path || !fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readText(path) {
  return path && fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
}

function main(argv, deps = realDeps(process.cwd())) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const keep = args['keep-snapshots'] === 'true';
  const write = (obj) => {
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(obj) + '\n');
    return obj;
  };
  switch (command) {
    case 'inventory': {
      const r = write(inventory(readJSON(args._[0]), readJSON(args._[1]), deps));
      const i = r.inventory;
      deps.log(`Inventario: ${i.resources} recursos · ${r.summary.delete} a destruir · ${i.databases.length} bases · ${i.buckets.length} buckets · ${i.zones.length} zonas.`);
      for (const w of i.warnings) deps.log(`::warning::${w}`);
      return r;
    }
    case 'prepare': {
      const r = write(prepare(readJSON(args._[0]), { keepSnapshots: keep }, deps));
      deps.log(`Preparado: ${r.cleaned.objects} objetos y ${r.cleaned.records} registros borrados, ${r.snapshots.length} snapshots conservados.`);
      for (const w of r.warnings) deps.log(`::warning::${w}`);
      return r;
    }
    case 'cleanup': {
      const r = write(cleanup(readJSON(args._[0]), parseStateList(readText(args.remaining)), { keepSnapshots: keep }, deps));
      deps.log(`Limpieza: ${r.cleaned.secrets} secretos, ${r.cleaned.logGroups} log groups y ${r.cleaned.snapshots} snapshots de pre-migración.`);
      for (const w of r.warnings) deps.log(`::warning::${w}`);
      return r;
    }
    case 'result': {
      const r = write(result(readJSON(args._[0]), parseStateList(readText(args.remaining)),
        readJSON(args.prepare), readJSON(args.cleanup), Number(args.attempts) || 0));
      deps.log(`Quedan ${r.remaining} recursos en el estado; destruidos ${r.destroyed}.`);
      return r;
    }
    default:
      throw new Error(`comando desconocido: ${command || '(vacío)'} (inventory | prepare | cleanup | result)`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`::error::${short(e)}\n`);
    process.exit(1);
  }
}

module.exports = {
  resources, facts, foreignRecords, implicitLogGroups, databaseKeys, supabaseBases,
  parseStateList, stamp, dnsName, inventory, prepare, cleanup, result, main, AwsError,
};
