// node --test actions/reconcile-moves/reconcile.azure.test.js
//
// Los tipos de Microsoft Azure (consola, doc 40 §22). Las pruebas de AWS están
// en reconcile.test.js y no cambian.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcile, identityOf, markdown, cloudOf, IDENTITY } = require('./reconcile.js');

const del = (address, type, before) => ({ address, type, mode: 'managed', change: { actions: ['delete'], before, after: null } });
const add = (address, type, after, unknown = {}) => ({
  address, type, mode: 'managed', change: { actions: ['create'], before: null, after, after_unknown: unknown },
});

const RG = 'rg-shop-dev-1a2b';
const SUB = '/subscriptions/0b1f6471-1bf0-4dda-aec3-cb9272f09590';
const VAULT = `${SUB}/resourceGroups/${RG}/providers/Microsoft.KeyVault/vaults/kvshopdev1a2b3c`;
const ACR = `${SUB}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/crshopdev1a2b3c`;
const APPLY = '66666666-7777-8888-9999-000000000000';
const APIM = 'apim-shop-dev-1a2b3c';

// Un servicio escrito a mano (module.orders) que NanoFlow reemplaza por el
// generado (module.svc_orders), con los mismos nombres físicos.
const handWritten = {
  resource_changes: [
    del('module.orders.azurerm_user_assigned_identity.this', 'azurerm_user_assigned_identity', { resource_group_name: RG, name: 'id-shop-dev-orders', principal_id: 'p-old' }),
    del('module.orders.azurerm_container_app.this', 'azurerm_container_app', { resource_group_name: RG, name: 'ca-shop-dev-orders' }),
    del('module.orders.azurerm_role_assignment.pull', 'azurerm_role_assignment', { scope: ACR, role_definition_name: 'AcrPull', principal_id: 'p-old', name: 'a1b2' }),
    del('module.orders.azurerm_key_vault_secret.db', 'azurerm_key_vault_secret', { key_vault_id: VAULT, name: 'db-app-app', value: 'secreta' }),
    del('module.orders.azurerm_api_management_api.this', 'azurerm_api_management_api', { resource_group_name: RG, api_management_name: APIM, name: 'orders', revision: '1' }),
    del('module.orders.azurerm_api_management_api_operation.any', 'azurerm_api_management_api_operation', { resource_group_name: RG, api_management_name: APIM, api_name: 'orders', operation_id: 'any' }),
    del('module.orders.azurerm_api_management_api_policy.this', 'azurerm_api_management_api_policy', { resource_group_name: RG, api_management_name: APIM, api_name: 'orders' }),
    add('module.svc_orders.azurerm_user_assigned_identity.this', 'azurerm_user_assigned_identity', { resource_group_name: RG, name: 'id-shop-dev-orders' }, { principal_id: true, client_id: true }),
    add('module.svc_orders.azurerm_container_app.this', 'azurerm_container_app', { resource_group_name: RG, name: 'ca-shop-dev-orders' }),
    // El principal de la identidad nueva solo se conoce tras el apply.
    add('module.svc_orders.azurerm_role_assignment.pull', 'azurerm_role_assignment', { scope: ACR, role_definition_name: 'AcrPull' }, { principal_id: true, name: true }),
    add('module.db_app.azurerm_key_vault_secret.app', 'azurerm_key_vault_secret', { key_vault_id: VAULT, name: 'db-app-app' }),
    add('module.api.azurerm_api_management_api.service["orders"]', 'azurerm_api_management_api', { resource_group_name: RG, api_management_name: APIM, name: 'orders', revision: '1' }),
    add('module.api.azurerm_api_management_api_operation.service["orders"]', 'azurerm_api_management_api_operation', { resource_group_name: RG, api_management_name: APIM, api_name: 'orders', operation_id: 'any' }),
    add('module.api.azurerm_api_management_api_policy.service["orders"]', 'azurerm_api_management_api_policy', { resource_group_name: RG, api_management_name: APIM, api_name: 'orders' }),
  ],
};

test('Azure: mueve lo que conserva su nombre dentro del mismo padre', () => {
  const { moves, collisions } = reconcile(handWritten);
  assert.deepEqual(collisions, []);
  assert.deepEqual(moves.map((m) => `${m.from} -> ${m.to}`), [
    'module.orders.azurerm_api_management_api.this -> module.api.azurerm_api_management_api.service["orders"]',
    'module.orders.azurerm_api_management_api_operation.any -> module.api.azurerm_api_management_api_operation.service["orders"]',
    'module.orders.azurerm_api_management_api_policy.this -> module.api.azurerm_api_management_api_policy.service["orders"]',
    'module.orders.azurerm_key_vault_secret.db -> module.db_app.azurerm_key_vault_secret.app',
    'module.orders.azurerm_container_app.this -> module.svc_orders.azurerm_container_app.this',
    'module.orders.azurerm_user_assigned_identity.this -> module.svc_orders.azurerm_user_assigned_identity.this',
  ]);
  // Ningún valor del plan (un secreto) sale en la identidad.
  assert.ok(!JSON.stringify(moves).includes('secreta'));
});

