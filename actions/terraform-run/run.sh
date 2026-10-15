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

# El comando escribe a un archivo, sin stdin: nada puede quedarse esperando una
# respuesta, y un hijo rezagado solo retiene el archivo.
TF_IN_AUTOMATION=1 TF_INPUT=0 bash -c "$NF_CMD" >"$log" 2>&1 </dev/null &
cmd=$!
# Fin explícito por archivo, no por `kill -0`: un proceso que ya salió pero que
# el shell aún no recogió (zombie) sigue respondiendo a `kill -0`, y el
# seguimiento nunca terminaba (paso colgado con el build ya hecho).
done_flag="$log.done"
reader_flag="$log.reader"
trap 'rm -f "$log" "$done_flag" "$reader_flag"' EXIT

# follow imprime lo nuevo del archivo cada medio segundo y termina tras una
# última lectura cuando aparece done_flag: es el único escritor de la tubería
# hacia el lector, así que el lector recibe su fin de entrada a tiempo. Si la
# salida se detiene 5 min con el comando vivo, deja una vez el árbol de
# procesos en el log del paso para ver qué sigue corriendo.
follow() {
  local offset=0 size fin quiet=0 dumped=0
  while :; do
    fin=0
    [ -e "$done_flag" ] && fin=1
    size=$(wc -c <"$log" | tr -d ' ')
    if [ "$size" -gt "$offset" ]; then
      tail -c "+$((offset + 1))" "$log" | head -c "$((size - offset))"
      offset=$size
      quiet=0
    else
      quiet=$((quiet + 1))
    fi
    [ "$fin" = 1 ] && break
    if [ "$quiet" -ge 600 ] && [ "$dumped" = 0 ]; then
      dumped=1
      { echo "::group::nf-run: 5 min sin salida; procesos en curso"; ps -eo pid,ppid,etime,args 2>/dev/null; echo "::endgroup::"; } >&2
    fi
    sleep 0.5
  done
}

# El lector, en segundo plano: log-stream si el log en vivo está preparado; si
# no, solo eco. reader_flag marca que terminó (también sin `kill -0`).
if [ "${NF_LIVE_LOGS:-false}" = "true" ] && [ -n "${NF_LOG_STREAM:-}" ] && command -v node >/dev/null 2>&1; then
  { follow | node "$NF_LOG_STREAM" --job "${GITHUB_JOB:-job}" --step "$step"; : >"$reader_flag"; } &
else
  { follow; : >"$reader_flag"; } &
fi
reader=$!

wait "$cmd"
rc=$?
: >"$done_flag"
# El lector cierra solo (log-stream se da hasta 10 s para vaciar lo pendiente);
# a los 20 s se corta, para que nada retenga el paso.
for _ in $(seq 1 40); do
  [ -e "$reader_flag" ] && break
  sleep 0.5
done
if [ ! -e "$reader_flag" ]; then
  pkill -TERM -P "$reader" 2>/dev/null
  kill -TERM "$reader" 2>/dev/null
fi
wait "$reader" 2>/dev/null
exit "$rc"
