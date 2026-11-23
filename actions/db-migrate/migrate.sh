#!/usr/bin/env bash
# migrate.sh — migra las bases Postgres que declara el manifiesto, antes del
# deploy (doc 11 §14 de la consola, E5-D1 a E5-D7).
#
# Por cada `databases[]` de .nanoflow/deploy.yml:
#   1. Encuentra su migrador en NF_DB_<NOMBRE>_MIGRATOR (contrato de
#      plataforma; solo existe en el repo dueño de la base).
#   2. RDS/Aurora: es una Lambda en la VPC; le instala el código de
#      nanoflow-db-migrator de la versión fijada, si no es ya ese (zip del
#      bucket público de NanoFlow, verificado por sha256).
#      Supabase (doc 11 §19 E9-D6): es el ARN del secreto admin; la CLI del
#      migrador (misma versión, verificada por sha256) corre en el runner con
#      DATABASE_URL y APP_DB_PASSWORD leídos de los secretos admin y app.
#      Supabase en Microsoft Azure (doc 40 §25): es el id del secreto admin en
#      el Key Vault del ambiente; la misma CLI en el runner, con los secretos
#      leídos con `az` y la identidad de despliegue del repositorio.
#      PostgreSQL flexible en Microsoft Azure (templates ≥ 0.27.0): es la URL
#      de la cola `migrate` del job migrador del ambiente
#      (https://<cuenta>.queue.core.windows.net/migrate). La base es privada:
#      el runner no la toca. Sube a `requests/<id>/` del contenedor
#      `migrations` (NF_DEPLOY_MIGRATIONS_<NOMBRE>_CONTAINER, o el de la misma
#      cuenta) el request.json, la CLI del migrador (verificada por sha256) y
#      los .sql en un tar.gz; pone <id> en la cola y espera
#      `results/<id>.json` (hasta QUEUE_WAIT_SECONDS, 30 min). Las respuestas
#      de cada paso del job pasan por el mismo flujo y el mismo reporte.
#   3. bootstrap → status (pendientes) → snapshot si en staging/production hay
#      una pendiente contract o destructive (no en Supabase: avisa) → apply →
#      status (estado completo).
#   4. Informa el resultado a NanoFlow (POST /v1/ci/migrations). El reporte
#      nunca hace fallar el paso; una migración fallida sí.
#
# Con MODE=drift (workflow db-drift.yml, doc 11 §16 E6c-D4) no migra nada:
# por cada base invoca `status` con los archivos de la rama e informa el drift
# (in_sync | pending | mismatch) con el estado aplicado. Sale con 1 si alguna
# base está desalineada o no respondió.
#
# Entorno: MODE (apply por defecto | drift), MANIFEST, NF_ENVIRONMENT
# (development|staging|production, el que resolvió NanoFlow), NF_API_URL,
# NF_AUDIENCE, MIGRATOR_VERSION,
# MIGRATOR_BASE_URL (opcional), credenciales AWS de la cuenta del ambiente (o,
# en Azure, la sesión de `az` en la suscripción del ambiente),
# GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT.
# Salidas: status (skipped|succeeded|failed) y error ("<base>: <código>").
#
# Nunca imprime el SQL, secretos ni el token: solo nombres, versiones y códigos.
set -euo pipefail

: "${MANIFEST:?MANIFEST vacío}"
: "${NF_ENVIRONMENT:?NF_ENVIRONMENT vacío}"
MIGRATOR_VERSION="${MIGRATOR_VERSION:-1.1.0}"
MODE="${MODE:-apply}"
case "$MODE" in apply|drift) ;; *) echo "::error::MODE '${MODE}' no es apply ni drift."; exit 2 ;; esac
SNAPSHOT_WAIT_SECONDS="${SNAPSHOT_WAIT_SECONDS:-3600}"
# Límite del payload síncrono de Lambda (6 MB), con margen para el envoltorio.
MAX_PAYLOAD_BYTES=$((6 * 1000 * 1000 - 4096))

out() { echo "$1" >> "${GITHUB_OUTPUT:-/dev/null}"; }

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nf-db-migrate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

databases=$(yq -o=json '.databases // []' "$MANIFEST")
if ! jq -e 'type == "array"' >/dev/null <<< "$databases"; then
  echo "::error::${MANIFEST}: 'databases' debe ser una lista de {name, migrations}."
  out "status=failed"; out "error=manifest: databases"
  exit 1
fi
count=$(jq 'length' <<< "$databases")
if [ "$count" -eq 0 ]; then
  echo "El manifiesto no declara bases: sin migraciones."
  out "status=skipped"
  exit 0
fi

# ---------------------------------------------------------------- el migrador
base_url="${MIGRATOR_BASE_URL:-https://${NF_AUDIENCE:?NF_AUDIENCE vacío}-public.s3.amazonaws.com/db-migrator}"
base_url="${base_url%/}/${MIGRATOR_VERSION}"

