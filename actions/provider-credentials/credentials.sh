#!/usr/bin/env bash
# Ver action.yml. Nunca imprime un secreto: solo nombres y si están.
set -euo pipefail

plan_args() { echo "plan-args=$1" >> "$GITHUB_OUTPUT"; }
if ! grep -qs '"auth0/auth0"' "$NF_DIR"/*.tf; then
  plan_args ''
  exit 0
fi

env_upper=$(printf '%s' "$NF_ENV" | tr '[:lower:]-' '[:upper:]_')
key="NF_AUTH0_DOMAIN_${env_upper}"
domain=$(jq -r --arg k "$key" '.[$k] // "" | if type == "string" then . else "" end' <<< "${VARS_JSON:-"{}"}")
if [ -z "$domain" ]; then
  echo "::error::Faltan las credenciales de Auth0 de ${NF_ENV} (variable ${key}): cárgalas en NanoFlow → Infraestructura → ${NF_ENV} → Identidad."
  exit 1
fi
if ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "::error::${key} no es un dominio válido."
  exit 1
fi
{
  echo "AUTH0_DOMAIN=${domain}"
  echo "TF_VAR_auth0_domain=${domain}"
} >> "$GITHUB_ENV"

valid() { [ "${#1}" -le 512 ] && [[ "$1" =~ ^[A-Za-z0-9._~-]+$ ]]; }
if [ -n "${NF_AUTH0_ID:-}" ] && [ -n "${NF_AUTH0_SECRET:-}" ]; then
  if ! valid "$NF_AUTH0_ID" || ! valid "$NF_AUTH0_SECRET"; then
    echo "::error::AUTH0_CLIENT_ID o AUTH0_CLIENT_SECRET de ${NF_ENV} tienen caracteres no válidos: vuelve a cargarlos en NanoFlow."
    exit 1
  fi
  echo "::add-mask::${NF_AUTH0_SECRET}"
  {
    echo "AUTH0_CLIENT_ID=${NF_AUTH0_ID}"
    echo "AUTH0_CLIENT_SECRET=${NF_AUTH0_SECRET}"
  } >> "$GITHUB_ENV"
  echo "Auth0 ${domain}: credenciales del environment ${NF_ENV}."
  plan_args ''
  exit 0
fi

if [ "$NF_MODE" != "plan" ]; then
  echo "::error::Faltan los secretos AUTH0_CLIENT_ID y AUTH0_CLIENT_SECRET del environment ${NF_ENV}: cárgalos en NanoFlow → Infraestructura → ${NF_ENV} → Identidad."
  exit 1
fi
# El provider no llama a Auth0 hasta que lo necesita: con -refresh=false el plan
# compara la configuración con el estado sin pedir un token.
{
  echo "AUTH0_CLIENT_ID=nanoflow-pr-plan"
  echo "AUTH0_CLIENT_SECRET=nanoflow-pr-plan"
} >> "$GITHUB_ENV"
plan_args '-refresh=false'
echo "::notice::Plan sin refresh: un PR no ve las credenciales de Auth0 de ${NF_ENV}. El apply vuelve a planear con refresh y el drift diario detecta cambios hechos fuera de Terraform."
