#!/usr/bin/env bash
# run.sh — corre un comando (terraform) y muestra su salida en vivo, en el log
# de GitHub y en NanoFlow (log-stream), SIN atar el fin del paso a una tubería.
#
# Con `cmd | node log-stream`, el filtro termina cuando se cierra la tubería, y
# eso no pasa mientras cualquier proceso hijo del comando (p. ej. un provider
# de Terraform que no salió) conserve la salida heredada: el paso se queda
# colgado aunque el comando ya haya terminado. Aquí el comando escribe a un
# archivo que se sigue mientras el comando corre; cuando termina, se corta el
# seguimiento y el lector recibe su fin de entrada. Un hijo rezagado no retiene nada.
#
#   NF_CMD='terraform apply -input=false tfplan' NF_STEP=apply run.sh
set -uo pipefail

: "${NF_CMD:?NF_CMD vacío}"
step="${NF_STEP:-run}"
tmp="${RUNNER_TEMP:-/tmp}"
log="$(mktemp "$tmp/nf-$step.XXXXXX")"
trap 'rm -f "$log"' EXIT

# El comando escribe a un archivo, sin stdin: nada puede quedarse esperando una
# respuesta, y un hijo rezagado solo retiene el archivo.
TF_IN_AUTOMATION=1 TF_INPUT=0 bash -c "$NF_CMD" >"$log" 2>&1 </dev/null &
cmd=$!

# follow imprime lo nuevo del archivo cada medio segundo y termina en cuanto el
# comando sale (tras una última lectura): es el único escritor de la tubería
# hacia el lector, así que el lector recibe su fin de entrada a tiempo.
follow() {
  local offset=0 size alive
  while :; do
    alive=0
    kill -0 "$cmd" 2>/dev/null && alive=1
    size=$(wc -c <"$log" | tr -d ' ')
    if [ "$size" -gt "$offset" ]; then
      tail -c "+$((offset + 1))" "$log" | head -c "$((size - offset))"
      offset=$size
    fi
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
}

# El lector: log-stream si el log en vivo está preparado; si no, solo eco.
if [ "${NF_LIVE_LOGS:-false}" = "true" ] && [ -n "${NF_LOG_STREAM:-}" ] && command -v node >/dev/null 2>&1; then
  follow | node "$NF_LOG_STREAM" --job "${GITHUB_JOB:-job}" --step "$step"
else
  follow
fi

wait "$cmd"
