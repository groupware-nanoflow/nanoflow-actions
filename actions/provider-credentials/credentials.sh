#!/usr/bin/env bash
# Ver action.yml. Nunca imprime un secreto: solo nombres y si están.
set -euo pipefail

env_upper=$(printf '%s' "$NF_ENV" | tr '[:lower:]-' '[:upper:]_')
args=""

# auth0: dominio de la variable de repo y client M2M de los secretos del
# environment (doc 11 §18).
auth0() {
  local key domain
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
    return 0
  fi

  if [ "$NF_MODE" != "plan" ]; then
    echo "::error::Faltan los secretos AUTH0_CLIENT_ID y AUTH0_CLIENT_SECRET del environment ${NF_ENV}: cárgalos en NanoFlow → Infraestructura → ${NF_ENV} → Identidad."
    exit 1
  fi
  # El provider no llama a Auth0 hasta que lo necesita: con -refresh=false el
  # plan compara la configuración con el estado sin pedir un token.
  {
    echo "AUTH0_CLIENT_ID=nanoflow-pr-plan"
    echo "AUTH0_CLIENT_SECRET=nanoflow-pr-plan"
  } >> "$GITHUB_ENV"
  args="-refresh=false"
  echo "::notice::Plan sin refresh: un PR no ve las credenciales de Auth0 de ${NF_ENV}. El apply vuelve a planear con refresh y el drift diario detecta cambios hechos fuera de Terraform."
}

# supabase: por cada base que el ambiente referencia como var.supabase["<base>"]
# (doc 11 §19), el proyecto de la variable de repo NF_SUPABASE_<AMBIENTE>_<BASE>
# y la contraseña del secreto SUPABASE_DB_PASSWORD_<BASE> del environment.
supabase() {
  local names name suffix key conn projects='{}' passwords='{}' pw missing="" delim
  names=$( { grep -ho 'var\.supabase\["[a-z][a-z0-9-]*"\]' "$NF_DIR"/*.tf || true; } | sed 's/.*\["\(.*\)"\]/\1/' | LC_ALL=C sort -u)
  for name in $names; do
    suffix=$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')
    key="NF_SUPABASE_${env_upper}_${suffix}"
    conn=$(jq -c --arg k "$key" '.[$k] // "" | if type == "string" then (try fromjson catch null) else null end' <<< "${VARS_JSON:-"{}"}")
    if [ "$conn" = "null" ]; then
      echo "::error::Falta la conexión a Supabase de la base ${name} en ${NF_ENV} (variable ${key}): cárgala en NanoFlow → Infraestructura → ${NF_ENV} → Datos."
      exit 1
    fi
    if ! jq -e '(.host | type == "string" and test("^[a-z0-9.-]+\\.pooler\\.supabase\\.com$")) and
                (.projectRef | type == "string" and test("^[a-z]{20}$")) and
                (.database | type == "string" and test("^[A-Za-z0-9_-]{1,63}$")) and
                (.passwordVersion | type == "number" and . >= 0 and . == floor)' <<< "$conn" >/dev/null; then
      echo "::error::${key} no tiene la forma {host, projectRef, database, passwordVersion}: vuelve a cargar la conexión en NanoFlow."
      exit 1
    fi
    projects=$(jq -c --arg n "$name" --argjson c "$conn" '. + {($n): {host: $c.host, projectRef: $c.projectRef, database: $c.database, passwordVersion: $c.passwordVersion}}' <<< "$projects")

    pw=$(jq -r --arg k "SUPABASE_DB_PASSWORD_${suffix}" '.[$k] // "" | if type == "string" then . else "" end' <<< "${SECRETS_JSON:-"{}"}")
    if [ -z "$pw" ]; then
      missing="${missing} SUPABASE_DB_PASSWORD_${suffix}"
      continue
    fi
    if [ "${#pw}" -gt 256 ] || [[ "$pw" == *[[:cntrl:]]* ]]; then
      echo "::error::SUPABASE_DB_PASSWORD_${suffix} de ${NF_ENV} no es válida: vuelve a cargarla en NanoFlow."
      exit 1
    fi
    echo "::add-mask::${pw}"
    passwords=$(jq -c --arg n "$name" --arg p "$pw" '. + {($n): $p}' <<< "$passwords")
    echo "Supabase ${name}: proyecto $(jq -r '.projectRef' <<< "$conn") del environment ${NF_ENV}."
  done
  [ -n "$names" ] || return 0

  echo "TF_VAR_supabase=${projects}" >> "$GITHUB_ENV"
  if [ -n "$missing" ]; then
    if [ "$NF_MODE" != "plan" ]; then
      echo "::error::Faltan los secretos${missing} del environment ${NF_ENV}: carga la contraseña en NanoFlow → Infraestructura → ${NF_ENV} → Datos."
      exit 1
    fi
    # La contraseña solo va a un atributo de solo escritura: el plan no la necesita.
    echo "::notice::Un PR no ve las contraseñas de Supabase de ${NF_ENV}: el plan no las escribe y el apply las toma del environment."
    return 0
  fi
  # Variable efímera de Terraform. Delimitador aleatorio: el JSON va en una
  # línea, pero así una contraseña nunca puede cerrar el bloque.
  delim="NF_EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  { echo "TF_VAR_supabase_passwords<<${delim}"; echo "$passwords"; echo "$delim"; } >> "$GITHUB_ENV"
}

if grep -qs '"auth0/auth0"' "$NF_DIR"/*.tf; then
  auth0
fi
if grep -qs 'var\.supabase\[' "$NF_DIR"/*.tf; then
  supabase
fi
echo "plan-args=${args}" >> "$GITHUB_OUTPUT"
