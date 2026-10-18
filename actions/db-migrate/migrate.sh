#!/usr/bin/env bash
# migrate.sh — migra las bases Postgres que declara el manifiesto, antes del
# deploy (doc 11 §14 de la consola, E5-D1 a E5-D7).
#
# Por cada `databases[]` de .nanoflow/deploy.yml:
#   1. Encuentra su Lambda migradora en NF_DB_<NOMBRE>_MIGRATOR (contrato de
#      plataforma; solo existe en el repo dueño de la base).
#   2. Le instala el código de nanoflow-db-migrator de la versión fijada, si no
#      es ya ese (zip del bucket público de NanoFlow, verificado por sha256).
#   3. bootstrap → status (pendientes) → snapshot si en staging/production hay
#      una pendiente contract o destructive → apply → status (estado completo).
#   4. Informa el resultado a NanoFlow (POST /v1/ci/migrations). El reporte
#      nunca hace fallar el paso; una migración fallida sí.
#
# Entorno: MANIFEST, NF_ENVIRONMENT (development|staging|production, el que
# resolvió NanoFlow), NF_API_URL, NF_AUDIENCE, MIGRATOR_VERSION,
# MIGRATOR_BASE_URL (opcional), credenciales AWS de la cuenta del ambiente,
# GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT.
# Salidas: status (skipped|succeeded|failed) y error ("<base>: <código>").
#
# Nunca imprime el SQL, secretos ni el token: solo nombres, versiones y códigos.
set -euo pipefail

: "${MANIFEST:?MANIFEST vacío}"
: "${NF_ENVIRONMENT:?NF_ENVIRONMENT vacío}"
MIGRATOR_VERSION="${MIGRATOR_VERSION:-1.1.0}"
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
zip="$work/db-migrator-lambda-arm64.zip"
if ! curl -fsSL --max-time 120 --retry 3 -o "$zip" "$base_url/db-migrator-lambda-arm64.zip" ||
   ! curl -fsSL --max-time 30 --retry 3 -o "$zip.sha256" "$base_url/db-migrator-lambda-arm64.zip.sha256"; then
  echo "::error::No se pudo descargar nanoflow-db-migrator ${MIGRATOR_VERSION} de ${base_url}."
  out "status=failed"; out "error=migrator: download"
  exit 1
fi
want_hex=$(awk '{print $1; exit}' "$zip.sha256")
got_hex=$( (sha256sum "$zip" 2>/dev/null || shasum -a 256 "$zip") | awk '{print $1}')
if ! [[ "$want_hex" =~ ^[0-9a-f]{64}$ ]] || [ "$want_hex" != "$got_hex" ]; then
  echo "::error::El zip de nanoflow-db-migrator ${MIGRATOR_VERSION} no coincide con su .sha256."
  out "status=failed"; out "error=migrator: checksum"
  exit 1
fi
# Lambda informa CodeSha256 como base64 del sha256 binario.
want_b64=$(printf '%s' "$want_hex" | xxd -r -p | base64)
echo "nanoflow-db-migrator ${MIGRATOR_VERSION} (sha256 ${want_hex:0:12}…)"

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

