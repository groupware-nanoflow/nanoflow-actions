#!/usr/bin/env bash
# Pruebas de migrate.sh en MODE=drift con una base Supabase de un proyecto de
# Microsoft Azure (db-drift-azure.yml):
#   bash actions/db-migrate/migrate.azure-drift.test.sh
# Sin red ni nube: `az`, `aws`, `yq`, `curl` y la CLI del migrador son dobles
# que viven en un directorio temporal. Solo necesita bash, jq y curl (para
# file://).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
real_curl="$(command -v curl)"

vault="kv-shop-dev-0000"
admin_ref="https://${vault}.vault.azure.net/secrets/db-app-db-admin"
app_ref="https://${vault}.vault.azure.net/secrets/db-app-db-app"
admin_pw='Adm1n-S3cret!'
app_pw='App-S3cret!'

# ------------------------------------------------------------------ los dobles
bin="$tmp/bin"; mkdir -p "$bin" "$tmp/dl/9.9.9" "$tmp/repo/db/migrations" "$tmp/rt"
printf -- '-- nanoflow:kind expand\nselect 1;\n' > "$tmp/repo/db/migrations/0001_init.sql"
printf 'databases:\n  - name: app-db\n    migrations: db/migrations\n' > "$tmp/repo/deploy.yml"

# yq: migrate.sh solo le pide `.databases` del manifiesto como JSON.
cat > "$bin/yq" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_DATABASES"
STUB

# az: solo `keyvault secret show --id <id> --query value --output tsv`.
cat > "$bin/az" <<'STUB'
#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
[ "$1 $2 $3 $4" = "keyvault secret show --id" ] || { echo "az: comando inesperado" >&2; exit 2; }
case "$5" in
  "$FAKE_ADMIN_REF") [ -n "$FAKE_ADMIN" ] || { echo "(Forbidden) Caller is not authorized to perform action on resource." >&2; exit 1; }; printf '%s\n' "$FAKE_ADMIN" ;;
  "$FAKE_APP_REF") printf '%s\n' "$FAKE_APP" ;;
  *) echo "(SecretNotFound)" >&2; exit 1 ;;
esac
STUB

# aws: en Azure no se llama nunca.
cat > "$bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
exit 1
STUB

# curl: file:// va al curl real (la descarga del migrador); el token OIDC y el
# reporte a NanoFlow se responden aquí y el cuerpo del reporte se guarda.
cat > "$bin/curl" <<STUB
#!/usr/bin/env bash
out=""; data=""; url=""; prev=""
for a in "\$@"; do
  case "\$prev" in -o) out="\$a" ;; --data-binary) data="\${a#@}" ;; esac
  case "\$a" in file://*|http://*|https://*) url="\$a" ;; esac
  prev="\$a"
done
case "\$url" in
  file://*) exec "$real_curl" "\$@" ;;
  *"/v1/ci/migrations") cp "\$data" "\$FAKE_REPORT"; echo '{"stale": false}' > "\$out"; printf '200' ;;
  *"audience="*) echo '{"value": "oidc-token"}' ;;
  *) echo "curl: URL inesperada" >&2; exit 7 ;;
esac
STUB

