'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { facts, supabaseBases, parseStateList, inventory, result, main } = require('./destroy.js');

// Estado como el de `terraform show -json` de un ambiente del blueprint de
// Azure: base, un servicio en contenedor, API, SPA y una base de Supabase. Los
// `values` traen, como el real, secretos que nunca deben salir.
function stateFixture({ production = false } = {}) {
  const r = (address, type, values) => ({ address, mode: 'managed', type, name: address.split('.').pop(), values });
  return {
    format_version: '1.0',
    values: {
      root_module: {
        resources: [
          { address: 'data.azurerm_resource_group.this', mode: 'data', type: 'azurerm_resource_group', name: 'this', values: { name: 'rg-shop-dev-1a2b' } },
        ],
        child_modules: [
          {
            address: 'module.foundation',
            resources: [
              r('module.foundation.azurerm_log_analytics_workspace.this', 'azurerm_log_analytics_workspace', { name: 'log-shop-dev', retention_in_days: 30, primary_shared_key: 'clave-del-workspace' }),
              r('module.foundation.azurerm_application_insights.this', 'azurerm_application_insights', { name: 'appi-shop-dev', connection_string: 'InstrumentationKey=secreta' }),
              r('module.foundation.azurerm_key_vault.this', 'azurerm_key_vault', {
                name: 'kvshopdev1a2b3c', soft_delete_retention_days: production ? 90 : 7, purge_protection_enabled: production,
              }),
              r('module.foundation.azurerm_container_app_environment.this', 'azurerm_container_app_environment', { name: 'cae-shop-dev' }),
              r('module.foundation.azurerm_container_registry.this', 'azurerm_container_registry', { name: 'crshopdev1a2b3c', admin_password: 'no-debe-salir' }),
            ],
          },
          {
            address: 'module.db_app',
            resources: [
              r('module.db_app.azurerm_key_vault_secret.app', 'azurerm_key_vault_secret', { name: 'db-app-app', value: 'postgres://usuario:super-secreta@host/db' }),
              r('module.db_app.azurerm_key_vault_secret.admin', 'azurerm_key_vault_secret', { name: 'db-app-admin', value: 'otra-secreta' }),
              r('module.db_app.terraform_data.secrets_ready', 'terraform_data', {}),
            ],
          },
          {
            address: 'module.svc_orders',
            resources: [
              r('module.svc_orders.azurerm_user_assigned_identity.this', 'azurerm_user_assigned_identity', { name: 'id-shop-dev-orders' }),
              r('module.svc_orders.azurerm_container_app.this', 'azurerm_container_app', { name: 'ca-shop-dev-orders' }),
            ],
          },
          {
            address: 'module.api',
            resources: [
              r('module.api.azurerm_api_management.this', 'azurerm_api_management', { name: 'apim-shop-dev-1a2b3c' }),
              r('module.api.azurerm_api_management_api.service["orders"]', 'azurerm_api_management_api', { name: 'orders' }),
            ],
          },
          {
            address: 'module.frontend',
            resources: [r('module.frontend.azurerm_static_web_app.this', 'azurerm_static_web_app', { name: 'stapp-shop-dev', api_key: 'token-de-despliegue' })],
          },
        ],
      },
    },
  };
}

function planFixture() {
  const del = (address, type) => ({ address, type, change: { actions: ['delete'] } });
  return {
    resource_changes: [
      del('module.foundation.azurerm_key_vault.this', 'azurerm_key_vault'),
      del('module.foundation.azurerm_container_registry.this', 'azurerm_container_registry'),
      del('module.svc_orders.azurerm_container_app.this', 'azurerm_container_app'),
    ],
    configuration: {
      root_module: {
        module_calls: {
          foundation: { source: '../../modules/azure/foundation' },
          db_app: { source: '../../modules/azure/data/supabase' },
          db_orders_archive: { source: '../../modules/azure/data/supabase/' },
          svc_orders: { source: '../../modules/azure/compute/container-app' },
        },
      },
    },
  };
}

