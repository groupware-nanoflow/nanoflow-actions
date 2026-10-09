# nanoflow-actions

Workflows y acciones reutilizables que NanoFlow pone en los repositorios de sus
clientes para desplegar en AWS.

**Este repositorio es público a propósito.** GitHub solo permite invocar un
workflow reutilizable si quien lo invoca puede verlo, y los repos de los
clientes están en otras organizaciones. Aquí no hay secretos: solo pasos.

## Qué resuelve

Un repositorio de un proyecto de NanoFlow tiene ramas por ambiente, y cada
ambiente es una cuenta AWS independiente dentro de la organización del cliente:

| Rama | Ambiente | Cuenta AWS |
|---|---|---|
| `develop` | development | la del ambiente de desarrollo |
| `stage` | staging | la de staging |
| `main` | production | la de producción |

El pipeline **no elige** a cuál va. Presenta el token OIDC que GitHub firma para
ese job, y NanoFlow deriva el ambiente de la rama que viene dentro del token.
Una rama de PR, un fork o un workflow editado no pueden pedir producción, porque
no la piden.

No hay ninguna credencial de AWS guardada en el repositorio del cliente.

## Uso

En `.github/workflows/deploy.yml` del repositorio (NanoFlow lo escribe al
registrar el repo; ver `examples/deploy.yml`):

```yaml
jobs:
  deploy:
    permissions:
      contents: read
      id-token: write
    uses: groupware-nanoflow/nanoflow-actions/.github/workflows/deploy-aws.yml@v1
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
```

`permissions` no es decorativo. `id-token: write` es lo que deja al job pedir
su token OIDC, y con ese token NanoFlow entrega las credenciales, recibe el log
en vivo y registra el despliegue. Un workflow reutilizable solo puede usar los
permisos que le concede el job que lo llama: si el llamador no los da, GitHub
rechaza el run antes de empezar.

Y en `.nanoflow/deploy.yml`, cómo se construye y se despliega este proyecto
(ver `examples/nanoflow-deploy.yml`):

```yaml
version: 1
toolchain: { node: "22" }
build: pnpm install --frozen-lockfile && pnpm build
deploy: |
  terraform init -input=false
  terraform apply -auto-approve
```

NanoFlow aporta la identidad y la trazabilidad. Cómo se despliega lo decide el
proyecto: el agente genera aplicaciones reales, no tres plantillas fijas, así
que el manifiesto declara comandos en vez de elegir de un catálogo.

Dos claves opcionales más, en la raíz o por ambiente:

| Clave | Para qué |
|---|---|
| `url` | URL pública de lo desplegado; NanoFlow la guarda cuando el despliegue sale bien |
| `mask-env` | variables de entorno cuyos valores se tapan en el log en vivo (lista o texto separado por comas) |

## Qué ve NanoFlow del despliegue

El workflow reutilizable informa a NanoFlow mientras corre, con el mismo token
OIDC de las credenciales:

1. Tras obtener las credenciales, `POST /v1/ci/deployments` con
   `in_progress`.
2. La salida de `build` y `deploy` pasa por `actions/log-stream`, que la sigue
   imprimiendo en GitHub y la reenvía por lotes (≈1 s) a `POST /v1/ci/logs`.
   Así la consola muestra el log mientras corre: GitHub no lo expone por API
   hasta que el job termina.
3. Al final, pase lo que pase (`if: always()`), el resultado: `success`,
   `failure` (con el paso y el código de salida, p. ej. `deploy: exit 1`) o
   `cancelled`, y la `url` del manifiesto si salió bien.

Ninguno de los dos puede fallar el despliegue. Si NanoFlow no responde, el log
en vivo se descarta con un único `::warning::` al final del paso y el reporte
deja otro aviso; el log completo sigue en GitHub y NanoFlow lo archiva al
terminar el job. Para no reenviar la salida, `live-logs: false`.

