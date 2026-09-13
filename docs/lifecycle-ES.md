# Instalación y ciclo de vida

[English](lifecycle.md)

Mantener separados estos tres elementos evita borrar datos por error:

```text
software PCW != registro en el cliente MCP != contextos PCW
```

El software PCW es reemplazable. Los contextos son datos duraderos propiedad del usuario e incluyen continuidad, inventario, fuentes configuradas y `.pcw/history`. Desinstalar el paquete no debe eliminar esos contextos.

## Instalar

En un directorio local dedicado:

```powershell
npm init -y
npm install "<handoff>\package\pcw-mcp-0.2.0-beta.2.tgz" --omit=dev
```

## Desactivar o desconectar

Desactiva o elimina el registro MCP en el cliente de IA. Para Codex:

```powershell
codex mcp remove pcw
```

Esto no desinstala PCW ni elimina ningún contexto.

## Desinstalar el software

Secuencia recomendada en Windows:

1. elimina o desconecta el registro MCP;
2. cierra Codex, IntelliJ y cualquier otro cliente que esté usando PCW;
3. ejecuta `npm uninstall pcw-mcp` desde el directorio de instalación.

Windows puede mostrar avisos de limpieza `EPERM` si Codex, IntelliJ, Node u otro cliente mantiene abiertos archivos de dependencias nativas. Nunca elimines directorios de contexto como parte de la desinstalación del paquete. `.pcw/history` pertenece al contexto, no al software instalado.

## Reinstalar

Instala de nuevo el paquete, vuelve a registrar el servidor MCP y apúntalo al mismo contexto. Los workstreams persistentes vuelven a estar disponibles desde los archivos existentes.

## Actualizar

No existe un sistema de actualización automática. Obtén el paquete privado más reciente que haya sido aprobado, detén los clientes conectados, instala ese paquete en el directorio del software, verifica `--version` y vuelve a conectar el registro MCP o actualiza la ruta del servidor si es necesario. Protege los contextos importantes según la política normal del proyecto; sustituir el paquete no debe modificarlos.

## Cambios de raíz de contexto

Los cambios de `pcw.yml` dentro de la MISMA raíz se releen dinámicamente. Cambiar `PCW_CONTEXT_ROOT` modifica la configuración del proceso: un proceso MCP que ya está en ejecución puede seguir mostrando la raíz anterior hasta que el cliente se reconecte, se reinicie o vuelva a abrir o restaurar el chat.

## Varios chats y proyectos

Varios chats pueden leer el mismo workstream. Las escrituras utilizan concurrencia optimista: si otro cliente actualiza primero, el SHA anterior queda obsoleto y PCW rechaza la escritura en lugar de sobrescribir el estado nuevo.

Un registro MCP de PCW representa un `contextRoot`, que puede contener varios workstreams. La solución actual para proyectos separados es crear varios registros con nombres distintos, por ejemplo `pcw-platform` y `pcw-analytics`, cada uno con su propia raíz. Todavía no existe un selector multiproyecto integrado.