test('facts lee nombres y ajustes, no datos de fuentes', () => {
  const f = facts(stateFixture());
  assert.equal(f.total, 13);
  assert.deepEqual(f.keyVaults, [{ name: 'kvshopdev1a2b3c', softDeleteDays: 7, purgeProtection: false }]);
  assert.equal(f.secrets, 2);
  assert.deepEqual(f.registries, ['crshopdev1a2b3c']);
  assert.deepEqual(f.workspaces, [{ name: 'log-shop-dev', retentionDays: 30 }]);
  assert.deepEqual(f.containerApps, ['ca-shop-dev-orders']);
  assert.deepEqual(f.apiManagement, ['apim-shop-dev-1a2b3c']);
  assert.deepEqual(f.staticSites, ['stapp-shop-dev']);
});

test('facts de un estado vacío o ausente', () => {
  for (const state of [null, {}, { values: {} }, { values: { root_module: { resources: [] } } }]) {
    const f = facts(state);
    assert.equal(f.total, 0);
    assert.deepEqual(f.keyVaults, []);
  }
});

test('inventory resume el plan y dice qué se pierde, sin ningún valor del estado', () => {
  const r = inventory(stateFixture(), planFixture());
  assert.equal(r.summary.delete, 3);
  const i = r.inventory;
  assert.equal(i.resources, 13);
  assert.equal(i.noState, false);
  assert.equal(i.secrets, 2);
  assert.deepEqual(i.survives, [{ kind: 'supabase', name: 'app' }, { kind: 'supabase', name: 'orders-archive' }]);
  // Lo que el blueprint de Azure no crea viaja vacío: el contrato es el de AWS.
  for (const k of ['databases', 'buckets', 'tables', 'userPools', 'zones', 'logGroups']) assert.deepEqual(i[k], [], k);
  assert.deepEqual(i.azure.containerApps, ['ca-shop-dev-orders']);
  assert.ok(i.warnings.some((w) => w.includes('crshopdev1a2b3c') && w.includes('imágenes')));
  assert.ok(i.warnings.some((w) => w.includes('log-shop-dev')));
  assert.ok(i.warnings.some((w) => w.includes('2 secretos')));
  assert.ok(i.warnings.some((w) => w.includes('kvshopdev1a2b3c') && w.includes('hasta 7 días')));
  assert.ok(i.warnings.some((w) => w.includes('apim-shop-dev-1a2b3c') && w.includes('48 horas')));
  const text = JSON.stringify(r);
  for (const secret of ['super-secreta', 'otra-secreta', 'no-debe-salir', 'token-de-despliegue', 'clave-del-workspace', 'InstrumentationKey']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('inventory avisa de la protección de purga en producción', () => {
  const i = inventory(stateFixture({ production: true }), planFixture()).inventory;
  assert.ok(i.warnings.some((w) => w.includes('protección de purga') && w.includes('90 días')));
  assert.equal(i.azure.keyVaults[0].purgeProtection, true);
});

test('inventory sin estado: no hay nada que destruir', () => {
  const r = inventory({ values: { root_module: { resources: [] } } }, { resource_changes: [] });
  assert.equal(r.summary.delete, 0);
  assert.equal(r.inventory.noState, true);
  assert.deepEqual(r.inventory.warnings, []);
});

test('supabaseBases solo mira el módulo de Supabase', () => {
  assert.deepEqual(supabaseBases(null), []);
  assert.deepEqual(supabaseBases({ configuration: { root_module: { module_calls: { x: { source: '../../modules/azure/api' } } } } }), []);
});

test('parseStateList deja fuera las fuentes de datos y las líneas vacías', () => {
  const s = parseStateList('data.azurerm_resource_group.this\nmodule.api.azurerm_api_management.this\n\nmodule.a.data.azurerm_client_config.x\n');
  assert.deepEqual([...s], ['module.api.azurerm_api_management.this']);
});

test('result de un destroy completo avisa del borrado suave de lo que ya salió', () => {
  const r = result(stateFixture(), parseStateList(''), 1);
  assert.equal(r.remaining, 0);
  assert.equal(r.destroyed, 13);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.snapshots, []);
  assert.deepEqual(r.retained, []);
  assert.equal(r.warnings.length, 2);
});

test('result de un destroy a medias no avisa de lo que sigue en el estado', () => {
  const remaining = parseStateList('module.foundation.azurerm_key_vault.this\nmodule.api.azurerm_api_management.this\nmodule.api.azurerm_api_management_api.service["orders"]\n');
  const r = result(stateFixture(), remaining, 3);
  assert.equal(r.remaining, 3);
  assert.equal(r.destroyed, 10);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.warnings, []);
});

test('main escribe los archivos que lee el workflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-azure-destroy-'));
  const state = path.join(dir, 'state.json');
  const plan = path.join(dir, 'plan.json');
  const remaining = path.join(dir, 'remaining.txt');
  fs.writeFileSync(state, JSON.stringify(stateFixture()));
  fs.writeFileSync(plan, JSON.stringify(planFixture()));
  fs.writeFileSync(remaining, '');
  const lines = [];
  main(['inventory', state, plan, '--out', path.join(dir, 'plan-report.json')], (l) => lines.push(l));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'plan-report.json'), 'utf8'));
  assert.equal(report.summary.delete, 3);
  assert.ok(lines[0].startsWith('Inventario: 13 recursos · 3 a destruir'));
  main(['result', state, '--remaining', remaining, '--attempts', '2', '--out', path.join(dir, 'result.json')], (l) => lines.push(l));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).attempts, 2);
  assert.throws(() => main(['prepare', state], () => {}), /comando desconocido/);
  assert.ok(!lines.join('\n').includes('secreta'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory avisa de los archivos y los mensajes que se pierden (blueprint 0.2.0)', () => {
  const state = stateFixture();
  const r = (address, type, values) => ({ address, mode: 'managed', type, name: address.split('.').pop(), values });
  state.values.root_module.child_modules.push(
    { address: 'module.blob_files', resources: [
      r('module.blob_files.azurerm_storage_account.this', 'azurerm_storage_account', { name: 'stshopdevfiles0a1b2c3d', primary_access_key: 'clave-de-la-cuenta' }),
      r('module.blob_files.azurerm_storage_container.this', 'azurerm_storage_container', { name: 'files' }),
    ] },
    { address: 'module.messaging', resources: [
      r('module.messaging.azurerm_servicebus_namespace.this', 'azurerm_servicebus_namespace', { name: 'sb-shop-dev-1a2b3c', default_primary_connection_string: 'Endpoint=sb://x;SharedAccessKey=secreta-del-bus' }),
      r('module.messaging.azurerm_servicebus_queue.this["orders"]', 'azurerm_servicebus_queue', { name: 'orders' }),
      r('module.messaging.azurerm_servicebus_topic.this["events"]', 'azurerm_servicebus_topic', { name: 'events' }),
    ] },
  );
  const { inventory: i } = inventory(state, planFixture());
  assert.deepEqual(i.azure.blobContainers, ['files']);
  assert.deepEqual(i.azure.storageAccounts, ['stshopdevfiles0a1b2c3d']);
  assert.deepEqual(i.azure.serviceBus, ['sb-shop-dev-1a2b3c']);
  assert.ok(i.warnings.some((w) => w.includes('contenedor files')));
  assert.ok(i.warnings.some((w) => w.includes('sb-shop-dev-1a2b3c') && w.includes('1 colas, 1 temas')));
  const text = JSON.stringify(i);
  assert.ok(!text.includes('clave-de-la-cuenta') && !text.includes('secreta-del-bus'));
});