El ambiente tampoco aquí lo manda el workflow: NanoFlow lo deriva de la rama
firmada en el token, igual que las credenciales.

## Solo las credenciales

Si un repositorio ya tiene su propio pipeline y solo necesita entrar a su cuenta
AWS, la acción suelta basta:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: groupware-nanoflow/nanoflow-actions/actions/aws-credentials@v1
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
  - run: aws s3 ls
```

Exporta `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` y
`AWS_REGION`, y devuelve `account-id`, `environment` y `region` como salidas.
Antes de terminar comprueba con `sts get-caller-identity` que las credenciales
son de la cuenta que NanoFlow dijo: una cuenta distinta se detecta ahí y no a
mitad de un `apply`.

`permissions: id-token: write` es obligatorio. Sin él el job no puede pedir su
token y la acción falla diciéndolo.

## El log en vivo en un pipeline propio

`actions/log-stream` sirve también fuera del workflow reutilizable. Deja la
ruta del filtro en `NF_LOG_STREAM`, y cada paso pasa su salida por él:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: groupware-nanoflow/nanoflow-actions/actions/log-stream@v1
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
      check-run-id: ${{ job.check_run_id }}
      mask-env: DB_PASSWORD
  - run: |
      set -o pipefail
      npm ci 2>&1 | node "$NF_LOG_STREAM" --job "$GITHUB_JOB" --step install
```

- Con `pipefail` el paso sale con el código del comando: el filtro sale siempre
  con 0 y nunca lo bloquea.
- **Redacta antes de enviar.** `::add-mask::` solo afecta al log que guarda
  GitHub; el filtro lee la salida cruda. Tapa los valores de
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, los de las
  variables de `mask-env`, lo que el propio comando declare con
  `::add-mask::`, y patrones de credenciales (`AKIA…`/`ASIA…`,
  `ghp_`/`ghs_`/`gho_`/`github_pat_`, `Bearer …`, bloques PEM). Solo ve las
  variables del entorno del paso, no las que el comando define por dentro.
- Sin `id-token: write`, sin `api-url`/`audience` o con `enabled: false` es un
  `cat`: imprime y no envía nada.
- Necesita `node` (≥ 20) en el PATH. Los runners de GitHub lo traen; en un
  runner propio sin node, comprobarlo antes de usar la tubería.

Y el reporte del despliegue, suelto:

```yaml
  - uses: groupware-nanoflow/nanoflow-actions/actions/report-deployment@v1
    if: always()
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
      status: ${{ job.status == 'success' && 'success' || job.status == 'cancelled' && 'cancelled' || 'failure' }}
```

Un estado final no cambia: un segundo `success` es un reintento y se acepta,
pero un `failure` después de un `success` (o un `in_progress`) se rechaza con un
aviso. Solo `push`, `workflow_dispatch` y `release` desde una rama con ambiente
pueden informar un despliegue.

## Cosas que conviene saber

- **Una hora.** Las credenciales son temporales y AWS limita a una hora la
  cadena de roles que las produce, sin posibilidad de pedir más. Un despliegue
  más largo tiene que volver a pasar por la acción.
- **Los ambientes con aprobación no se despliegan solos.** Si el ambiente exige
  aprobación, NanoFlow rechaza la petición con un mensaje que lo dice, y el
  despliegue se lanza desde la consola después de aprobarlo.
- **Las credenciales se enmascaran.** Llegan por HTTP, así que GitHub no las
  conoce: la acción llama a `::add-mask::` antes de exportarlas.
- **Nunca dispares esto en `pull_request`.** NanoFlow lo rechaza de todos modos,
  pero el disparador correcto es `push` sobre las ramas de ambiente.

## Versionado

Los repos de los clientes apuntan a `@v1`, una etiqueta móvil sobre la última
versión compatible. Un cambio que rompa el contrato sale como `@v2` y los repos
se migran cuando toque, no a la fuerza.
