# Primeros pasos: beta privada de PCW-MCP

[English: START-HERE.md](START-HERE.md)

PCW conserva el conocimiento del proyecto y la continuidad de los workstreams fuera de sesiones temporales de IA. Este kit contiene un servidor MCP local, plantillas y un contexto de ejemplo ficticio.

## Requisitos

- Node.js 22.9.0 o posterior y npm;
- una copia autorizada de este kit privado;
- un directorio local para el contexto PCW;
- un cliente MCP por stdio, como Codex o Cursor.

Lee `PRIVATE-BETA-TERMS-ES.md` antes de usarlo. No redistribuyas ni publiques el kit sin autorización escrita.

## Instalación

Desde un directorio situado fuera del kit:

```powershell
mkdir pcw-test
cd pcw-test
npm init -y
npm install "<ruta-al-kit>\package\pcw-mcp-0.2.0-beta.2.tgz" --omit=dev
```

```powershell
node node_modules\pcw-mcp\dist\server.js --version
node node_modules\pcw-mcp\dist\server.js --help
```

Copia `sample-context` a un directorio de tu propiedad antes de probar escrituras. No uses como estado duradero la copia incluida en el ZIP.

## Registro en Codex

Comprueba la CLI y los registros actuales:

```powershell
codex --version
codex mcp list
```

Registra PCW sustituyendo los ejemplos por rutas absolutas:

```powershell
codex mcp add pcw --env PCW_CONTEXT_ROOT="C:\Contexts\sample-context" -- node "C:\Tools\pcw-test\node_modules\pcw-mcp\dist\server.js"
codex mcp list
codex mcp get pcw
```

`codex mcp get pcw` puede ocultar los valores de variables de entorno por seguridad. Para desconectar PCW:

```powershell
codex mcp remove pcw
```

Este flujo de CLI se validó en el entorno de la beta y puede cambiar en versiones futuras de Codex. La integración de Codex probada dentro de IntelliJ y Codex Desktop utilizaron el mismo registro global. Algunos clientes pueden mostrar un servidor recién registrado en una sesión existente; si no aparece, reconecta o reinicia el cliente.

## Configuración de Cursor

La instalación del paquete es la misma; solo cambia el registro en el cliente:

```json
{
  "mcpServers": {
    "pcw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Tools\\pcw-test\\node_modules\\pcw-mcp\\dist\\server.js"],
      "env": { "PCW_CONTEXT_ROOT": "C:\\Contexts\\sample-context" }
    }
  }
}
```

## Crea tu primer contexto

Para un contexto mínimo útil, copia `templates/pcw-minimal.yml` como `pcw.yml`, `templates/inventory.md` como `inventory.md` y `templates/continuity.md` como `continuity/WORKSTREAM.md`. Sustituye los marcadores y mantén todas las rutas configuradas dentro de la raíz.

```text
my-context/
  pcw.yml
  inventory.md
  continuity/
    WORKSTREAM.md
```

El contexto especializado del workstream y el contexto compartido son opcionales. Un workstream puede tener continuidad sin ninguno de ellos. Nombra los workstreams por trabajo duradero, como `BACKEND` u `OBSERVABILITY`, nunca por un chat o una sesión.

Consulta `docs/pcw-yml.md` para ver el esquema exacto y `templates/pcw.yml` para un ejemplo más completo.

## Primeras peticiones

```text
Usa PCW para enumerar los workstreams disponibles y resumir la estructura del proyecto. No modifiques nada.
```

```text
Usa PCW para continuar el workstream BACKEND. Esta es una sesión completamente nueva. Reconstruye el estado persistente antes de modificar nada. No actualices todavía la continuidad.
```

En un hito relevante:

```text
Actualiza en PCW el checkpoint de BACKEND. Vuelve a leer primero la continuidad y su SHA. Conserva solo el estado duradero que necesitará una sesión completamente nueva.
```

`update_continuity` sustituye el checkpoint Markdown completo, crea historial en `.pcw/history` y rechaza los SHA obsoletos. No guardes transcripciones ni la mecánica temporal de creación del checkpoint.

## Guías siguientes

- `docs/daily-use-ES.md`: sesiones normales, checkpoints, chats rotos y escrituras obsoletas;
- `docs/adopting-existing-session.md`: migración segura de una conversación existente;
- `docs/lifecycle.md`: desactivación, desinstalación, reinstalación, actualización y varios proyectos;
- `docs/runtime.md`: detalles de la raíz de contexto y configuración de clientes.

## Seguridad

PCW limita el acceso a los límites configurados del contexto, pero no es un sandbox del sistema operativo. Un cliente de IA conectado a la nube puede transmitir contenido a su proveedor. Configura únicamente datos que estés autorizado a compartir con ese sistema de IA.

Los cambios en `pcw.yml` dentro de una misma raíz son visibles dinámicamente. Cambiar `PCW_CONTEXT_ROOT` puede requerir reconectar o reiniciar el cliente, porque un proceso MCP existente conserva la raíz con la que se inició.
