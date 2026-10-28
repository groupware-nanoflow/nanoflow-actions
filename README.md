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
| `env-map` | `DESTINO: NF_ORIGEN`: copia una variable del contrato de plataforma con otro nombre para el build (p. ej. `VITE_API_URL: NF_API_URL`). Lo del ambiente gana sobre la raíz. |

### Contrato de plataforma (`environment`)

Con el input `environment` (el GitHub Environment del ambiente de la rama:
`development`, `staging` o `production`), el job corre dentro de ese
environment. Ahí NanoFlow escribe las variables `NF_*` del contrato de
plataforma: `NF_API_URL`, `NF_FRONTEND_URL`, `NF_IDENTITY_PROVIDER`,
`NF_OIDC_ISSUER`, `NF_OIDC_AUDIENCE`, `NF_OIDC_CLIENT_ID`, `NF_TENANT_CLAIM`,
`NF_ENVIRONMENT`… (salen de los outputs del apply del repo core-infra; doc 11
§11 de la consola). El paso «Contrato de plataforma» las exporta a build y
deploy y aplica `env-map`. NanoFlow comprueba que el environment declarado sea
el de la rama; si no, falla. El `deploy.yml` que genera NanoFlow ya lo pasa:

```yaml
    with:
      environment: ${{ github.ref_name == 'develop' && 'development' || github.ref_name == 'main' && 'production' || '' }}
```

### Bases Postgres (`databases`)

Si el repositorio es dueño de una base Postgres de la arquitectura
(`data[].owner`), el manifiesto la declara y `deploy-aws` la migra **después
del build y antes del deploy** (doc 11 §14 de la consola):

```yaml
databases:
  - name: app-db              # data[].name de la arquitectura
    migrations: db/migrations # NNNN_<slug>.sql, por defecto db/migrations
```

El paso «Migraciones» (acción `db-migrate`) hace lo siguiente por cada base:
1. Encuentra su migrador en `NF_DB_<NOMBRE>_MIGRATOR`. Es una variable del contrato de
   plataforma que NanoFlow escribe solo en el repo dueño.
2. Instala la versión fijada de `nanoflow-db-migrator`, desde el bucket público de NanoFlow y
   verificada por sha256:
   - **RDS/Aurora**: la variable es el nombre de la Lambda migradora de la VPC, y el código va a
     esa Lambda.
   - **Supabase** (doc 11 §19): la variable es el ARN del secreto `admin` de la base. La CLI corre
     en el runner con la conexión del session pooler y la contraseña de `app_rw`, que lee de los
     secretos `admin` y `app` de la cuenta del ambiente. Ambas se enmascaran.
3. Corre `bootstrap` y luego `status` para conocer las pendientes.
4. En staging y production, si alguna pendiente es `contract` o `destructive`, crea un **snapshot**
   de la base y espera a que esté disponible. En Supabase no hay snapshot desde el pipeline: deja
   un aviso para verificar los backups/PITR del proyecto.
5. Corre `apply` con el commit del push. Antes de ejecutar nada, el migrador (1.2.0+) rechaza los
   nombres inválidos y los objetos fuera del schema `app` (`INVALID_NAME`, `SCHEMA_NOT_APP`: las
   migraciones corren como `app_owner`, dueño solo de `app`) y deja un `::warning::` por cada
   migración sin cabecera `-- nanoflow:kind` (se aplica como `unknown`).
6. Informa a NanoFlow (`POST /v1/ci/migrations`): el resultado y el estado completo del esquema.

Si una migración falla, no hay deploy y el despliegue queda con el error `migrate: <base>:
<código>`. Todo lo que llega es `expand` o `migrate`, así que el código anterior sigue
funcionando con el esquema que quedó. El reporte nunca hace fallar el paso. Sin `databases`, el
paso no hace nada.

