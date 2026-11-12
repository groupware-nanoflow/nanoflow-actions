#!/usr/bin/env bash
# Pruebas de resolve.sh:  bash actions/azure-infra-env/resolve.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

good='{
  "schema": 1, "provider": "azure", "region": "eastus2", "terraformVersion": "1.16.4",
  "environments": {
    "development": {"branch": "develop", "dir": "envs/development",
      "subscriptionId": "11111111-0000-4000-8000-111111111111", "tenantId": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "resourceGroup": "rg-shop-dev-0000", "planClientId": "11111111-0001-4000-8000-111111111111", "applyClientId": "11111111-0003-4000-8000-111111111111"},
    "production": {"branch": "main", "dir": "envs/production",
      "subscriptionId": "33333333-0000-4000-8000-333333333333", "tenantId": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "resourceGroup": "rg-shop-prod-0000", "planClientId": "33333333-0001-4000-8000-333333333333", "applyClientId": "33333333-0003-4000-8000-333333333333"}
  }
}'

# run <name> <branch> <json> → deja la salida en $tmp/out y el log en $tmp/log; devuelve el código.
run() {
  printf '%s' "$3" > "$tmp/infra.json"
  : > "$tmp/out"
  NF_BRANCH="$2" NF_CONFIG="$tmp/infra.json" GITHUB_OUTPUT="$tmp/out" "$here/resolve.sh" > "$tmp/log" 2>&1
}
check() { # check <name> <condición ya evaluada: 0 = bien>
  if [ "$2" -eq 0 ]; then echo "ok   - $1"; else echo "FAIL - $1"; sed 's/^/       /' "$tmp/log" "$tmp/out"; fails=$((fails + 1)); fi
}
has() { grep -qx "$1" "$tmp/out"; }
mutate() { printf '%s' "$good" | jq "$1"; }

run "development" develop "$good"; rc=$?
{ [ $rc -eq 0 ] && has "found=true" && has "environment=development" && has "dir=envs/development" &&
  has "subscription-id=11111111-0000-4000-8000-111111111111" && has "tenant-id=aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa" &&
  has "resource-group=rg-shop-dev-0000" && has "region=eastus2" && has "plan-client-id=11111111-0001-4000-8000-111111111111" &&
  has "apply-client-id=11111111-0003-4000-8000-111111111111" && has "terraform-version=1.16.4"; }
check "la rama de un ambiente resuelve todos sus valores" $?

run "production" main "$good"; rc=$?
{ [ $rc -eq 0 ] && has "environment=production" && has "apply-client-id=33333333-0003-4000-8000-333333333333"; }
check "cada rama resuelve su propio ambiente" $?

run "sin ambiente" feature/x "$good"; rc=$?
{ [ $rc -eq 0 ] && has "found=false" && [ "$(wc -l < "$tmp/out")" -eq 1 ]; }
check "una rama sin ambiente deja found=false y no falla" $?

# Lo que nunca debe salir de aquí: cada caso falla y no escribe ninguna salida.
refuse() { # refuse <name> <json>
  run "$1" develop "$2"; rc=$?
  { [ $rc -ne 0 ] && [ ! -s "$tmp/out" ] && grep -q '::error::' "$tmp/log"; }
  check "se rechaza: $1" $?
}
refuse "un infra.json de AWS" "$(mutate 'del(.provider)')"
refuse "otro proveedor" "$(mutate '.provider = "gcp"')"
refuse "JSON roto" '{"provider": "azure",'
refuse "una suscripción que no es un id" "$(mutate '.environments.development.subscriptionId = "prod"')"
refuse "un directorio de Entra con salto de línea" "$(mutate '.environments.development.tenantId = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa\nARM_CLIENT_ID=x"')"
refuse "sin identidad de apply" "$(mutate 'del(.environments.development.applyClientId)')"
refuse "la misma identidad para plan y apply" "$(mutate '.environments.development.applyClientId = .environments.development.planClientId')"
refuse "un directorio de Terraform fuera de envs/" "$(mutate '.environments.development.dir = "../../etc"')"
refuse "un grupo de recursos con caracteres de shell" "$(mutate '.environments.development.resourceGroup = "rg; rm -rf /"')"
refuse "una región de AWS" "$(mutate '.region = "us-east-1"')"
refuse "una versión de Terraform que no lo es" "$(mutate '.terraformVersion = "latest"')"
refuse "un ambiente con nombre desconocido" "$(mutate '.environments.qa = .environments.development | del(.environments.development)')"

printf '%s' "$good" > "$tmp/infra.json"
NF_BRANCH=develop NF_CONFIG="$tmp/missing.json" GITHUB_OUTPUT="$tmp/out" "$here/resolve.sh" > "$tmp/log" 2>&1; rc=$?
{ [ $rc -ne 0 ] && grep -q 'No existe' "$tmp/log"; }
check "se rechaza: el archivo no existe" $?

echo
if [ "$fails" -eq 0 ]; then echo "todo bien"; else echo "$fails fallos"; exit 1; fi
