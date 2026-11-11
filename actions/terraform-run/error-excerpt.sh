#!/usr/bin/env bash
# error-excerpt.sh <log> — el motivo de un comando de Terraform que falló, en
# pocas líneas, para que NanoFlow lo muestre sin abrir el log de GitHub.
#
# Toma los bloques `Error: …` de la salida (hasta 3 distintos, cada uno con el
# recurso de su línea `with …` y, si es un local-exec, con lo que escribió el
# comando) y cuenta los demás. Si no hay ninguno, las
# últimas líneas con texto. Nunca más de 900 caracteres.
#
# La salida de Terraform no trae secretos, pero un proveedor puede citar lo que
# recibió: se tachan el client secret de Auth0 y las contraseñas de Supabase
# que el job tenga en el entorno.
set -uo pipefail

log="${1:?uso: error-excerpt.sh <log>}"
[ -r "$log" ] || exit 0

text=$(awk '
  function flush() {
    if (msg == "") return
    total++
    if (!(msg in seen) && shown < 3) {
      seen[msg] = 1
      shown++
      line = msg
      if (length(line) > 400) line = substr(line, 1, 400) "…"
      if (with != "") line = line " (" with ")"
      if (output != "") line = line "\n  " output
      out = out (out == "" ? "" : "\n") line
    }
    msg = ""; with = ""; output = ""
  }
  {
    gsub(/\033\[[0-9;]*m/, "")
    sub(/^(│|╷|╵) ?/, "")
  }
  /^Error: / { flush(); msg = $0; next }
  msg != "" && with == "" && /^ +with / {
    with = $0
    sub(/^ +with /, "", with)
    sub(/,$/, "", with)
  }
  # Un local-exec que falla: lo que el comando escribió va después de
  # «exit status N. Output:» (el motivo real; «local-exec provisioner error» no dice nada).
  msg != "" && output == "" && match($0, /exit status [0-9]+\. Output: /) {
    output = substr($0, RSTART + RLENGTH)
    if (length(output) > 300) output = substr(output, 1, 300) "…"
  }
  END {
    flush()
    if (total > shown) out = out "\n(y " (total - shown) " error(es) más en el log)"
    print out
  }
' "$log")

if [ -z "$text" ]; then
  text=$(grep -v '^[[:space:]]*$' "$log" | tail -n 3)
fi

redact() {
  local secret="$1"
  [ "${#secret}" -ge 6 ] && text="${text//"$secret"/***}"
  return 0
}
redact "${AUTH0_CLIENT_SECRET:-}"
if [ -n "${TF_VAR_supabase_passwords:-}" ] && command -v jq >/dev/null 2>&1; then
  while IFS= read -r pw; do
    redact "$pw"
  done < <(jq -r 'if type == "object" then .[] | strings else empty end' <<< "$TF_VAR_supabase_passwords" 2>/dev/null)
fi

printf '%s' "${text:0:900}"
