#!/usr/bin/env bash
# Pruebas de migrate.sh con el migrador en Lambda (AWS) y el snapshot previo a
# una migración contract fuera de development:
#   bash actions/db-migrate/migrate.aws-lambda.test.sh
# Sin red ni nube: `aws`, `yq` y `curl` son dobles en un directorio temporal.
# Solo necesita bash, jq, xxd y curl (para file://).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
real_curl="$(command -v curl)"

# ------------------------------------------------------------------ los dobles
bin="$tmp/bin"; mkdir -p "$bin" "$tmp/dl/9.9.9" "$tmp/repo/db/migrations" "$tmp/rt"
printf -- '-- nanoflow:kind expand\nCREATE TABLE app.a (id int);\n' > "$tmp/repo/db/migrations/0001_init.sql"
printf -- '-- nanoflow:kind contract\nALTER TABLE app.a DROP COLUMN id;\n' > "$tmp/repo/db/migrations/0002_drop.sql"
printf 'databases:\n  - name: pj-db\n    migrations: db/migrations\n' > "$tmp/repo/deploy.yml"
printf 'zip' > "$tmp/dl/9.9.9/db-migrator-lambda-arm64.zip"
(cd "$tmp/dl/9.9.9" && shasum -a 256 db-migrator-lambda-arm64.zip > db-migrator-lambda-arm64.zip.sha256)
code_b64=$(awk '{print $1}' "$tmp/dl/9.9.9/db-migrator-lambda-arm64.zip.sha256" | xxd -r -p | base64)

cat > "$bin/yq" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_DATABASES"
STUB

# aws: la configuración de la Lambda (código ya instalado), sus invocaciones
# según la acción y el snapshot de RDS.
cat > "$bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
  "lambda get-function-configuration")
    jq -n --arg code "$FAKE_CODE_B64" --arg name "$FAKE_DB_NAME" \
      '{CodeSha256: $code, Environment: {Variables: {DB_IDENTIFIER: "shop-stg-app-db", DB_CLUSTER: "false", DB_NAME: $name}}}' ;;
  "lambda invoke")
    payload=""; prev=""
    for a in "$@"; do [ "$prev" = "--payload" ] && payload="${a#fileb://}"; prev="$a"; done
    resp="${!#}"
    applied1='[{"version": "0001", "name": "0001_init.sql", "kind": "expand", "checksum": "a"}]'
    case "$(jq -r '.action + ":" + (has("files") | tostring)' "$payload")" in
      bootstrap:*) echo '{"ok": true, "applied": [], "pending": []}' > "$resp" ;;
      status:true) echo "{\"ok\": true, \"applied\": ${applied1}, \"pending\": [\"0002\"]}" > "$resp" ;;
      apply:*) echo '{"ok": true, "applied": [{"version": "0002", "name": "0002_drop.sql", "kind": "contract", "executionMs": 1}], "pending": []}' > "$resp" ;;
      status:false) echo "{\"ok\": true, \"applied\": ${applied1}, \"pending\": []}" > "$resp" ;;
    esac
    echo '{"StatusCode": 200}' ;;
  "rds create-db-snapshot") echo '{}' ;;
  "rds describe-db-snapshots") echo available ;;
  *) echo "aws: comando inesperado $*" >&2; exit 2 ;;
esac
STUB

cat > "$bin/curl" <<STUB
#!/usr/bin/env bash
out=""; url=""; prev=""
for a in "\$@"; do
  case "\$prev" in -o) out="\$a" ;; esac
  case "\$a" in file://*|http://*|https://*) url="\$a" ;; esac
  prev="\$a"
done
case "\$url" in
  file://*) exec "$real_curl" "\$@" ;;
  *"/v1/ci/migrations") echo '{"stale": false}' > "\$out"; printf '200' ;;
  *"audience="*) echo '{"value": "oidc-token"}' ;;
  *) echo "curl: URL inesperada" >&2; exit 7 ;;
esac
STUB
chmod +x "$bin"/*

# run <DB_NAME de la Lambda>: corre migrate.sh en staging con la base pj-db.
run() {
  : > "$tmp/out"; : > "$tmp/calls"; : > "$tmp/summary"
  (
    cd "$tmp/repo" || exit 99
    env -i PATH="$bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$tmp" \
      MODE=apply MANIFEST=deploy.yml NF_ENVIRONMENT=staging \
      NF_API_URL=https://nanoflow.invalid NF_AUDIENCE=nanoflow-test \
      MIGRATOR_VERSION=9.9.9 MIGRATOR_BASE_URL="file://$tmp/dl" RUNNER_TEMP="$tmp/rt" \
      ACTIONS_ID_TOKEN_REQUEST_URL="https://token.invalid/?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
      GITHUB_SHA=deadbeef GITHUB_RUN_ID=7 GITHUB_RUN_ATTEMPT=1 GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/summary" \
      NF_DB_PJ_DB_MIGRATOR=shop-stg-pj-db-migrator \
      FAKE_DATABASES='[{"name": "pj-db", "migrations": "db/migrations"}]' \
      FAKE_LOG="$tmp/calls" FAKE_CODE_B64="$code_b64" FAKE_DB_NAME="$1" \
      bash "$here/migrate.sh"
  ) > "$tmp/log" 2>&1
}
check() {
  if [ "$2" -eq 0 ]; then echo "ok   - $1"; else echo "FAIL - $1"; sed 's/^/       /' "$tmp/log" "$tmp/out" "$tmp/calls"; fails=$((fails + 1)); fi
}
has() { grep -qx "$1" "$tmp/out"; }

# Consola doc 50: una base alojada (DB_NAME propio) avisa que el snapshot es de
# toda la instancia.
run pj_db; rc=$?
{ [ $rc -eq 0 ] && has "status=succeeded" &&
  grep -q '^aws rds create-db-snapshot --db-instance-identifier shop-stg-app-db --db-snapshot-identifier shop-stg-app-db-pre-0002-7-1$' "$tmp/calls" &&
  grep -qF '::warning::pj-db: el snapshot es de toda la instancia shop-stg-app-db, que también aloja otras bases.' "$tmp/log" &&
  ! grep -q 'update-function-code' "$tmp/calls"; }
check "base alojada: snapshot de la instancia antes del contract, con el aviso de que alcanza a todas sus bases" $?

run app; rc=$?
{ [ $rc -eq 0 ] && has "status=succeeded" && grep -q '^aws rds create-db-snapshot ' "$tmp/calls" &&
  ! grep -qF 'también aloja otras bases' "$tmp/log"; }
check "la base propia de la instancia (DB_NAME=app): snapshot como siempre, sin el aviso" $?

run ""; rc=$?
{ [ $rc -eq 0 ] && ! grep -qF 'también aloja otras bases' "$tmp/log"; }
check "una Lambda sin DB_NAME (vieja): sin el aviso" $?

echo
if [ "$fails" -eq 0 ]; then echo "todas las pruebas pasaron"; else echo "${fails} pruebas fallaron"; exit 1; fi