**En los PRs**, el workflow reutilizable `db-check.yml` revisa las migraciones sin tocar ninguna
base real. Lo hace contra un Postgres 16 del propio job y sin credenciales de AWS ni de NanoFlow:
- `db-migrator lint`:
  - nombres y numeración;
  - todo objeto en el schema `app` y calificado (`SCHEMA_NOT_APP`);
  - las migraciones de la rama base no se editan, borran ni renombran;
  - `-- nanoflow:kind` obligatorio y no menor que lo que hace el SQL.
- **squawk** 2.66.0 sobre las migraciones nuevas. Las reglas de drop y rename solo se permiten en
  un `contract` o `destructive` declarado.
- **apply desde cero.**
- **Aislamiento por tenant** (RLS forzado, `tenant_id NOT NULL`, policies), si la arquitectura
  dice `multiTenancy: pool`.

```yaml
on:
  pull_request:   # sin filtro de paths: el gate de la promoción exige el check
jobs:
  db-check:
    permissions:
      contents: read
      id-token: write
    uses: groupware-nanoflow/nanoflow-actions/.github/workflows/db-check.yml@v1
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
```

Con `api-url`, en un `pull_request`, `db-check` informa a NanoFlow el resultado de cada base
(`kind: check`): las migraciones nuevas frente a la rama base, con su kind. Es el **dry-run de la
promoción**: el PR de promoción apunta a la rama del ambiente destino, y NanoFlow no mergea la
promoción sin un check verde de ese head. Además exige la confirmación de las `destructive` y, en
producción, la casilla del aprobador para las `contract`/`destructive` (doc 11 §16).

**Drift de esquema.** El workflow reutilizable `db-drift.yml` no migra nada:
- Solo lectura: por cada base invoca `status` en su migrador con los archivos de la rama.
- Informa `in_sync`, `pending` (archivos sin aplicar) o `mismatch` (una versión aplicada cambió o no
  está en el repo; falla el job).
- Lo despacha el mantenimiento diario de NanoFlow.

El repo dueño no escribe estos workflows: el espejo de la arquitectura genera
`.github/workflows/nanoflow-db.yml`, que llama a `db-check.yml` en cada PR y a `db-drift.yml` en un
`workflow_dispatch` con `environment`.

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

Ninguno de los dos puede fallar el despliegue. Si NanoFlow deja de responder
(tres lotes seguidos sin llegar, o un rechazo 401/403/404), el log en vivo hace
una pausa —30 s, o 60 s ante un rechazo—, lo avisa en ese momento con un
`::warning::` y vuelve a intentar; las líneas esperan en cola (hasta 20 000) y,
cuando la API vuelve, se envían y un `::notice::` lo dice. Lo que no llegue antes
de que termine el paso se descarta con un `::warning::` final, y el reporte deja
otro aviso; el log completo sigue en GitHub y NanoFlow lo archiva al terminar el
job. Para no reenviar la salida, `live-logs: false`.

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

## Repos de infraestructura (Terraform)

El repo `<proyecto>-core-infra` que genera NanoFlow no usa el bróker de
credenciales: cada cuenta de ambiente confía directamente en el OIDC de GitHub
(stack de bootstrap de `nanoflow-infra-templates`), con dos roles:

| Workflow | Disparador | Rol | Qué hace |
|---|---|---|---|
| `terraform-plan.yml` | `pull_request` hacia la rama de un ambiente | `plan` (solo lectura + estado) | fmt, init, validate, tflint, trivy (HIGH/CRITICAL), plan; reporte a NanoFlow (`report-plan` → `POST /v1/ci/plans`) y comentario en el PR, uno por ambiente, que se actualiza en cada push. |
| `terraform-apply.yml` | `push` a la rama de un ambiente | `apply`, **solo** dentro del GitHub Environment del ambiente | plan guardado y `apply` de ese plan; despliegue informado con `report-deployment`; si el apply sale bien, el output `nanoflow_contract` va a NanoFlow con `report-outputs` (`POST /v1/ci/infra-outputs`), que lo escribe como variables `NF_*` en los repos de aplicación. |
| `terraform-drift.yml` | `workflow_dispatch` del `drift.yml` del repo, que despacha NanoFlow (nunca `schedule`) en la rama del ambiente | `plan`, dentro del GitHub Environment del ambiente | init y `plan -detailed-exitcode`; reporte a NanoFlow (`report-plan` con `has-changes`). Encontrar drift no falla el job; un plan que falla, sí. Sin fmt, tflint, trivy ni comentario. |