test('Azure: una asignación de rol es su ámbito, su rol y su principal', () => {
  const same = { scope: VAULT, role_definition_name: 'Key Vault Secrets User', principal_id: APPLY };
  assert.deepEqual(identityOf(del('a', 'azurerm_role_assignment', { ...same, name: 'guid-1' })),
    [['scope', VAULT], ['role_definition_name', 'Key Vault Secrets User'], ['principal_id', APPLY]]);
  // El nombre (un GUID que genera Azure) no cuenta, y sin principal conocido no hay par.
  assert.equal(identityOf(add('a', 'azurerm_role_assignment', { scope: VAULT, role_definition_name: 'Key Vault Secrets User' }, { principal_id: true })), null);
  assert.equal(identityOf(del('a', 'azurerm_role_assignment', { scope: VAULT, role_definition_id: '/x', principal_id: APPLY, name: 'guid-1' })), null, 'asignada por id de rol');
  const { moves } = reconcile({
    resource_changes: [
      del('module.old.azurerm_role_assignment.apply_secrets', 'azurerm_role_assignment', { ...same, name: 'guid-1' }),
      add('module.foundation.azurerm_role_assignment.apply_secrets', 'azurerm_role_assignment', same, { name: true, id: true }),
      // Otro rol sobre el mismo ámbito y principal es otra asignación.
      del('module.old.azurerm_role_assignment.admin', 'azurerm_role_assignment', { ...same, role_definition_name: 'Key Vault Administrator', name: 'guid-2' }),
    ],
  });
  assert.deepEqual(moves.map((m) => m.to), ['module.foundation.azurerm_role_assignment.apply_secrets']);
});

test('Azure: el padre separa nombres que no son globales', () => {
  const other = VAULT.replace('kvshopdev1a2b3c', 'kvotro');
  const { moves, collisions } = reconcile({
    resource_changes: [
      del('azurerm_key_vault_secret.old', 'azurerm_key_vault_secret', { key_vault_id: other, name: 'db-app-app' }),
      add('azurerm_key_vault_secret.new', 'azurerm_key_vault_secret', { key_vault_id: VAULT, name: 'db-app-app' }),
      del('azurerm_api_management_api.old', 'azurerm_api_management_api', { resource_group_name: RG, api_management_name: 'apim-otro', name: 'orders', revision: '1' }),
      add('azurerm_api_management_api.new', 'azurerm_api_management_api', { resource_group_name: RG, api_management_name: APIM, name: 'orders', revision: '1' }),
      del('azurerm_container_app.old', 'azurerm_container_app', { resource_group_name: 'rg-otro', name: 'ca-shop-dev-orders' }),
      add('azurerm_container_app.new', 'azurerm_container_app', { resource_group_name: RG, name: 'ca-shop-dev-orders' }),
      del('azurerm_servicebus_queue.old', 'azurerm_servicebus_queue', { namespace_id: 'ns-a', name: 'orders' }),
      add('azurerm_servicebus_queue.new', 'azurerm_servicebus_queue', { namespace_id: 'ns-a', name: 'orders' }),
    ],
  });
  assert.deepEqual(collisions, []);
  assert.deepEqual(moves.map((m) => m.to), ['azurerm_servicebus_queue.new']);
});

test('Azure: los nombres globales se emparejan por nombre, como cualquier tipo', () => {
  for (const type of ['azurerm_key_vault', 'azurerm_container_registry', 'azurerm_api_management', 'azurerm_static_web_app', 'azurerm_storage_account']) {
    assert.equal(IDENTITY[type], undefined, type);
    assert.deepEqual(identityOf(del('a', type, { resource_group_name: RG, name: 'x1' })), [['name', 'x1']], type);
  }
});

test('el comentario nombra la nube de lo que se movió', () => {
  const azure = reconcile(handWritten);
  assert.equal(cloudOf(azure.moves), 'Azure');
  assert.match(markdown(azure), /en paralelo, Azure rechaza la creación/);
  const aws = reconcile({
    resource_changes: [
      del('module.a.aws_iam_role.this', 'aws_iam_role', { name: 'r' }),
      add('module.b.aws_iam_role.this', 'aws_iam_role', { name: 'r' }),
    ],
  });
  assert.equal(cloudOf(aws.moves), 'AWS');
  assert.match(markdown(aws), /en paralelo, AWS rechaza la creación/);
  assert.equal(cloudOf([]), 'AWS');
  assert.equal(cloudOf([{ type: 'azurerm_key_vault' }, { type: 'aws_s3_bucket' }]), 'AWS');
});

test('las identidades de AWS son las de siempre', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(IDENTITY).filter(([t]) => t.startsWith('aws_'))),
    {
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
    },
  );
  assert.ok(Object.keys(IDENTITY).every((t) => t.startsWith('aws_') || t.startsWith('azurerm_')));
});