# La CLI del migrador: anota la acción y si recibió la conexión (no su valor)
# y responde lo que diga FAKE_STATUS_FILES (con --dir) o FAKE_STATUS_ALL.
cat > "$tmp/dl/9.9.9/db-migrator-linux-amd64" <<'STUB'
#!/usr/bin/env bash
with_dir=no; for a in "$@"; do [ "$a" = "--dir" ] && with_dir=yes; done
echo "cli $1 dir=${with_dir} url=$([ -n "${DATABASE_URL:-}" ] && echo set || echo unset) app=$([ -n "${APP_DB_PASSWORD:-}" ] && echo set || echo unset)" >> "$FAKE_LOG"
printf '%s' "$DATABASE_URL" > "$FAKE_URL_SEEN"
if [ "$with_dir" = yes ]; then printf '%s\n' "$FAKE_STATUS_FILES"; else printf '%s\n' "$FAKE_STATUS_ALL"; fi
STUB
chmod +x "$bin"/* "$tmp/dl/9.9.9/db-migrator-linux-amd64"
(cd "$tmp/dl/9.9.9" && shasum -a 256 db-migrator-linux-amd64 > db-migrator-linux-amd64.sha256)

applied='[{"version": "0001", "name": "init", "kind": "expand", "checksum": "abc", "appliedAt": "2026-11-01T00:00:00Z", "appliedBy": "ci"}]'
in_sync="{\"ok\": true, \"applied\": ${applied}, \"pending\": []}"
pending="{\"ok\": true, \"applied\": ${applied}, \"pending\": [\"0002\"]}"
mismatch='{"ok": false, "applied": [], "pending": [], "error": {"code": "CHECKSUM_MISMATCH", "message": "0001 cambió"}}'
broken='{"ok": false, "applied": [], "pending": [], "error": {"code": "CONNECT_FAILED", "message": "sin conexión"}}'
admin_json() { jq -cn --arg pw "$admin_pw" --arg app "$1" '{engine: "supabase", username: "postgres.abcd", password: $pw, host: "aws-0-us-east-2.pooler.supabase.com", port: 5432, dbname: "postgres", appSecretRef: $app}'; }
app_json="$(jq -cn --arg pw "$app_pw" '{username: "app_rw", password: $pw}')"

# run <respuesta con archivos> <secreto admin> [VAR=valor…]: corre migrate.sh
# en modo drift; deja stdout+stderr en $tmp/log, las salidas en $tmp/out, las
# llamadas a los dobles en $tmp/calls y el reporte en $tmp/report.json.
run() {
  local files_resp="$1" admin="$2"; shift 2
  : > "$tmp/out"; : > "$tmp/calls"; : > "$tmp/summary"; rm -f "$tmp/report.json" "$tmp/url-seen"
  (
    cd "$tmp/repo" || exit 99
    env -i PATH="$bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$tmp" \
      MODE=drift MANIFEST=deploy.yml NF_ENVIRONMENT=development \
      NF_API_URL=https://nanoflow.invalid NF_AUDIENCE=nanoflow-test \
      MIGRATOR_VERSION=9.9.9 MIGRATOR_BASE_URL="file://$tmp/dl" RUNNER_TEMP="$tmp/rt" \
      ACTIONS_ID_TOKEN_REQUEST_URL="https://token.invalid/?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
      GITHUB_SHA=deadbeef GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/summary" \
      NF_DB_APP_DB_MIGRATOR="$admin_ref" \
      FAKE_DATABASES='[{"name": "app-db", "migrations": "db/migrations"}]' \
      FAKE_LOG="$tmp/calls" FAKE_REPORT="$tmp/report.json" FAKE_URL_SEEN="$tmp/url-seen" \
      FAKE_ADMIN_REF="$admin_ref" FAKE_APP_REF="$app_ref" FAKE_ADMIN="$admin" FAKE_APP="$app_json" \
      FAKE_STATUS_FILES="$files_resp" FAKE_STATUS_ALL="$in_sync" \
      "$@" bash "$here/migrate.sh"
  ) > "$tmp/log" 2>&1
}
check() { # check <nombre> <condición ya evaluada: 0 = bien>
  if [ "$2" -eq 0 ]; then echo "ok   - $1"; else echo "FAIL - $1"; sed 's/^/       /' "$tmp/log" "$tmp/out" "$tmp/calls"; fails=$((fails + 1)); fi
}
has() { grep -qx "$1" "$tmp/out"; }
rep() { [ -f "$tmp/report.json" ] && jq -e "$1" "$tmp/report.json" >/dev/null; }
# Lo único que puede nombrar un secreto en el log es la orden de enmascararlo.
no_secret_leak() { ! grep -v '^::add-mask::' "$tmp/log" | grep -qF -e "$admin_pw" -e "$app_pw" -e "oidc-token"; }
read_only() { ! grep -q '^cli \(apply\|bootstrap\)' "$tmp/calls" && ! grep -q '^aws ' "$tmp/calls"; }

run "$in_sync" "$(admin_json "$app_ref")"; rc=$?
{ [ $rc -eq 0 ] && has "status=succeeded" && has "error=" &&
  rep '.kind == "drift" and .database == "app-db" and .status == "succeeded" and .drift == "in_sync" and .pending == [] and .error == null and .migratorVersion == "9.9.9" and (.state | length) == 1 and .state[0].version == "0001"'; }
check "en sincronía: el job pasa e informa kind=drift, drift=in_sync con el estado aplicado" $?
{ grep -qx 'cli status dir=yes url=set app=set' "$tmp/calls" && [ "$(grep -c '^cli ' "$tmp/calls")" -eq 1 ] && read_only; }
check "solo lectura: un único status con los archivos de la rama; ni apply, ni bootstrap, ni AWS" $?
{ grep -qx "az keyvault secret show --id ${admin_ref} --query value --output tsv" "$tmp/calls" &&
  grep -qx "az keyvault secret show --id ${app_ref} --query value --output tsv" "$tmp/calls" && [ "$(grep -c '^az ' "$tmp/calls")" -eq 2 ]; }
check "lee del Key Vault del ambiente el secreto admin y el app, y nada más" $?
{ no_secret_leak && grep -qxF "::add-mask::${admin_pw}" "$tmp/log" && grep -qxF "::add-mask::${app_pw}" "$tmp/log" &&
  grep -q '^::add-mask::postgresql://' "$tmp/log" && ! grep -qF "$admin_pw" "$tmp/report.json" "$tmp/out" "$tmp/summary"; }
check "las credenciales se enmascaran y no salen ni en el log, ni en el reporte, ni en el resumen" $?
{ grep -q '^postgresql://postgres.abcd:.*@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require$' "$tmp/url-seen"; }
check "la CLI recibe la conexión del session pooler armada con el secreto admin" $?
{ grep -q '^### Drift de esquema (development)$' "$tmp/summary" && grep -q '| app-db | ✓ en sincronía | |' "$tmp/summary"; }
check "el resumen del job es el mismo que en AWS" $?

run "$pending" "$(admin_json "$app_ref")"; rc=$?
{ [ $rc -eq 0 ] && has "status=succeeded" && rep '.status == "succeeded" and .drift == "pending" and .pending == ["0002"]' && read_only && no_secret_leak; }
check "pendientes: el job pasa e informa drift=pending con las versiones" $?

run "$mismatch" "$(admin_json "$app_ref")"; rc=$?
{ [ $rc -eq 1 ] && has "status=failed" && has "error=app-db: SCHEMA_DRIFT" &&
  rep '.status == "succeeded" and .drift == "mismatch" and .error.code == "CHECKSUM_MISMATCH" and (.state | length) == 1' &&
  grep -qx 'cli status dir=no url=set app=set' "$tmp/calls" && read_only && no_secret_leak; }
check "la base no coincide con el repo: informa drift=mismatch con el estado aplicado y falla el job" $?

run "$broken" "$(admin_json "$app_ref")"; rc=$?
{ [ $rc -eq 1 ] && has "status=failed" && has "error=app-db: CONNECT_FAILED" && rep '.status == "failed" and .drift == null and .error.code == "CONNECT_FAILED" and .state == null' && no_secret_leak; }
check "el migrador no pudo leer la base: informa failed sin drift y falla el job" $?

run "$in_sync" ""; rc=$?
{ [ $rc -eq 1 ] && has "status=failed" && has "error=app-db: MIGRATOR_NOT_FOUND" && grep -q 'no se pudo leer el secreto admin del Key Vault' "$tmp/log" &&
  ! grep -q '^cli ' "$tmp/calls" && ! grep -q '^aws ' "$tmp/calls" && [ ! -f "$tmp/report.json" ]; }
check "sin lectura del Key Vault: MIGRATOR_NOT_FOUND, sin tocar la base ni AWS" $?

run "$in_sync" "$(admin_json "https://otro-vault-0000.vault.azure.net/secrets/db-app-db-app")"; rc=$?
{ [ $rc -eq 1 ] && has "error=app-db: MIGRATOR_NOT_FOUND" && grep -q 'no está en el Key Vault del ambiente' "$tmp/log" &&
  [ "$(grep -c '^az ' "$tmp/calls")" -eq 1 ] && ! grep -q '^cli ' "$tmp/calls" && no_secret_leak; }
check "se rechaza un secreto app de otro Key Vault" $?

run "$in_sync" "$(admin_json "$app_ref" | jq -c '.password = ""')"; rc=$?
{ [ $rc -eq 1 ] && has "error=app-db: MIGRATOR_NOT_FOUND" && ! grep -q '^cli ' "$tmp/calls"; }
check "se rechaza un secreto admin sin contraseña" $?

run "$in_sync" "$(admin_json "$app_ref")" FAKE_DATABASES='[]'; rc=$?
{ [ $rc -eq 0 ] && has "status=skipped" && [ ! -s "$tmp/calls" ]; }
check "sin bases en el manifiesto no hace nada" $?

run "$in_sync" "$(admin_json "$app_ref")" NF_DB_APP_DB_MIGRATOR=; rc=$?
{ [ $rc -eq 1 ] && has "error=app-db: MIGRATOR_NOT_FOUND" && [ ! -s "$tmp/calls" ]; }
check "sin la variable del contrato (repo que no es dueño de la base): MIGRATOR_NOT_FOUND" $?

echo
if [ "$fails" -eq 0 ]; then echo "todas las pruebas pasaron"; else echo "${fails} pruebas fallaron"; exit 1; fi
