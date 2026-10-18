#!/usr/bin/env bash
# check.sh — revisa las migraciones de un PR sin tocar ninguna base real
# (doc 11 §14 de la consola, E5-D10 a E5-D12). Por cada `databases[]` del
# manifiesto:
#   1. lint (db-migrator lint): nombres, numeración, inmutabilidad contra la
#      rama base, `-- nanoflow:kind` obligatorio y no menor que el detectado;
#   2. squawk sobre los archivos nuevos (seguridad operativa de locks);
#   3. Postgres efímero: bootstrap + apply desde cero;
#   4. aislamiento por tenant (db-migrator isolation) si la arquitectura dice
#      multiTenancy: pool.
# Reporta todos los hallazgos y sale con 1 si hubo alguno. En un pull_request
# con NF_API_URL, informa a NanoFlow el resultado de cada base (kind=check,
# doc 11 §16.2): es el dry-run que exigen los gates de la promoción.
#
# Entorno: MANIFEST, ARCHITECTURE (.nanoflow/architecture.json), BASE_REF
# (rama base del PR; vacío = sin base), PG_ADMIN_URL (superusuario del
# Postgres efímero; necesita psql), MIGRATOR_BIN, SQUAWK_BIN, GITHUB_STEP_SUMMARY;
# para el reporte: NF_API_URL, NF_AUDIENCE, HEAD_SHA, PR_NUMBER,
# GITHUB_EVENT_NAME.
set -euo pipefail

: "${MANIFEST:?MANIFEST vacío}"
: "${PG_ADMIN_URL:?PG_ADMIN_URL vacío}"
: "${MIGRATOR_BIN:?MIGRATOR_BIN vacío}"
: "${SQUAWK_BIN:?SQUAWK_BIN vacío}"
ARCHITECTURE="${ARCHITECTURE:-.nanoflow/architecture.json}"

# squawk: los timeouts los fija el migrador; identity/bigint son estilo.
SQUAWK_EXCLUDE="require-lock-timeout,require-statement-timeout,prefer-identity,prefer-bigint-over-int,prefer-bigint-over-smallint"
# Lo que un contract/destructive declarado hace a propósito.
SQUAWK_EXCLUDE_CONTRACT="ban-drop-column,renaming-column,renaming-table,ban-drop-table,ban-drop-not-null,ban-drop-database"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nf-db-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT

databases=$(yq -o=json '.databases // []' "$MANIFEST")
count=$(jq 'length' <<< "$databases")
if [ "$count" -eq 0 ]; then
  echo "El manifiesto no declara bases: nada que revisar."
  exit 0
fi

pool=false
if [ -f "$ARCHITECTURE" ] && [ "$(jq -r '.patterns.multiTenancy // ""' "$ARCHITECTURE" 2>/dev/null)" = "pool" ]; then
  pool=true
fi

failed=0
summary=""
row() { summary="${summary}| $1 | $2 | $3 |"$'\n'; }

# db_fail <código> <mensaje>: la base actual falla; el primer error es el que
# se informa.
db_fail() {
  failed=1
  if [ "$db_status" = succeeded ]; then
    db_status=failed; db_error_code="$1"; db_error_msg="$2"
  fi
}