# report <base> <respuesta apply> <respuesta status|""> <snapshot>: POST
# /v1/ci/migrations. Solo avisa si falla.
report() {
  local db="$1" applied="$2" state="$3" snapshot="$4" oidc payload body code
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
  payload="$work/report.json"
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
      state: (if $st != null and $st.ok then [($st.applied // [])[] | {version, name, kind, checksum, appliedAt, appliedBy}] else null end)
    }' > "$payload"; then
    echo "::warning::NanoFlow no registró las migraciones de ${db}: no se pudo armar el reporte."
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

  # Archivos (no recursivo, por nombre) como [{name, sql}].
  files="$work/files.json"
  : > "$work/files.ndjson"
  while IFS= read -r f; do
    jq -n --arg name "$(basename "$f")" --rawfile sql "$f" '{name: $name, sql: $sql}' >> "$work/files.ndjson"
  done < <(find "$dir" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
  jq -s '.' "$work/files.ndjson" > "$files"
  echo "$(jq 'length' "$files") archivos en ${dir}"

  # 1) bootstrap
  echo '{"action":"bootstrap"}' > "$work/p.json"
  invoke "$fn" "$work/p.json" "$work/bootstrap.json"
  if ! jq -e '.ok' "$work/bootstrap.json" >/dev/null; then
    echo "::endgroup::"
    report "$db" "$work/bootstrap.json" "" ""
    fail "$(jq -r '.error.code' "$work/bootstrap.json")" "bootstrap: $(jq -r '.error.message' "$work/bootstrap.json")"; break
  fi

  # 2) status con los archivos → pendientes
  jq -c '{action: "status", files: .}' "$files" > "$work/p.json"
  if [ "$(wc -c < "$work/p.json")" -gt "$MAX_PAYLOAD_BYTES" ]; then
    echo "::endgroup::"
    fail PAYLOAD_TOO_LARGE "las migraciones de ${dir} pesan más de 6 MB (límite de Lambda)"; break
  fi
  invoke "$fn" "$work/p.json" "$work/before.json"
  if ! jq -e '.ok' "$work/before.json" >/dev/null; then
    echo "::endgroup::"
    report "$db" "$work/before.json" "" ""
    fail "$(jq -r '.error.code' "$work/before.json")" "$(jq -r '.error.message' "$work/before.json")"; break
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
    if [ -n "$risky" ]; then
      if [ -z "$db_identifier" ]; then
        echo "::endgroup::"
        fail SNAPSHOT_FAILED "hay migraciones${risky} y la Lambda no trae DB_IDENTIFIER (regenera core-infra con templates ≥ 0.9.0)"; break
      fi
      first=$(head -n 1 <<< "$pending")
      snap="${db_identifier}-pre-${first}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}"
      echo "Snapshot ${snap} antes de${risky}"
      if ! msg=$(snapshot "$db_identifier" "$db_cluster" "$snap" 2>&1); then
        echo "::endgroup::"
        fail SNAPSHOT_FAILED "no se pudo crear el snapshot ${snap}: ${msg##*$'\n'}"; break
      fi
    fi
  fi

  # 4) apply
  jq -c --arg sha "${GITHUB_SHA:-}" '{action: "apply", files: ., sha: $sha}' "$files" > "$work/p.json"
  invoke "$fn" "$work/p.json" "$work/apply.json"

  # 5) estado completo para NanoFlow (si falla, se informa sin estado)
  echo '{"action":"status"}' > "$work/p.json"
  invoke "$fn" "$work/p.json" "$work/after.json"
  echo "::endgroup::"
  report "$db" "$work/apply.json" "$work/after.json" "$snap"

  if ! jq -e '.ok' "$work/apply.json" >/dev/null; then
    fail "$(jq -r '.error.code' "$work/apply.json")" "$(jq -r '"\(.error.version // "") \(.error.message)"' "$work/apply.json")"
    break
  fi
  n=$(jq '.applied | length' "$work/apply.json")
  version=$(jq -r 'if .ok then ([.applied[]?.version] | last // "—") else "?" end' "$work/after.json" 2>/dev/null || echo "?")
  echo "${db}: ${n} aplicadas; esquema en ${version}."
  summary="${summary}| ${db} | ✓ ${n} aplicadas | ${version}${snap:+ · snapshot ${snap}} |"$'\n'
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -n "$summary" ]; then
  { echo "### Migraciones (${NF_ENVIRONMENT})"; echo ""; echo "| Base | Resultado | Esquema |"; echo "|---|---|---|"; printf '%s' "$summary"; } >> "$GITHUB_STEP_SUMMARY"
fi
out "status=${final_status}"
out "error=${final_error}"
[ "$final_status" = "succeeded" ]