# fetch <archivo>: descarga un artefacto del migrador y lo verifica contra su
# .sha256. Deja el sha256 en $fetched_hex.
fetched_hex=""
fetch() {
  local f="$work/$1" got
  if ! curl -fsSL --max-time 120 --retry 3 -o "$f" "$base_url/$1" ||
     ! curl -fsSL --max-time 30 --retry 3 -o "$f.sha256" "$base_url/$1.sha256"; then
    echo "::error::No se pudo descargar nanoflow-db-migrator ${MIGRATOR_VERSION} ($1) de ${base_url}."
    out "status=failed"; out "error=migrator: download"
    exit 1
  fi
  fetched_hex=$(awk '{print $1; exit}' "$f.sha256")
  got=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | awk '{print $1}')
  if ! [[ "$fetched_hex" =~ ^[0-9a-f]{64}$ ]] || [ "$fetched_hex" != "$got" ]; then
    echo "::error::$1 de nanoflow-db-migrator ${MIGRATOR_VERSION} no coincide con su .sha256."
    out "status=failed"; out "error=migrator: checksum"
    exit 1
  fi
  echo "nanoflow-db-migrator ${MIGRATOR_VERSION}: $1 (sha256 ${fetched_hex:0:12}…)"
}

# El zip de la Lambda y la CLI se bajan solo si alguna base los necesita.
zip="$work/db-migrator-lambda-arm64.zip"
want_b64=""
ensure_zip() {
  [ -z "$want_b64" ] || return 0
  fetch db-migrator-lambda-arm64.zip
  # Lambda informa CodeSha256 como base64 del sha256 binario.
  want_b64=$(printf '%s' "$fetched_hex" | xxd -r -p | base64)
}
cli="$work/db-migrator-linux-amd64"
ensure_cli() {
  [ ! -x "$cli" ] || return 0
  fetch db-migrator-linux-amd64
  chmod +x "$cli"
}

# ---------------------------------------------------------------- utilidades
# invoke <función> <payload.json> <respuesta.json>: invocación síncrona. Si la
# función no corrió bien (FunctionError o sin JSON), escribe una respuesta
# INVOKE_FAILED con la forma del migrador.
invoke() {
  local fn="$1" payload="$2" resp="$3" meta="$work/meta.json"
  if ! aws lambda invoke --function-name "$fn" \
      --cli-binary-format raw-in-base64-out --cli-read-timeout 900 \
      --payload "fileb://$payload" "$resp" > "$meta" 2> "$work/invoke.err"; then
    jq -n --arg m "$(tail -c 400 "$work/invoke.err" | tr '\n' ' ')" \
      '{ok: false, applied: [], pending: [], error: {code: "INVOKE_FAILED", message: ("aws lambda invoke: " + $m)}}' > "$resp"
    return
  fi
  if jq -e '.FunctionError // empty' "$meta" >/dev/null 2>&1 || ! jq -e 'type == "object" and has("ok")' "$resp" >/dev/null 2>&1; then
    local msg
    msg=$(jq -r '.errorMessage // "respuesta inválida"' "$resp" 2>/dev/null | head -c 400 || echo "respuesta inválida")
    jq -n --arg m "$msg" '{ok: false, applied: [], pending: [], error: {code: "INVOKE_FAILED", message: ("la Lambda falló: " + $m)}}' > "$resp"
  fi
}

# migrator <acción> <con archivos: yes|no> <respuesta.json>: corre una acción
# del migrador de la base actual: invoca la Lambda ($fn) o, en Supabase, la CLI
# en el runner con DATABASE_URL/APP_DB_PASSWORD del entorno del subshell.
# Usa $files (lista [{name, sql}]) y $dir.
migrator() {
  local action="$1" with_files="$2" resp="$3" rc
  if [ "$runner" = queue ]; then
    queue_step "$action" "$with_files" "$resp"
    return
  fi
  if [ "$runner" = false ]; then
    if [ "$with_files" = yes ]; then
      jq -c --arg a "$action" --arg sha "${GITHUB_SHA:-}" '{action: $a, files: .} + (if $a == "apply" then {sha: $sha} else {} end)' "$files" > "$work/p.json"
    else
      jq -cn --arg a "$action" '{action: $a}' > "$work/p.json"
    fi
    invoke "$fn" "$work/p.json" "$resp"
    return
  fi
  local cmd=("$cli" "$action")
  if [ "$with_files" = yes ]; then cmd+=(--dir "$dir"); fi
  if [ "$action" = apply ]; then cmd+=(--sha "${GITHUB_SHA:-}"); fi
  set +e
  DATABASE_URL="$db_url" APP_DB_PASSWORD="$app_password" "${cmd[@]}" > "$resp" 2> "$work/cli.err"
  rc=$?
  set -e
  if ! jq -e 'type == "object" and has("ok")' "$resp" >/dev/null 2>&1; then
    jq -n --arg m "$(tail -c 400 "$work/cli.err" | tr '\n' ' ')" --arg rc "$rc" \
      '{ok: false, applied: [], pending: [], error: {code: "INVOKE_FAILED", message: ("la CLI del migrador falló (código " + $rc + "): " + $m)}}' > "$resp"
  fi
}

