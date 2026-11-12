#!/usr/bin/env bash
# Resuelve el ambiente de una rama en el .nanoflow/infra.json de un repo de
# infra de Azure y valida cada valor antes de dejarlo salir: van a
# GITHUB_OUTPUT y de ahí a rutas y a las variables con las que Terraform entra
# a Azure. Lo usa action.yml; se prueba con resolve.test.sh.
#
#   NF_BRANCH   rama a resolver
#   NF_CONFIG   ruta del archivo (por defecto .nanoflow/infra.json)
set -euo pipefail

config="${NF_CONFIG:-.nanoflow/infra.json}"
branch="${NF_BRANCH:?falta NF_BRANCH}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

if [ ! -f "$config" ]; then
  echo "::error::No existe $config. NanoFlow lo genera con el repo de infra; si lo borraste, vuelve a construir la infraestructura desde la consola."
  exit 1
fi
if ! jq -e . "$config" >/dev/null 2>&1; then
  echo "::error::$config no es JSON válido."
  exit 1
fi
# Un repo de AWS llama a terraform-plan.yml, no a este workflow.
provider=$(jq -r '.provider // "aws"' "$config")
if [ "$provider" != "azure" ]; then
  echo "::error::$config es de un repo de ${provider}, no de Azure: este workflow solo sirve a repos de infra de Azure."
  exit 1
fi

env=$(jq -r --arg b "$branch" '.environments // {} | to_entries[] | select(.value.branch == $b) | .key' "$config" | head -n 1)
if [ -z "$env" ]; then
  echo "found=false" >> "$out"
  echo "::notice::La rama ${branch} no es la de ningún ambiente: no hay nada que planear ni aplicar."
  exit 0
fi

get() { jq -r --arg e "$env" "$1 // \"\"" "$config"; }
dir=$(get '.environments[$e].dir')
subscription=$(get '.environments[$e].subscriptionId')
tenant=$(get '.environments[$e].tenantId')
group=$(get '.environments[$e].resourceGroup')
plan=$(get '.environments[$e].planClientId')
apply=$(get '.environments[$e].applyClientId')
region=$(get '.region')
tf=$(get '.terraformVersion')

guid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
fail() { echo "::error::$1"; exit 1; }
[[ "$env" =~ ^(development|staging|production)$ ]] || fail "ambiente inválido: $env"
[[ "$dir" =~ ^envs/[a-z]+$ ]] || fail "directorio inválido: $dir"
[[ "$subscription" =~ $guid ]] || fail "suscripción inválida"
[[ "$tenant" =~ $guid ]] || fail "directorio de Entra ID inválido"
[[ "$plan" =~ $guid ]] || fail "identidad de plan inválida"
[[ "$apply" =~ $guid ]] || fail "identidad de apply inválida"
[ "$plan" != "$apply" ] || fail "las identidades de plan y de apply no pueden ser la misma"
[[ "$group" =~ ^[-A-Za-z0-9._()]{1,90}$ ]] || fail "grupo de recursos inválido: $group"
[[ "$region" =~ ^[a-z][a-z0-9]{2,29}$ ]] || fail "región inválida: $region"
[[ "$tf" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "versión de Terraform inválida: $tf"

{
  echo "found=true"
  echo "environment=$env"
  echo "dir=$dir"
  echo "subscription-id=$subscription"
  echo "tenant-id=$tenant"
  echo "resource-group=$group"
  echo "region=$region"
  echo "plan-client-id=$plan"
  echo "apply-client-id=$apply"
  echo "terraform-version=$tf"
} >> "$out"
echo "Rama ${branch} → ${env} (${dir}, suscripción ${subscription}, ${group}, ${region})"
