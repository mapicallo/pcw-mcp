# Uso diario

[English](daily-use.md)

PCW sirve para crear checkpoints y recuperar contexto de forma selectiva. No es necesario invocarlo en cada mensaje.

## Sesión nueva

```text
Usa PCW para continuar el workstream BACKEND. Reconstruye el estado persistente antes de modificar nada. No actualices todavía la continuidad.
```

Nombra los workstreams por la línea de trabajo duradera, por ejemplo `BACKEND`, `OBSERVABILITY`, `PAYMENTS` o `CORE`. No uses nombres de sesiones desechables como `CHAT-1`, `EXISTING-CHAT` o `SESSION-3`.

## Misma sesión

Trabaja con normalidad. Busca en el inventario y lee fuentes concretas cuando necesites contexto duradero; no cargues todas las fuentes por defecto.

## Crea un workstream

```text
Crea en PCW un nuevo workstream llamado PLATFORM-LAB con contexto especializado. Su objetivo inicial es validar el flujo ficticio de plataforma.
```

`create_workstream` usa una estructura generada segura y hace visible el resultado sin reiniciar el servidor. Omite el contexto especializado para usar el modo predeterminado de solo continuidad. Los nombres automáticos admiten entre 1 y 64 letras ASCII, dígitos, guiones o guiones bajos, y empiezan por una letra o un dígito. Edita `pcw.yml` manualmente solo cuando necesites una estructura física personalizada.

Los chats conectados al mismo contexto pueden usar inmediatamente workstreams duraderos distintos. La creación no vincula el workstream al chat que la inició.

## Checkpoint

Crea un checkpoint en hitos relevantes: tarea terminada, commit o revisión importante, decisión duradera, enfoque descartado, bloqueo, final del día, ventana de contexto larga o antes de cambiar de cliente.

```text
Actualiza en PCW el checkpoint de BACKEND. Vuelve a leer primero la continuidad y su SHA. Conserva solo el estado duradero que necesitará una sesión completamente nueva.
```

Un checkpoint debe conservar objetivo, estado técnico, trabajo completado, decisiones, enfoques descartados, bloqueos, fuentes relevantes y la siguiente acción técnica real. No guardes la mecánica de crear el checkpoint, la espera de aprobación para guardarlo, instrucciones temporales del chat ni una transcripción.

## Sesión rota o casi llena

Crea el checkpoint antes de que la sesión anterior deje de ser utilizable. Si ya se ha roto, abre una sesión nueva:

```text
Usa PCW para continuar BACKEND desde su último checkpoint persistente. Explícame el estado reconstruido antes de hacer cambios.
```

## Escritura obsoleta

Si recibes `PCW_CONTINUITY_STALE`, nunca sobrescribas a ciegas:

```text
Vuelve a leer la continuidad actual, reconcíliala con el checkpoint más reciente y propón de nuevo la continuidad completa actualizada.
```

Varios chats pueden leer el mismo workstream y chats diferentes pueden usar workstreams distintos. Las escrituras simultáneas sobre un workstream usan concurrencia optimista, no bloqueo distribuido.

## Referencias y portabilidad

La continuidad, el inventario, las fuentes y `.pcw/history` administrados por PCW viven dentro del contexto configurado. Una ruta local a un repositorio o documento anotada en la continuidad es solo una pista; márcala como local si puede no existir en otro equipo.