El ambiente de cada rama, su directorio, su cuenta y sus roles están en
`.nanoflow/infra.json`, que también genera NanoFlow (acción `infra-env`). El
repo solo llama a los workflows:

```yaml
jobs:
  plan:
    uses: groupware-nanoflow/nanoflow-actions/.github/workflows/terraform-plan.yml@v2
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
```

- Un hallazgo HIGH o CRITICAL de trivy falla el check, pero el plan y el reporte
  se generan igual. Para aceptar uno, `# trivy:ignore:<id>` junto al recurso con
  el motivo.
- trivy se descarga de su release y se verifica contra los checksums
  publicados; no se usan acciones de terceros para eso.
- **Credenciales de proveedores externos** (acción `provider-credentials`, doc 11
  §18 y §19). Las carga el usuario en NanoFlow, que las sincroniza en el repo:
  - **Auth0**, si el ambiente usa el provider `auth0/auth0`: dominio en la
    variable de repo `NF_AUTH0_DOMAIN_<AMBIENTE>`, client M2M en los secretos
    `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET` del GitHub Environment. Un PR no ve
    esos secretos: su plan corre con `-refresh=false`.
  - **Supabase**, por cada `var.supabase["<base>"]`: proyecto en la variable de
    repo `NF_SUPABASE_<AMBIENTE>_<BASE>` (`TF_VAR_supabase`) y contraseña en el
    secreto `SUPABASE_DB_PASSWORD_<BASE>` del environment (variable efímera
    `TF_VAR_supabase_passwords`, solo en apply y drift: apply y drift le pasan
    `toJSON(secrets)` y la acción toma solo esos nombres).
- `report-plan` y `report-outputs` nunca fallan el job: si NanoFlow no responde, dejan un aviso. Un repo sin el output `nanoflow_contract` (templates < 0.6.0) se salta sin aviso de error.
- `report-plan` acepta `has-changes` (`true`/`false`, el veredicto de
  `-detailed-exitcode`) y lo envía como `hasChanges`. NanoFlow solo lo usa si
  el token es de un `workflow_dispatch` de `.github/workflows/drift.yml`.
- Cada fase de Terraform (`init`, `plan`, `apply`) es un paso propio con
  `timeout-minutes`, y corre con la acción `terraform-run`: el comando escribe a
  un archivo que se sigue en vivo, en vez de `terraform … | node log-stream`.
  Con la tubería, un proceso hijo de Terraform que quedara vivo con la salida
  heredada impedía que el paso terminara aunque Terraform ya hubiera acabado.

Tests: `node --test actions/report-plan/summarize.test.js actions/log-stream/log-stream.test.js`.

## Versionado

Los repos de los clientes apuntan a `@v1`, una etiqueta móvil sobre la última
versión compatible. Un cambio que rompa el contrato sale como una etiqueta
nueva y los repos se migran cuando toque, no a la fuerza. `@v2` agrega los
workflows de Terraform y las acciones `report-plan`, `report-outputs` e
`infra-env`. `deploy-aws.yml` agregó el input opcional `environment` y la clave
`env-map` sin romper a quien no los usa, así que siguió en `@v1`; lo mismo
la clave `databases` (paso «Migraciones», acción `db-migrate`) y los workflows
`db-check.yml` y `db-drift.yml`.
