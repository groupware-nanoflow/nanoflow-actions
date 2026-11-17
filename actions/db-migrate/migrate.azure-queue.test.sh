#!/usr/bin/env bash
# Pruebas de migrate.sh con una base PostgreSQL flexible de un proyecto de
# Microsoft Azure (templates ≥ 0.27.0): NF_DB_<NOMBRE>_MIGRATOR es la URL de la
# cola del job migrador del ambiente.
#   bash actions/db-migrate/migrate.azure-queue.test.sh
# Sin red ni nube: `az`, `aws`, `yq`, `curl` son dobles en un directorio
# temporal. El doble de `az` hace de cuenta de almacenamiento y de job: guarda
# lo subido y, al leer el resultado, responde FAKE_RESULT (con el id de la
# petición). Solo necesita bash, jq, tar y curl (para file://).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
real_curl="$(command -v curl)"

account="stshopdevledger1a2b3c4d"
queue_url="https://${account}.queue.core.windows.net/migrate"
container_url="https://${account}.blob.core.windows.net/migrations"

# ------------------------------------------------------------------ los dobles
bin="$tmp/bin"; mkdir -p "$bin" "$tmp/dl/9.9.9" "$tmp/repo/db/migrations" "$tmp/rt" "$tmp/store"
printf -- '-- nanoflow:kind expand\nselect 1;\n' > "$tmp/repo/db/migrations/0001_init.sql"
printf -- '-- nanoflow:kind contract\nselect 2;\n' > "$tmp/repo/db/migrations/0002_drop.sql"
printf 'not sql\n' > "$tmp/repo/db/migrations/README.md"
printf 'databases:\n  - name: ledger-db\n    migrations: db/migrations\n' > "$tmp/repo/deploy.yml"

cat > "$bin/yq" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_DATABASES"
STUB

# az storage blob upload|exists|download y storage message put. Anota cada
# llamada (sin el contenido) y guarda lo subido en $FAKE_STORE/<contenedor>/.
cat > "$bin/az" <<'STUB'
#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
arg() { local want="$1"; shift; local prev=""; for a in "$@"; do [ "$prev" = "$want" ] && { printf '%s' "$a"; return; }; prev="$a"; done; }
acct=$(arg --account-name "$@"); cont=$(arg --container-name "$@"); name=$(arg --name "$@"); file=$(arg --file "$@")
[ "$acct" = "$FAKE_ACCOUNT" ] || { echo "(AccountNotFound)" >&2; exit 1; }
case "$1 $2 $3" in
  "storage blob upload")
    [ -z "$FAKE_DENY_UPLOAD" ] || { echo "(AuthorizationPermissionMismatch) This request is not authorized." >&2; exit 1; }
    mkdir -p "$FAKE_STORE/$cont/$(dirname "$name")"; cp "$file" "$FAKE_STORE/$cont/$name" ;;
  "storage message put")
    printf '%s\n' "$(arg --content "$@")" >> "$FAKE_STORE/queue" ;;
  "storage blob exists")
    id=$(sed -n 1p "$FAKE_STORE/queue" 2>/dev/null)
    if [ -n "$FAKE_RESULT" ] && [ "$name" = "results/${id}.json" ]; then echo true; else echo false; fi ;;
  "storage blob download")
    id=$(sed -n 1p "$FAKE_STORE/queue")
    jq --arg id "$id" '.id = (if .id == "SAME" then $id else .id end)' <<< "$FAKE_RESULT" > "$file" ;;
  *) echo "az: comando inesperado" >&2; exit 2 ;;
esac
STUB

cat > "$bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
exit 1
STUB

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