# report_check <base> <lint.json|"">: POST /v1/ci/migrations kind=check. Solo
# en un pull_request y con NF_API_URL; nunca hace fallar el paso.
report_check() {
  local db="$1" lint="$2" oidc payload="$work/report.json" body="$work/report-body.json" code
  [ "${GITHUB_EVENT_NAME:-}" = pull_request ] && [ -n "${NF_API_URL:-}" ] || return 0
  if ! [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::warning::NanoFlow no registró el check de ${db}: falta el head del PR."; return 0
  fi
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "::warning::NanoFlow no registró el check de ${db}: el job no tiene 'permissions: id-token: write'."; return 0
  fi
  oidc=$(curl -sS --fail --max-time 10 --retry 2 --retry-connrefused \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${NF_AUDIENCE}" | jq -r '.value') || oidc=""
  if [ -z "$oidc" ] || [ "$oidc" = "null" ]; then
    echo "::warning::NanoFlow no registró el check de ${db}: GitHub no devolvió un token OIDC."; return 0
  fi
  if ! jq -n --arg db "$db" --arg sha "$HEAD_SHA" --arg pr "${PR_NUMBER:-}" --arg st "$db_status" \
      --arg code "$db_error_code" --arg msg "$db_error_msg" --slurpfile l "${lint:-/dev/null}" '
      {
        kind: "check", database: $db, headSha: $sha,
        prNumber: (if $pr == "" then null else ($pr | tonumber) end),
        status: $st,
        pending: [(($l[0] // {}).files // [])[] | select(.new and (.version // "") != "") | {version, name, kind}],
        error: (if $st == "succeeded" then null else {code: $code, message: ($msg | .[0:1000])} end)
      }' > "$payload"; then
    echo "::warning::NanoFlow no registró el check de ${db}: no se pudo armar el reporte."; return 0
  fi
  code=$(curl -sS -o "$body" -w '%{http_code}' --max-time 15 --retry 2 --retry-connrefused \
    -X POST "${NF_API_URL%/}/v1/ci/migrations" \
    -H "Authorization: Bearer ${oidc}" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    --data-binary "@$payload") || code="000"
  if [ "$code" != "200" ]; then
    echo "::warning::NanoFlow no registró el check de ${db}: HTTP ${code} $(jq -r '.message // ""' "$body" 2>/dev/null | head -c 300)"
    return 0
  fi
  echo "NanoFlow registró el check de ${db} hacia $(jq -r '.environment // "?"' "$body" 2>/dev/null)."
}

# with_db <url> <db>: la URL del Postgres efímero apuntando a otra base.
with_db() { sed -E "s#^(postgres(ql)?://[^/]+)/[^?]*#\1/$2#" <<< "$1"; }

for i in $(seq 0 $((count - 1))); do
  db=$(jq -r ".[$i].name // \"\"" <<< "$databases")
  dir=$(jq -r ".[$i].migrations // \"db/migrations\"" <<< "$databases")
  db_status=succeeded; db_error_code=""; db_error_msg=""
  echo "::group::${db} (${dir})"
  if ! [[ "$db" =~ ^[a-z][a-z0-9-]{1,40}$ ]] || [ ! -d "$dir" ]; then
    echo "::error::databases[$i]: nombre inválido o no existe ${dir}"
    row "$db" "manifiesto" "✗"; failed=1; echo "::endgroup::"; continue
  fi

  # 1) lint contra la rama base
  base_dir="$work/base/$db"
  mkdir -p "$base_dir"
  base_arg=()
  if [ -n "${BASE_REF:-}" ]; then
    if git cat-file -e "origin/${BASE_REF}:${dir}" 2>/dev/null; then
      git archive "origin/${BASE_REF}" "$dir" | tar -x -C "$base_dir"
      base_arg=(--base-dir "$base_dir/$dir")
    else
      echo "La rama base ${BASE_REF} no tiene ${dir}: todas las migraciones son nuevas."
    fi
  fi
  lint="$work/lint-$db.json"
  if "$MIGRATOR_BIN" lint --dir "$dir" ${base_arg[@]+"${base_arg[@]}"} > "$lint"; then
    row "$db" "lint" "✓ $(jq '[.files[] | select(.new)] | length' "$lint") nuevas"
  else
    jq -r --arg dir "$dir" '.issues[] | "::error" + (if .file then " file=\($dir)/\(.file)" else "" end) + "::\(.code): \(.message)"' "$lint"
    row "$db" "lint" "✗ $(jq -r '[.issues[].code] | unique | join(", ")' "$lint")"
    db_fail "$(jq -r '.issues[0].code' "$lint")" "$(jq -r '.issues[0] | (if .file then .file + ": " else "" end) + .message' "$lint")"
  fi

  # 2) squawk sobre las nuevas
  sq_fail=0
  while IFS=$'\t' read -r name kind; do
    [ -n "$name" ] || continue
    f="$dir/$name"
    exclude="$SQUAWK_EXCLUDE"
    case "$kind" in contract|destructive) exclude="${exclude},${SQUAWK_EXCLUDE_CONTRACT}" ;; esac
    tx=(--assume-in-transaction)
    if awk '{ sub(/\r$/, "") } /^[ \t]*$/ { next } !/^[ \t]*--/ { exit 1 } /nanoflow:no-transaction/ { exit 0 }' "$f"; then
      tx=()
    fi
    if ! "$SQUAWK_BIN" --pg-version=16 ${tx[@]+"${tx[@]}"} --exclude="$exclude" --reporter gcc "$f" > "$work/sq.txt" 2>&1; then
      # El reporter gcc de squawk numera las líneas desde 0.
      awk 'match($0, /^[^:]+:[0-9]+:[0-9]+: (warning|error): /) {
             split($0, p, ":"); rest = substr($0, RLENGTH + 1); rule = rest; sub(/ .*/, "", rule); msg = substr(rest, length(rule) + 2)
             printf "::error file=%s,line=%d::squawk %s: %s\n", p[1], p[2] + 1, rule, msg; next }
           { print }' "$work/sq.txt"
      sq_fail=1
    fi
  done < <(jq -r '.files[]? | select(.new) | [.name, .kind] | @tsv' "$lint")
  if [ "$sq_fail" = 1 ]; then row "$db" "squawk" "✗"; db_fail SQUAWK "squawk encontró problemas de locks en las migraciones nuevas"; else row "$db" "squawk" "✓"; fi

  # 3) Postgres efímero desde cero
  test_db="nf_check_$(tr '-' '_' <<< "$db")"
  if ! psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${test_db}" -c "CREATE DATABASE ${test_db}" >/dev/null; then
    echo "::error::no se pudo crear la base efímera ${test_db}"
    row "$db" "apply desde cero" "✗ Postgres"; db_fail CHECK_FAILED "no se pudo crear la base efímera"
    echo "::endgroup::"; report_check "$db" "$lint"; continue
  fi
  url=$(with_db "$PG_ADMIN_URL" "$test_db")
  export APP_DB_PASSWORD
  APP_DB_PASSWORD="check-$(openssl rand -hex 12)"
  applied_ok=0
  if DATABASE_URL="$url" "$MIGRATOR_BIN" bootstrap > "$work/boot.json" 2>/dev/null &&
     DATABASE_URL="$url" "$MIGRATOR_BIN" apply --dir "$dir" --sha "${GITHUB_SHA:-check}" > "$work/apply.json" 2>/dev/null; then
    applied_ok=1
    row "$db" "apply desde cero" "✓ $(jq '.applied | length' "$work/apply.json") migraciones$(jq -r 'if (.unverified // []) | length > 0 then " (" + ((.unverified) | join(", ")) + " sin transacción)" else "" end' "$work/apply.json")"
  else
    res="$work/apply.json"; [ -s "$res" ] || res="$work/boot.json"
    jq -r --arg dir "$dir" '"::error::apply desde cero: \(.error.code) \(.error.version // "") \(.error.message)"' "$res" 2>/dev/null || echo "::error::apply desde cero falló"
    row "$db" "apply desde cero" "✗ $(jq -r '.error.code // "?"' "$res" 2>/dev/null)"
    db_fail "$(jq -r '.error.code // "MIGRATION_FAILED"' "$res" 2>/dev/null)" "$(jq -r '"\(.error.version // "") \(.error.message // "")"' "$res" 2>/dev/null)"
  fi

  # 4) aislamiento por tenant
  if [ "$pool" = true ] && [ "$applied_ok" = 1 ]; then
    if DATABASE_URL="$url" "$MIGRATOR_BIN" isolation > "$work/iso.json" 2>/dev/null; then
      row "$db" "aislamiento (pool)" "✓ $(jq '.tables | length' "$work/iso.json") tablas"
    else
      jq -r '(.issues[]? | "::error::aislamiento: \(.code) \(.message)"), (if .error then "::error::aislamiento: \(.error.code) \(.error.message)" else empty end)' "$work/iso.json"
      row "$db" "aislamiento (pool)" "✗ $(jq -r '[.issues[]?.code] | unique | join(", ")' "$work/iso.json")"
      db_fail "$(jq -r '.issues[0].code // .error.code // "ISOLATION"' "$work/iso.json")" "$(jq -r '.issues[0].message // .error.message // ""' "$work/iso.json")"
    fi
  fi
  echo "::endgroup::"
  report_check "$db" "$lint"
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Migraciones"; echo ""; echo "| Base | Check | Resultado |"; echo "|---|---|---|"; printf '%s' "$summary"; } >> "$GITHUB_STEP_SUMMARY"
fi
printf '%s' "$summary"
exit "$failed"
