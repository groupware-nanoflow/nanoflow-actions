#!/usr/bin/env node
'use strict';

// Lo que terraform-azure-destroy.yml necesita saber de un ambiente de Azure
// antes y después de destruirlo (doc 40 de la consola, §21; el contrato con
// NanoFlow es el del doc 29, el mismo de AWS):
//
//   inventory <state.json> <plan.json> --out f   resumen del plan -destroy e
//                                                inventario de lo que se pierde
//   result <pre-state.json> --remaining f --attempts n --out f
//                                                qué se destruyó y qué quedó
//
// Todo sale de los JSON de Terraform: aquí no se llama a Azure. El estado trae
// valores sensibles (los secretos del Key Vault); de él solo se leen nombres y
// ajustes, y nada de `value` llega a la salida.
//
// A diferencia de AWS no hay «prepare» ni «cleanup»: el blueprint de Azure no
// crea nada con protección contra borrado ni deja recursos fuera del estado.
// Lo propio de Azure es el borrado suave, que se avisa (warnings).

const fs = require('node:fs');
const { summarize, parseArgs } = require('../report-plan/summarize.js');

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
const num = (v) => (Number.isFinite(v) ? v : null);

/** Lo que importa de cada recurso para destruir, sin valores sensibles. */
function facts(state) {
  const all = resources(state);
  const of = (type) => all.filter((r) => r.type === type).map((r) => r.values || {});
  const names = (type) => of(type).map((v) => str(v.name)).filter(Boolean).sort();
  return {
    total: all.length,
    keyVaults: of('azurerm_key_vault').map((v) => ({
      name: str(v.name),
      softDeleteDays: num(v.soft_delete_retention_days),
      purgeProtection: v.purge_protection_enabled === true,
    })).filter((v) => v.name),
    secrets: of('azurerm_key_vault_secret').length,
    registries: names('azurerm_container_registry'),
    workspaces: of('azurerm_log_analytics_workspace').map((v) => ({ name: str(v.name), retentionDays: num(v.retention_in_days) })).filter((v) => v.name),
    containerApps: names('azurerm_container_app'),
    apiManagement: names('azurerm_api_management'),
    staticSites: names('azurerm_static_web_app'),
    // Lo que guarda datos del producto: archivos y mensajes en cola.
    storageAccounts: names('azurerm_storage_account'),
    blobContainers: names('azurerm_storage_container'),
    serviceBus: names('azurerm_servicebus_namespace'),
    queues: names('azurerm_servicebus_queue'),
    topics: names('azurerm_servicebus_topic'),
  };
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

/** Lo que Azure conserva un tiempo después de borrar (borrado suave). */
function softDeleteWarnings(f) {
  const out = [];
  for (const v of f.keyVaults) {
    const days = v.softDeleteDays ? `${v.softDeleteDays} días` : 'un tiempo';
    out.push(v.purgeProtection
      ? `El Key Vault ${v.name} tiene protección de purga: Azure lo conserva en borrado suave ${days} después de destruirlo y no deja purgarlo antes. Su nombre queda ocupado hasta entonces.`
      : `Azure puede conservar el Key Vault ${v.name} en borrado suave hasta ${days} después de destruirlo.`);
  }
  for (const name of f.apiManagement) {
    out.push(`Azure puede conservar API Management ${name} en borrado suave hasta 48 horas después de destruirlo.`);
  }
  return out;
}

function inventory(state, plan) {
  const f = facts(state);
  const warnings = [];
  for (const name of f.registries) warnings.push(`Las imágenes del registro de contenedores ${name} se borran con él.`);
  for (const w of f.workspaces) warnings.push(`Los logs del workspace ${w.name} se borran con él.`);
  if (f.secrets > 0) warnings.push(`Los ${f.secrets} secretos del Key Vault se borran con él.`);
  for (const name of f.blobContainers) warnings.push(`Los archivos del contenedor ${name} se borran con su cuenta de almacenamiento.`);
  for (const name of f.serviceBus) {
    warnings.push(`Los mensajes sin procesar de Service Bus ${name} (${f.queues.length} colas, ${f.topics.length} temas) se pierden.`);
  }
  warnings.push(...softDeleteWarnings(f));
  return {
    summary: summarize(plan),
    inventory: {
      resources: f.total,
      noState: f.total === 0,
      // Lo que el blueprint de Azure no crea todavía: listas vacías, para que
      // quien lea el inventario no tenga que distinguir nubes.
      databases: [], buckets: [], tables: [], userPools: [], zones: [], logGroups: [],
      secrets: f.secrets,
      azure: {
        keyVaults: f.keyVaults,
        registries: f.registries,
        workspaces: f.workspaces,
        containerApps: f.containerApps,
        apiManagement: f.apiManagement,
        staticSites: f.staticSites,
        storageAccounts: f.storageAccounts,
        blobContainers: f.blobContainers,
        serviceBus: f.serviceBus,
        queues: f.queues,
        topics: f.topics,
      },
      survives: supabaseBases(plan),
      warnings,
    },
  };
}

function result(preState, remaining, attempts) {
  const f = facts(preState);
  const left = [...remaining];
  // Solo de lo que ya salió del estado.
  const gone = (type) => !left.some((address) => address.split('.').includes(type));
  const warnings = softDeleteWarnings({
    keyVaults: gone('azurerm_key_vault') ? f.keyVaults : [],
    apiManagement: gone('azurerm_api_management') ? f.apiManagement : [],
  });
  return {
    remaining: remaining.size,
    destroyed: Math.max(0, f.total - remaining.size),
    attempts,
    snapshots: [],
    retained: [],
    cleaned: { objects: 0, records: 0, secrets: 0, logGroups: 0, snapshots: 0 },
    warnings,
  };
}

function readJSON(path) {
  if (!path || !fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readText(path) {
  return path && fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
}

function main(argv, log = (line) => process.stdout.write(`${line}\n`)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const write = (obj) => {
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(obj) + '\n');
    return obj;
  };
  switch (command) {
    case 'inventory': {
      const r = write(inventory(readJSON(args._[0]), readJSON(args._[1])));
      const a = r.inventory.azure;
      log(`Inventario: ${r.inventory.resources} recursos · ${r.summary.delete} a destruir · ${a.containerApps.length} aplicaciones · ${a.keyVaults.length} Key Vault · ${r.inventory.secrets} secretos.`);
      for (const w of r.inventory.warnings) log(`::notice::${w}`);
      return r;
    }
    case 'result': {
      const r = write(result(readJSON(args._[0]), parseStateList(readText(args.remaining)), Number(args.attempts) || 0));
      log(`Quedan ${r.remaining} recursos en el estado; destruidos ${r.destroyed}.`);
      for (const w of r.warnings) log(`::notice::${w}`);
      return r;
    }
    default:
      throw new Error(`comando desconocido: ${command || '(vacío)'} (inventory | result)`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`::error::${String((e && e.message) || e).slice(0, 300)}\n`);
    process.exit(1);
  }
}

module.exports = { resources, facts, supabaseBases, parseStateList, softDeleteWarnings, inventory, result, main };