# La CLI del migrador no corre en el runner: si algo la llama, queda anotado.
cat > "$tmp/dl/9.9.9/db-migrator-linux-amd64" <<'STUB'
#!/usr/bin/env bash
echo "cli $*" >> "$FAKE_LOG"
exit 3
STUB
chmod +x "$bin"/* "$tmp/dl/9.9.9/db-migrator-linux-amd64"
(cd "$tmp/dl/9.9.9" && shasum -a 256 db-migrator-linux-amd64 > db-migrator-linux-amd64.sha256)
cli_sha=$(awk '{print $1}' "$tmp/dl/9.9.9/db-migrator-linux-amd64.sha256")

applied1='[{"version": "0001", "name": "init", "kind": "expand", "checksum": "abc", "appliedAt": "2026-11-01T00:00:00Z", "appliedBy": "ci"}]'
applied2='[{"version": "0001", "name": "init", "kind": "expand", "checksum": "abc", "appliedAt": "2026-11-01T00:00:00Z", "appliedBy": "ci"}, {"version": "0002", "name": "drop", "kind": "contract", "checksum": "def", "appliedAt": "2026-11-15T00:00:00Z", "appliedBy": "ci"}]'
ok_result=$(jq -cn --argjson a1 "$applied1" --argjson a2 "$applied2" '{id: "SAME", database: "ledger-db", mode: "apply", ok: true, error: null, steps: {
  bootstrap: {ok: true},
  before: {ok: true, applied: $a1, pending: ["0002"]},
  apply: {ok: true, applied: [$a2[1]], pending: []},
  after: {ok: true, applied: $a2, pending: []}}}')
apply_failed=$(jq -c '.ok = false | .steps.apply = {ok: false, applied: [], pending: ["0002"], error: {code: "APPLY_FAILED", version: "0002", message: "syntax error"}} | .steps.after = .steps.before' <<< "$ok_result")
bootstrap_failed=$(jq -cn '{id: "SAME", database: "ledger-db", mode: "apply", ok: false, error: null, steps: {bootstrap: {ok: false, error: {code: "CONNECT_FAILED", message: "sin conexión"}}}}')
job_failed=$(jq -cn '{id: "SAME", database: "ledger-db", ok: false, steps: {}, error: "el secreto admin no tiene la forma esperada"}')
other_id=$(jq -c '.id = "otra-peticion"' <<< "$ok_result")
drift_in_sync=$(jq -cn --argjson a1 "$applied1" '{id: "SAME", database: "ledger-db", mode: "drift", ok: true, error: null, steps: {before: {ok: true, applied: $a1, pending: []}}}')
drift_mismatch=$(jq -cn --argjson a1 "$applied1" '{id: "SAME", database: "ledger-db", mode: "drift", ok: true, error: null, steps: {
  before: {ok: false, applied: [], pending: [], error: {code: "CHECKSUM_MISMATCH", message: "0001 cambió"}}, after: {ok: true, applied: $a1, pending: []}}}')

# run <resultado del job> [VAR=valor…]: corre migrate.sh; deja stdout+stderr en
# $tmp/log, las salidas en $tmp/out, las llamadas en $tmp/calls, el reporte en
# $tmp/report.json y lo subido en $tmp/store.
run() {
  local result="$1"; shift
  : > "$tmp/out"; : > "$tmp/calls"; : > "$tmp/summary"; rm -rf "$tmp/report.json" "$tmp/store"; mkdir -p "$tmp/store"
  (
    cd "$tmp/repo" || exit 99
    env -i PATH="$bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$tmp" \
      MODE=apply MANIFEST=deploy.yml NF_ENVIRONMENT=staging \
      NF_API_URL=https://nanoflow.invalid NF_AUDIENCE=nanoflow-test \
      MIGRATOR_VERSION=9.9.9 MIGRATOR_BASE_URL="file://$tmp/dl" RUNNER_TEMP="$tmp/rt" \
      ACTIONS_ID_TOKEN_REQUEST_URL="https://token.invalid/?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
      GITHUB_SHA=deadbeef GITHUB_RUN_ID=77 GITHUB_RUN_ATTEMPT=2 GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/summary" \
      NF_DB_LEDGER_DB_MIGRATOR="$queue_url" NF_DEPLOY_MIGRATIONS_LEDGER_DB_CONTAINER="$container_url" \
      QUEUE_WAIT_SECONDS=2 QUEUE_POLL_SECONDS=1 \
      FAKE_DATABASES='[{"name": "ledger-db", "migrations": "db/migrations"}]' \
      FAKE_LOG="$tmp/calls" FAKE_REPORT="$tmp/report.json" FAKE_STORE="$tmp/store" FAKE_ACCOUNT="$account" \
      FAKE_RESULT="$result" FAKE_DENY_UPLOAD= \
      "$@" bash "$here/migrate.sh"
  ) > "$tmp/log" 2>&1
}
check() {
  if [ "$2" -eq 0 ]; then echo "ok   - $1"; else echo "FAIL - $1"; sed 's/^/       /' "$tmp/log" "$tmp/out" "$tmp/calls"; fails=$((fails + 1)); fi
}
has() { grep -qx "$1" "$tmp/out"; }
rep() { [ -f "$tmp/report.json" ] && jq -e "$1" "$tmp/report.json" >/dev/null; }
req_id() { sed -n 1p "$tmp/store/queue" 2>/dev/null; }
no_cloud_db() { ! grep -q '^cli ' "$tmp/calls" && ! grep -q '^aws ' "$tmp/calls" && ! grep -q 'keyvault' "$tmp/calls"; }

run "$ok_result"; rc=$?
id=$(req_id)
{ [ $rc -eq 0 ] && has "status=succeeded" && has "error=" &&
  rep '.database == "ledger-db" and .status == "succeeded" and .applied == ["0002"] and .error == null and .migratorVersion == "9.9.9" and (.state | length) == 2 and .snapshotId == null'; }
check "apply: el job migra, el paso pasa e informa a NanoFlow lo aplicado y el estado" $?
{ [[ "$id" =~ ^77-2-ledger-db-apply-[0-9a-f]{8}$ ]] && [ "$(wc -l < "$tmp/store/queue" | tr -d ' ')" -eq 1 ] &&
  jq -e '. == {mode: "apply", sha: "deadbeef"}' "$tmp/store/migrations/requests/$id/request.json" >/dev/null; }
check "una petición en la cola con un id válido para el job y el request.json {mode, sha}" $?
{ [ "$(shasum -a 256 "$tmp/store/migrations/requests/$id/db-migrator" | awk '{print $1}')" = "$cli_sha" ] &&
  [ "$(tar -tzf "$tmp/store/migrations/requests/$id/migrations.tar.gz" | LC_ALL=C sort | paste -sd, -)" = "0001_init.sql,0002_drop.sql" ]; }
check "sube la CLI verificada y solo los .sql, en la raíz del tar.gz" $?
{ grep -q "^az storage message put --queue-name migrate --content ${id} --account-name ${account} --auth-mode login" "$tmp/calls" &&
  [ "$(grep -c '^az storage blob upload --container-name migrations ' "$tmp/calls")" -eq 3 ] &&
  ! grep -v -- '--auth-mode login' "$tmp/calls" | grep -q '^az ' && no_cloud_db; }
check "todo con la sesión de Entra ID (--auth-mode login); ni la base, ni Key Vault, ni AWS desde el runner" $?
{ grep -q '::warning::ledger-db: hay migraciones 0002(contract) en staging y el migrador de Azure no crea snapshot' "$tmp/log" && ! grep -q 'SNAPSHOT_FAILED' "$tmp/log"; }
check "contract fuera de development: avisa (restauración a un punto en el tiempo), sin snapshot" $?
{ grep -q '| ledger-db | ✓ 1 aplicadas | 0002 |' "$tmp/summary"; }
check "el resumen del job es el mismo que en AWS" $?

run "$ok_result" NF_DEPLOY_MIGRATIONS_LEDGER_DB_CONTAINER=; rc=$?
{ [ $rc -eq 0 ] && has "status=succeeded" && [ "$(grep -c '^az storage blob upload --container-name migrations ' "$tmp/calls")" -eq 3 ]; }
check "sin NF_DEPLOY_MIGRATIONS_<N>_CONTAINER usa el contenedor migrations de la cuenta de la cola" $?

run "$ok_result" NF_DEPLOY_MIGRATIONS_LEDGER_DB_CONTAINER="https://otracuenta123.blob.core.windows.net/migrations"; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: MIGRATOR_NOT_FOUND" && grep -q 'no es un contenedor de la cuenta de la cola' "$tmp/log" && [ ! -s "$tmp/calls" ]; }
check "se rechaza un contenedor de otra cuenta, sin subir nada" $?

run "$apply_failed"; rc=$?
{ [ $rc -eq 1 ] && has "status=failed" && has "error=ledger-db: APPLY_FAILED" &&
  rep '.status == "failed" and .error.code == "APPLY_FAILED" and (.state | length) == 1'; }
check "una migración fallida en el job falla el paso y se informa con el estado" $?

run "$bootstrap_failed"; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: CONNECT_FAILED" && rep '.status == "failed" and .error.code == "CONNECT_FAILED" and .state == null'; }
check "bootstrap fallido en el job: se informa y falla" $?

run "$job_failed"; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: MIGRATOR_JOB_FAILED" && rep '.error.code == "MIGRATOR_JOB_FAILED" and (.error.message | test("forma esperada"))'; }
check "el job no pudo correr (error sin pasos): MIGRATOR_JOB_FAILED con su motivo" $?

run "$other_id"; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: MIGRATOR_RESULT_FAILED"; }
check "un resultado de otra petición no se acepta" $?

run ""; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: MIGRATOR_TIMEOUT" && rep '.status == "failed" and .error.code == "MIGRATOR_TIMEOUT"'; }
check "sin resultado en el plazo: MIGRATOR_TIMEOUT, informado" $?

run "$ok_result" FAKE_DENY_UPLOAD=1; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: MIGRATOR_UPLOAD_FAILED" && grep -q 'templates ≥ 0.27.0' "$tmp/log" && [ ! -s "$tmp/store/queue" ]; }
check "sin permiso sobre el contenedor: MIGRATOR_UPLOAD_FAILED y nada en la cola" $?

run "$drift_in_sync" MODE=drift; rc=$?
id=$(req_id)
{ [ $rc -eq 0 ] && has "status=succeeded" && rep '.kind == "drift" and .drift == "in_sync" and (.state | length) == 1' &&
  jq -e '.mode == "drift"' "$tmp/store/migrations/requests/$id/request.json" >/dev/null && no_cloud_db; }
check "drift en sincronía: request mode=drift e informe kind=drift" $?

run "$drift_mismatch" MODE=drift; rc=$?
{ [ $rc -eq 1 ] && has "error=ledger-db: SCHEMA_DRIFT" && rep '.drift == "mismatch" and .error.code == "CHECKSUM_MISMATCH" and (.state | length) == 1'; }
check "drift: la base no coincide, informa mismatch con el estado aplicado y falla" $?

run "$ok_result" NF_DB_LEDGER_DB_MIGRATOR="https://${account}.queue.core.windows.net/otra"; rc=$?
{ [ $rc -eq 1 ] && ! grep -q '^az storage' "$tmp/calls"; }
check "una URL de cola que no es la del migrador no entra en el modo cola" $?

echo
if [ "$fails" -eq 0 ]; then echo "todas las pruebas pasaron"; else echo "${fails} pruebas fallaron"; exit 1; fi