# supabase_env <arn del secreto admin>: lee los secretos admin y app de la
# cuenta del ambiente y deja $db_url y $app_password (enmascarados). Corre en
# este shell (las máscaras van a su stdout); si falla, el motivo queda en
# $work/sb.err.
supabase_env() {
  local arn="$1" region admin app app_arn user pw
  region=$(cut -d: -f4 <<< "$arn")
  if ! admin=$(aws secretsmanager get-secret-value --region "$region" --secret-id "$arn" --query SecretString --output text 2> "$work/sm.err"); then
    echo "no se pudo leer el secreto admin: $(tail -c 300 "$work/sm.err" | tr '\n' ' ')" > "$work/sb.err"; return 1
  fi
  if ! jq -e '.engine == "supabase" and (.username | type == "string") and (.password | type == "string" and length > 0) and (.host | type == "string") and (.appSecretArn | type == "string")' <<< "$admin" >/dev/null 2>&1; then
    echo "el secreto admin no tiene la forma de Supabase o le falta la contraseña (cárgala en NanoFlow → Infraestructura → ${NF_ENVIRONMENT} → Datos y aplica core-infra)" > "$work/sb.err"; return 1
  fi
  pw=$(jq -r '.password' <<< "$admin")
  echo "::add-mask::${pw}"
  db_url=$(jq -r '"postgresql://\(.username | @uri):\(.password | @uri)@\(.host):\(.port // 5432)/\(.dbname // "postgres" | @uri)?sslmode=\(if (.sslmode // "") | IN("disable", "verify-ca", "verify-full") then .sslmode else "require" end)"' <<< "$admin")
  echo "::add-mask::${db_url}"
  app_arn=$(jq -r '.appSecretArn' <<< "$admin")
  if ! app=$(aws secretsmanager get-secret-value --region "$(cut -d: -f4 <<< "$app_arn")" --secret-id "$app_arn" --query SecretString --output text 2> "$work/sm.err"); then
    echo "no se pudo leer el secreto app: $(tail -c 300 "$work/sm.err" | tr '\n' ' ')" > "$work/sb.err"; return 1
  fi
  app_password=$(jq -r '.password // ""' <<< "$app" 2>/dev/null || true)
  if [ -z "$app_password" ]; then
    echo "el secreto app no tiene contraseña" > "$work/sb.err"; return 1
  fi
  echo "::add-mask::${app_password}"
  user=$(jq -r '.username' <<< "$admin")
  echo "Supabase: ${user} en $(jq -r '.host' <<< "$admin") por el session pooler."
}

# Id sin versión de un secreto de Key Vault: lo que trae
# NF_DB_<NOMBRE>_MIGRATOR en un proyecto de Microsoft Azure.
keyvault_secret_re='^https://([a-z0-9][a-z0-9-]{1,22}[a-z0-9])\.vault\.azure\.net/secrets/[A-Za-z0-9-]{1,127}$'

# supabase_env_azure <id del secreto admin>: como supabase_env, con los
# secretos en el Key Vault del ambiente (doc 40 §25). Los lee la CLI de Azure
# con la sesión del job: la identidad de despliegue del repositorio dueño de la
# base tiene lectura de esos dos secretos y de ningún otro. El secreto app debe
# estar en el mismo Key Vault que el admin.
supabase_env_azure() {
  local ref="$1" vault admin app app_ref user pw
  [[ "$ref" =~ $keyvault_secret_re ]]; vault="${BASH_REMATCH[1]}"
  if ! command -v az >/dev/null 2>&1; then
    echo "el runner no tiene la CLI de Azure (az)" > "$work/sb.err"; return 1
  fi
  if ! admin=$(az keyvault secret show --id "$ref" --query value --output tsv 2> "$work/sm.err"); then
    echo "no se pudo leer el secreto admin del Key Vault (la identidad de despliegue de este repositorio debe poder leerlo: construye y aplica la infraestructura con templates ≥ 0.25.0): $(tail -c 300 "$work/sm.err" | tr '\n' ' ')" > "$work/sb.err"; return 1
  fi
  if ! jq -e '.engine == "supabase" and (.username | type == "string") and (.password | type == "string" and length > 0) and (.host | type == "string") and (.appSecretRef | type == "string")' <<< "$admin" >/dev/null 2>&1; then
    echo "el secreto admin no tiene la forma de Supabase o le falta la contraseña (cárgala en NanoFlow → Infraestructura → ${NF_ENVIRONMENT} → Datos y aplica core-infra)" > "$work/sb.err"; return 1
  fi
  pw=$(jq -r '.password' <<< "$admin")
  echo "::add-mask::${pw}"
  db_url=$(jq -r '"postgresql://\(.username | @uri):\(.password | @uri)@\(.host):\(.port // 5432)/\(.dbname // "postgres" | @uri)?sslmode=\(if (.sslmode // "") | IN("disable", "verify-ca", "verify-full") then .sslmode else "require" end)"' <<< "$admin")
  echo "::add-mask::${db_url}"
  app_ref=$(jq -r '.appSecretRef' <<< "$admin")
  if ! [[ "$app_ref" =~ $keyvault_secret_re ]] || [ "${BASH_REMATCH[1]}" != "$vault" ]; then
    echo "el secreto admin apunta a un secreto app que no está en el Key Vault del ambiente" > "$work/sb.err"; return 1
  fi
  if ! app=$(az keyvault secret show --id "$app_ref" --query value --output tsv 2> "$work/sm.err"); then
    echo "no se pudo leer el secreto app del Key Vault: $(tail -c 300 "$work/sm.err" | tr '\n' ' ')" > "$work/sb.err"; return 1
  fi
  app_password=$(jq -r '.password // ""' <<< "$app" 2>/dev/null || true)
  if [ -z "$app_password" ]; then
    echo "el secreto app no tiene contraseña" > "$work/sb.err"; return 1
  fi
  echo "::add-mask::${app_password}"
  user=$(jq -r '.username' <<< "$admin")
  echo "Supabase: ${user} en $(jq -r '.host' <<< "$admin") por el session pooler (secretos del Key Vault ${vault})."
}

# URL de la cola del job migrador de un PostgreSQL flexible en Azure: lo que
# trae NF_DB_<NOMBRE>_MIGRATOR con templates ≥ 0.27.0.
queue_migrator_re='^https://([a-z0-9]{3,24})\.queue\.core\.windows\.net/migrate$'
QUEUE_WAIT_SECONDS="${QUEUE_WAIT_SECONDS:-1800}"
QUEUE_POLL_SECONDS="${QUEUE_POLL_SECONDS:-15}"

