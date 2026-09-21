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
    uses: groupware-nanoflow/nanoflow-actions/.github/workflows/deploy-aws.yml@v1
    with:
      api-url: https://devapi-nanoflow.groupware.com.co
      audience: nanoflow-dev
```

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