# queue_target <nombre de la base>: deja en $q_account y $q_container la cuenta
# y el contenedor de peticiones del migrador ($fn es la URL de la cola). El
# contenedor sale de NF_DEPLOY_MIGRATIONS_<NOMBRE>_CONTAINER si NanoFlow lo
# escribió (tiene que ser de la misma cuenta) o es `migrations` de esa cuenta.
queue_target() {
  local cvar url
  [[ "$fn" =~ $queue_migrator_re ]]; q_account="${BASH_REMATCH[1]}"
  q_container=migrations
  cvar="NF_DEPLOY_MIGRATIONS_$(tr '[:lower:]-' '[:upper:]_' <<< "$1")_CONTAINER"
  url="${!cvar:-}"
  if [ -n "$url" ]; then
    if ! [[ "$url" =~ ^https://([a-z0-9]{3,24})\.blob\.core\.windows\.net/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$ ]] ||
       [ "${BASH_REMATCH[1]}" != "$q_account" ]; then
      echo "${cvar} no es un contenedor de la cuenta de la cola del migrador" > "$work/sb.err"; return 1
    fi
    q_container="${BASH_REMATCH[2]}"
  fi
  if ! command -v az >/dev/null 2>&1; then
    echo "el runner no tiene la CLI de Azure (az)" > "$work/sb.err"; return 1
  fi
  echo "Migrador en el ambiente: cola migrate y contenedor ${q_container} de la cuenta ${q_account}."
}

# queue_run <base> <apply|drift>: una ejecución del job migrador. Deja en
# $work/q/<paso>.json las respuestas que el job trae (bootstrap, before, apply,
# after) y, si la ejecución no llegó a correr un paso, el motivo en
# $q_err_code/$q_err_msg. Nunca imprime nada secreto: el job no recibe
# credenciales del runner, solo el migrador y los .sql.
queue_run() {
  local db="$1" mode="$2" id req="$work/qreq" waited=0 exists result="$work/qresult.json"
  local storage=(--account-name "$q_account" --auth-mode login --only-show-errors --output none)
  rm -rf "$work/q" "$req"; mkdir -p "$work/q" "$req"
  q_err_code=""; q_err_msg=""
  id="${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}-${db}-${mode}-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  jq -n --arg mode "$mode" --arg sha "${GITHUB_SHA:-}" '{mode: $mode, sha: $sha}' > "$req/request.json"
  cp "$cli" "$req/db-migrator"
  (cd "$dir" && find . -maxdepth 1 -type f -name '*.sql' | sed 's|^\./||' | LC_ALL=C sort) > "$work/qlist"
  if ! tar -czf "$req/migrations.tar.gz" -C "$dir" -T "$work/qlist" 2> "$work/q.err"; then
    q_err_code=MIGRATOR_UPLOAD_FAILED; q_err_msg="no se pudo empaquetar ${dir}: $(tail -c 300 "$work/q.err" | tr '\n' ' ')"; return 1
  fi
  for f in request.json db-migrator migrations.tar.gz; do
    if ! az storage blob upload --container-name "$q_container" --name "requests/${id}/${f}" --file "$req/$f" --overwrite "${storage[@]}" 2> "$work/q.err"; then
      q_err_code=MIGRATOR_UPLOAD_FAILED
      q_err_msg="no se pudo subir la petición al contenedor ${q_container} de ${q_account} (la identidad de despliegue de este repositorio debe poder escribir en él: construye y aplica la infraestructura con templates ≥ 0.27.0): $(tail -c 300 "$work/q.err" | tr '\n' ' ')"
      return 1
    fi
  done
  if ! az storage message put --queue-name migrate --content "$id" "${storage[@]}" 2> "$work/q.err"; then
    q_err_code=MIGRATOR_ENQUEUE_FAILED
    q_err_msg="no se pudo poner la petición en la cola migrate de ${q_account}: $(tail -c 300 "$work/q.err" | tr '\n' ' ')"
    return 1
  fi
  echo "Petición ${id} en la cola; esperando al job migrador (hasta ${QUEUE_WAIT_SECONDS} s)."
  while :; do
    if ! exists=$(az storage blob exists --container-name "$q_container" --name "results/${id}.json" --account-name "$q_account" --auth-mode login --only-show-errors --query exists --output tsv 2> "$work/q.err"); then
      q_err_code=MIGRATOR_RESULT_FAILED
      q_err_msg="no se pudo leer el resultado del job migrador: $(tail -c 300 "$work/q.err" | tr '\n' ' ')"
      return 1
    fi
    [ "$exists" = true ] && break
    if [ "$waited" -ge "$QUEUE_WAIT_SECONDS" ]; then
      q_err_code=MIGRATOR_TIMEOUT
      q_err_msg="el job migrador no dejó results/${id}.json en ${QUEUE_WAIT_SECONDS} s (revisa el job de Container Apps de la base en el ambiente)"
      return 1
    fi
    sleep "$QUEUE_POLL_SECONDS"; waited=$((waited + QUEUE_POLL_SECONDS))
  done
  if ! az storage blob download --container-name "$q_container" --name "results/${id}.json" --file "$result" "${storage[@]}" 2> "$work/q.err" ||
     ! jq -e --arg id "$id" --arg db "$db" 'type == "object" and .id == $id and .database == $db and (.steps | type == "object")' "$result" >/dev/null 2>&1; then
    q_err_code=MIGRATOR_RESULT_FAILED
    q_err_msg="el resultado del job migrador no es el de la petición ${id}"
    return 1
  fi
  for s in bootstrap before apply after; do
    jq -e --arg s "$s" '.steps[$s] | type == "object" and has("ok")' "$result" >/dev/null 2>&1 &&
      jq --arg s "$s" '.steps[$s]' "$result" > "$work/q/$s.json"
  done
  if [ "$(jq -r '.error // "" | tostring' "$result")" != "" ]; then
    q_err_code=MIGRATOR_JOB_FAILED
    q_err_msg="el job migrador falló: $(jq -r '.error | tostring' "$result" | head -c 400)"
  fi
  echo "Job migrador: petición ${id} $(jq -r 'if .ok then "terminada" else "con errores" end' "$result")."
}

# queue_step <acción> <con archivos> <respuesta.json>: la respuesta del paso que
# el job ya corrió (status con archivos = before, status sin ellos = after).
queue_step() {
  local step
  case "$1:$2" in
    bootstrap:*) step=bootstrap ;;
    status:yes) step=before ;;
    status:no) step=after ;;
    apply:*) step=apply ;;
    *) step="$1" ;;
  esac
  if [ -f "$work/q/$step.json" ]; then
    cp "$work/q/$step.json" "$3"
  else
    jq -n --arg c "${q_err_code:-MIGRATOR_JOB_FAILED}" --arg m "${q_err_msg:-el job migrador no corrió el paso ${step}}" \
      '{ok: false, applied: [], pending: [], error: {code: $c, message: $m}}' > "$3"
  fi
}

# kind_of <archivo>: el `-- nanoflow:kind` del encabezado (unknown si falta).
kind_of() {
  awk '
    { sub(/\r$/, "") }
    /^[ \t]*$/ { next }
    !/^[ \t]*--/ { exit }
    match($0, /^[ \t]*--[ \t]*nanoflow:kind[ \t]+[a-z]+/) {
      n = split(substr($0, RSTART, RLENGTH), w, /[ \t:]+/); print w[n]; found = 1; exit
    }
    END { if (!found) print "unknown" }' "$1"
}

# post_report <base> <payload.json>: POST /v1/ci/migrations con el token OIDC
# del job. Solo avisa si falla.
post_report() {
  local db="$1" payload="$2" oidc body code
  if [ -z "${NF_API_URL:-}" ]; then return 0; fi
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "::warning::NanoFlow no registró las migraciones de ${db}: el job no tiene 'permissions: id-token: write'."
    return 0
  fi
  oidc=$(curl -sS --fail --max-time 10 --retry 2 --retry-connrefused \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${NF_AUDIENCE}" | jq -r '.value') || oidc=""
  if [ -z "$oidc" ] || [ "$oidc" = "null" ]; then
    echo "::warning::NanoFlow no registró las migraciones de ${db}: GitHub no devolvió un token OIDC."
    return 0
  fi
  body="$work/report-body.json"
  code=$(curl -sS -o "$body" -w '%{http_code}' --max-time 15 --retry 2 --retry-connrefused \
    -X POST "${NF_API_URL%/}/v1/ci/migrations" \
    -H "Authorization: Bearer ${oidc}" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    --data-binary "@$payload") || code="000"
  if [ "$code" != "200" ]; then
    echo "::warning::NanoFlow no registró las migraciones de ${db}: HTTP ${code} $(jq -r '.message // ""' "$body" 2>/dev/null | head -c 300)"
    return 0
  fi
  echo "  NanoFlow registró las migraciones de ${db}$(jq -r 'if .stale then " (reporte más viejo que el guardado)" else "" end' "$body" 2>/dev/null)."
}

# state_of <respuesta status|"">: el estado aplicado para el reporte (null si
# no hay una respuesta ok).
state_filter='(if $st != null and $st.ok then [($st.applied // [])[] | {version, name, kind, checksum, appliedAt, appliedBy}] else null end)'

# report <base> <respuesta apply> <respuesta status|""> <snapshot>: informa una
# corrida de apply.
report() {
  local db="$1" applied="$2" state="$3" snapshot="$4" payload="$work/report.json"
  if [ -z "${NF_API_URL:-}" ]; then return 0; fi
  if ! jq -n --arg db "$db" --arg v "$MIGRATOR_VERSION" --arg snap "$snapshot" \
    --slurpfile a "$applied" --slurpfile s "${state:-/dev/null}" '
    ($a[0]) as $r | ($s[0] // null) as $st |
    {
      database: $db,
      migratorVersion: $v,
      status: (if $r.ok then "succeeded" else "failed" end),
      applied: [($r.applied // [])[] | .version],
      pending: ($r.pending // []),
      error: (if $r.ok then null else ($r.error // {code: "UNKNOWN", message: "sin detalle"}) end),
      snapshotId: (if $snap == "" then null else $snap end),
      state: '"$state_filter"'
    }' > "$payload"; then
    echo "::warning::NanoFlow no registró las migraciones de ${db}: no se pudo armar el reporte."
    return 0
  fi
  post_report "$db" "$payload"
}

# report_drift <base> <drift|""> <respuesta status> <respuesta status completo|"">:
# informa una corrida de drift (kind=drift, §16.2).
report_drift() {
  local db="$1" drift="$2" resp="$3" state="$4" payload="$work/report.json"
  if [ -z "${NF_API_URL:-}" ]; then return 0; fi
  if ! jq -n --arg db "$db" --arg v "$MIGRATOR_VERSION" --arg drift "$drift" \
    --slurpfile a "$resp" --slurpfile s "${state:-/dev/null}" '
    ($a[0]) as $r | ($s[0] // null) as $st |
    {
      kind: "drift",
      database: $db,
      migratorVersion: $v,
      status: (if $drift == "" then "failed" else "succeeded" end),
      drift: (if $drift == "" then null else $drift end),
      pending: ($r.pending // []),
      error: (if $r.ok then null else ($r.error // {code: "UNKNOWN", message: "sin detalle"}) end),
      state: '"$state_filter"'
    }' > "$payload"; then
    echo "::warning::NanoFlow no registró el drift de ${db}: no se pudo armar el reporte."
    return 0
  fi
  post_report "$db" "$payload"
}

# snapshot <identificador> <cluster true|false> <nombre>: crea el snapshot y
# espera a que esté disponible.
snapshot() {
  local id="$1" cluster="$2" name="$3" status waited=0
  if [ "$cluster" = "true" ]; then
    aws rds create-db-cluster-snapshot --db-cluster-identifier "$id" --db-cluster-snapshot-identifier "$name" >/dev/null
  else
    aws rds create-db-snapshot --db-instance-identifier "$id" --db-snapshot-identifier "$name" >/dev/null
  fi
  while :; do
    if [ "$cluster" = "true" ]; then
      status=$(aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "$name" --query 'DBClusterSnapshots[0].Status' --output text)
    else
      status=$(aws rds describe-db-snapshots --db-snapshot-identifier "$name" --query 'DBSnapshots[0].Status' --output text)
    fi
    case "$status" in
      available) return 0 ;;
      creating|backing-up|copying|pending) ;;
      *) echo "estado del snapshot: ${status}"; return 1 ;;
    esac
    if [ "$waited" -ge "$SNAPSHOT_WAIT_SECONDS" ]; then
      echo "el snapshot no terminó en ${SNAPSHOT_WAIT_SECONDS} s"
      return 1
    fi
    sleep 15; waited=$((waited + 15))
  done
}

# mismatch_message <respuesta con CHECKSUM_MISMATCH>: el mensaje del error
# explicado con el estado aplicado (status sin archivos) y los archivos de la
# rama. El migrador compara por versión, así que un 0001 de otro nombre es otro
# repositorio que migra la misma base (consola doc 49 §16: app-db de users-api
# y pj-api), no un archivo editado. Usa $db, $dir, $work y $files.
mismatch_message() {
  local resp="$1" v applied_name applied_by local_name
  v=$(jq -r '.error.version // ""' "$resp")
  if [ -z "$v" ]; then jq -r '.error.message' "$resp"; return; fi
  migrator status no "$work/applied.json" >/dev/null 2>&1 || true
  applied_name=$(jq -r --arg v "$v" '[.applied[]? | select(.version == $v) | .name] | first // ""' "$work/applied.json" 2>/dev/null || true)
  applied_by=$(jq -r --arg v "$v" '[.applied[]? | select(.version == $v) | .appliedBy // ""] | first // ""' "$work/applied.json" 2>/dev/null || true)
  local_name=$(jq -r --arg v "$v" '[.[] | select(.name | startswith($v + "_")) | .name] | first // ""' "$files")
  local by=""
  [ -n "$applied_by" ] && by=" desde el commit ${applied_by:0:12}"
  if [ -n "$applied_name" ] && [ -n "$local_name" ] && [ "$applied_name" != "$local_name" ]; then
    echo "la versión ${v} de ${db} ya la aplicó otro archivo, ${applied_name}${by}, y este repositorio trae ${local_name}: dos repositorios migran la misma base. Solo el repositorio dueño de ${db} (data[].owner en la arquitectura) trae sus migraciones: elige el dueño en Arquitectura y, en los demás repositorios, quita ${dir} y la entrada '${db}' de 'databases' en .nanoflow/deploy.yml (sus tablas las crea una migración del dueño)."
  elif [ -n "$applied_name" ] && [ -z "$local_name" ]; then
    echo "la versión ${v} de ${db} (${applied_name}${by}) está aplicada pero no está en ${dir}. Si otro repositorio migra la misma base, solo el dueño (data[].owner en la arquitectura) trae sus migraciones; si el archivo se borró, restáuralo: una migración aplicada no se borra ni se edita, se corrige con otra nueva."
  else
    echo "$(jq -r '.error.message' "$resp"). Una migración aplicada no se edita: deja ${local_name:-el archivo} como estaba y corrige con una migración nueva."
  fi
}

# ---------------------------------------------------------------- cada base
final_status=succeeded
final_error=""
summary=""
# fail <código> <mensaje>: marca la corrida como fallida (la base es $db).
fail() {
  echo "::error::${db}: $2"
  final_status=failed; final_error="${db}: $1"
  summary="${summary}| ${db} | ✗ $1 | |"$'\n'
}
for i in $(seq 0 $((count - 1))); do
  db=$(jq -r ".[$i].name // \"\"" <<< "$databases")
  dir=$(jq -r ".[$i].migrations // \"db/migrations\"" <<< "$databases")
  if ! [[ "$db" =~ ^[a-z][a-z0-9-]{1,40}$ ]]; then
    fail MANIFEST "databases[$i].name '${db}' no es un nombre de data[] válido"; break
  fi
  if [ ! -d "$dir" ]; then
    fail MANIFEST "no existe el directorio de migraciones ${dir}"; break
  fi
  var="NF_DB_$(tr '[:lower:]-' '[:upper:]_' <<< "$db")_MIGRATOR"
  fn="${!var:-}"
  if [ -z "$fn" ]; then
    fail MIGRATOR_NOT_FOUND "falta la variable ${var} en el GitHub Environment ${NF_ENVIRONMENT}. NanoFlow la escribe en el repo dueño de la base después del apply de core-infra (templates ≥ 0.9.0); revisa data[].owner en la arquitectura y que el workflow pase 'environment'."
    break
  fi
  echo "::group::${db} (${fn})"

  db_identifier=""; db_cluster=false; db_name=""; db_url=""; app_password=""
  if [[ "$fn" =~ ^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret: ]]; then
    # Supabase: la CLI en el runner con los secretos de la cuenta del ambiente.
    runner=true
    ensure_cli
    if ! supabase_env "$fn"; then
      echo "::endgroup::"
      fail MIGRATOR_NOT_FOUND "$(cat "$work/sb.err")"; break
    fi
  elif [[ "$fn" =~ $keyvault_secret_re ]]; then
    # Supabase en Microsoft Azure: la CLI en el runner con los secretos del
    # Key Vault del ambiente.
    runner=true
    ensure_cli
    if ! supabase_env_azure "$fn"; then
      echo "::endgroup::"
      fail MIGRATOR_NOT_FOUND "$(cat "$work/sb.err")"; break
    fi
  elif [[ "$fn" =~ $queue_migrator_re ]]; then
    # PostgreSQL flexible en Microsoft Azure: el job migrador del ambiente,
    # disparado por su cola. Corre todos los pasos de una vez; el flujo de
    # abajo lee sus respuestas.
    runner=queue
    ensure_cli
    if ! queue_target "$db"; then
      echo "::endgroup::"
      fail MIGRATOR_NOT_FOUND "$(cat "$work/sb.err")"; break
    fi
    queue_run "$db" "$MODE" || echo "::warning::${db}: ${q_err_msg}"
  else
    runner=false
    ensure_zip
    # Código del migrador.
    if ! cfg=$(aws lambda get-function-configuration --function-name "$fn" 2> "$work/cfg.err"); then
      echo "::endgroup::"
      fail MIGRATOR_NOT_FOUND "no se pudo leer la Lambda ${fn}: $(tail -c 300 "$work/cfg.err" | tr '\n' ' ')"; break
    fi
    if [ "$(jq -r '.CodeSha256' <<< "$cfg")" != "$want_b64" ]; then
      echo "Instalando nanoflow-db-migrator ${MIGRATOR_VERSION} en ${fn}"
      if ! aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" >/dev/null 2> "$work/cfg.err" ||
         ! aws lambda wait function-updated-v2 --function-name "$fn" 2> "$work/cfg.err"; then
        echo "::endgroup::"
        fail MIGRATOR_UPDATE_FAILED "no se pudo instalar el migrador en ${fn}: $(tail -c 300 "$work/cfg.err" | tr '\n' ' ')"; break
      fi
    fi
    db_identifier=$(jq -r '.Environment.Variables.DB_IDENTIFIER // ""' <<< "$cfg")
    db_cluster=$(jq -r '.Environment.Variables.DB_CLUSTER // "false"' <<< "$cfg")
    # Una base alojada en la instancia de otra (consola doc 50) trae su
    # propio DB_NAME; la base propia de la instancia es siempre `app`.
    db_name=$(jq -r '.Environment.Variables.DB_NAME // ""' <<< "$cfg")
  fi

  # Archivos (no recursivo, por nombre) como [{name, sql}].
  files="$work/files.json"
  : > "$work/files.ndjson"
  while IFS= read -r f; do
    jq -n --arg name "$(basename "$f")" --rawfile sql "$f" '{name: $name, sql: $sql}' >> "$work/files.ndjson"
  done < <(find "$dir" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
  jq -s '.' "$work/files.ndjson" > "$files"
  echo "$(jq 'length' "$files") archivos en ${dir}"

  if [ "$MODE" = drift ]; then
    # Solo lectura: status con los archivos de la rama.
    migrator status yes "$work/drift.json"
    if jq -e '.ok' "$work/drift.json" >/dev/null; then
      if [ "$(jq '.pending | length' "$work/drift.json")" -gt 0 ]; then drift=pending; else drift=in_sync; fi
      state="$work/drift.json"
    elif [ "$(jq -r '.error.code' "$work/drift.json")" = "CHECKSUM_MISMATCH" ]; then
      drift=mismatch
      migrator status no "$work/after.json"
      state="$work/after.json"
    else
      drift=""; state=""
    fi
    echo "::endgroup::"
    report_drift "$db" "$drift" "$work/drift.json" "$state"
    case "$drift" in
      in_sync) summary="${summary}| ${db} | ✓ en sincronía | |"$'\n' ;;
      pending) summary="${summary}| ${db} | ⚠ pendientes: $(jq -r '.pending | join(", ")' "$work/drift.json") | |"$'\n' ;;
      mismatch) fail SCHEMA_DRIFT "la base no coincide con ${dir}: $(mismatch_message "$work/drift.json")" ;;
      *) fail "$(jq -r '.error.code' "$work/drift.json")" "$(jq -r '.error.message' "$work/drift.json")" ;;
    esac
    continue
  fi

  # 1) bootstrap
  migrator bootstrap no "$work/bootstrap.json"
  if ! jq -e '.ok' "$work/bootstrap.json" >/dev/null; then
    echo "::endgroup::"
    report "$db" "$work/bootstrap.json" "" ""
    fail "$(jq -r '.error.code' "$work/bootstrap.json")" "bootstrap: $(jq -r '.error.message' "$work/bootstrap.json")"; break
  fi

  # 2) status con los archivos → pendientes
  if [ "$runner" = false ] && [ "$(jq -c '{action: "status", files: .}' "$files" | wc -c)" -gt "$MAX_PAYLOAD_BYTES" ]; then
    echo "::endgroup::"
    fail PAYLOAD_TOO_LARGE "las migraciones de ${dir} pesan más de 6 MB (límite de Lambda)"; break
  fi
  migrator status yes "$work/before.json"
  if ! jq -e '.ok' "$work/before.json" >/dev/null; then
    msg=$(jq -r '.error.message' "$work/before.json")
    if [ "$(jq -r '.error.code' "$work/before.json")" = "CHECKSUM_MISMATCH" ]; then
      msg=$(mismatch_message "$work/before.json")
    fi
    echo "::endgroup::"
    report "$db" "$work/before.json" "" ""
    fail "$(jq -r '.error.code' "$work/before.json")" "$msg"; break
  fi
  pending=$(jq -r '.pending[]?' "$work/before.json")
  echo "Pendientes: $(echo ${pending:-ninguna})"

  # 3) snapshot antes de un lote contract/destructive fuera de development
  snap=""
  if [ -n "$pending" ] && [ "$NF_ENVIRONMENT" != "development" ]; then
    risky=""
    for v in $pending; do
      f=$(find "$dir" -maxdepth 1 -type f -name "${v}_*.sql" | head -n 1)
      k=$([ -n "$f" ] && kind_of "$f" || echo unknown)
      case "$k" in contract|destructive) risky="${risky} ${v}(${k})" ;; esac
    done
    if [ -n "$risky" ] && [ "$runner" = true ]; then
      # Ni AWS ni Azure pueden crear un snapshot de Supabase (E9-D6).
      echo "::warning::${db}: hay migraciones${risky} en ${NF_ENVIRONMENT} y Supabase no admite snapshot desde el pipeline. Verifica antes los backups/PITR del proyecto Supabase."
    elif [ -n "$risky" ] && [ "$runner" = queue ]; then
      # El job migrador corre dentro del ambiente y no crea snapshot: el
      # servidor flexible tiene restauración a un punto en el tiempo.
      echo "::warning::${db}: hay migraciones${risky} en ${NF_ENVIRONMENT} y el migrador de Azure no crea snapshot. Si hay que volver atrás, restaura el servidor flexible a un punto en el tiempo anterior a este despliegue."
    elif [ -n "$risky" ]; then
      if [ -z "$db_identifier" ]; then
        echo "::endgroup::"
        fail SNAPSHOT_FAILED "hay migraciones${risky} y la Lambda no trae DB_IDENTIFIER (regenera core-infra con templates ≥ 0.9.0)"; break
      fi
      first=$(head -n 1 <<< "$pending")
      snap="${db_identifier}-pre-${first}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}"
      echo "Snapshot ${snap} antes de${risky}"
      if [ -n "$db_name" ] && [ "$db_name" != app ]; then
        echo "::warning::${db}: el snapshot es de toda la instancia ${db_identifier}, que también aloja otras bases. Restaurarlo vuelve atrás todas sus bases, no solo ${db}."
      fi
      if ! msg=$(snapshot "$db_identifier" "$db_cluster" "$snap" 2>&1); then
        echo "::endgroup::"
        fail SNAPSHOT_FAILED "no se pudo crear el snapshot ${snap}: ${msg##*$'\n'}"; break
      fi
    fi
  fi

  # 4) apply
  migrator apply yes "$work/apply.json"

  # 5) estado completo para NanoFlow (si falla, se informa sin estado)
  migrator status no "$work/after.json"
  echo "::endgroup::"
  report "$db" "$work/apply.json" "$work/after.json" "$snap"

  if ! jq -e '.ok' "$work/apply.json" >/dev/null; then
    fail "$(jq -r '.error.code' "$work/apply.json")" "$(jq -r '"\(.error.version // "") \(.error.message)"' "$work/apply.json")"
    break
  fi
  n=$(jq '.applied | length' "$work/apply.json")
  # Avisos del migrador (1.2.0+): p. ej. una migración sin `-- nanoflow:kind`.
  while IFS= read -r w; do [ -n "$w" ] && echo "::warning::${db}: ${w}"; done < <(jq -r '.warnings[]?' "$work/apply.json")
  version=$(jq -r 'if .ok then ([.applied[]?.version] | last // "—") else "?" end' "$work/after.json" 2>/dev/null || echo "?")
  echo "${db}: ${n} aplicadas; esquema en ${version}."
  summary="${summary}| ${db} | ✓ ${n} aplicadas | ${version}${snap:+ · snapshot ${snap}} |"$'\n'
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -n "$summary" ]; then
  { if [ "$MODE" = drift ]; then echo "### Drift de esquema (${NF_ENVIRONMENT})"; else echo "### Migraciones (${NF_ENVIRONMENT})"; fi; echo ""; echo "| Base | Resultado | Esquema |"; echo "|---|---|---|"; printf '%s' "$summary"; } >> "$GITHUB_STEP_SUMMARY"
fi
out "status=${final_status}"
out "error=${final_error}"
[ "$final_status" = "succeeded" ]
