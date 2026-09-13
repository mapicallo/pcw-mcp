# Adoptar una sesión de IA existente

[English](adopting-existing-session.md)

PCW puede incorporarse cuando un proyecto o una conversación con IA ya ha acumulado estado temporal útil. La primera adopción debe revisarse antes de escribirla.

Nombra el workstream por el trabajo duradero que representa, como `BACKEND` u `OBSERVABILITY`, no por el chat, cliente o sesión desde el que se crea.
Configura ese nombre y su continuidad en `pcw.yml` antes de iniciar la adopción.

## Fase 1: proponer sin escribir

Pide al agente que:

1. lea la continuidad actual con `get_continuity` y obtenga su SHA;
2. use la conversación actual como evidencia;
3. consulte, si existen, las notas de continuidad manuales;
4. prepare un checkpoint Markdown completo que sustituya al actual;
5. elimine el ruido conversacional y la mecánica temporal del checkpoint;
6. no invoque todavía `update_continuity`.

Revisa la propuesta. Debe describir el estado duradero del workstream que seguirá siendo cierto después de escribir el checkpoint. No debe incluir afirmaciones como "la adopción está en curso", "falta aprobación" o "el siguiente paso es guardar este checkpoint".

## Fase 2: aprobar y escribir

Después de la revisión humana:

1. vuelve a leer la continuidad con `get_continuity` para obtener el SHA más reciente;
2. reconcilia la propuesta si otro escritor la ha modificado;
3. llama a `update_continuity` con el documento completo aprobado y `expectedSha256`;
4. vuelve a leer el resultado y verifica el contenido persistido y el nuevo SHA.

`update_continuity` sustituye el documento canónico de continuidad COMPLETO; no aplica un parche ni fusiona cambios automáticamente. Si devuelve `PCW_CONTINUITY_STALE`, relee, reconcilia y solicita una nueva revisión antes de reintentar.

## Migrar continuidad manual

Un archivo manual existente puede conservarse temporalmente como copia de seguridad y utilizarse como evidencia para el primer checkpoint de PCW. Cuando PCW haya demostrado ser estable, deja de actualizar ambos sistemas en paralelo: dos fuentes canónicas de continuidad pueden divergir. No elimines inmediatamente las notas históricas.

La continuidad de PCW debe contener estado duradero, no la transcripción del chat ni la mecánica utilizada para migrar, aprobar o crear el checkpoint. Distingue también los datos gestionados por PCW de las referencias locales: una ruta a un repositorio o documento puede servir como pista, pero no se vuelve portátil ni pasa a estar gestionada por PCW solo por mencionarla.

## Lo que se ha validado

En un escenario generalizado de beta privada, una conversación larga de IDE adoptó PCW, escribió un checkpoint revisado y una conversación de escritorio completamente nueva reconstruyó por sí sola el objetivo, el trabajo completado, las decisiones, las acciones descartadas, el bloqueo y la siguiente acción a partir de la continuidad. No necesitó la conversación anterior, inspeccionar el repositorio, contexto especializado, contexto compartido ni un inventario poblado.

Algunos clientes MCP pueden mostrar un servidor PCW recién registrado en una sesión existente. Si PCW no aparece, reconecta o reinicia el cliente. Este comportamiento depende del cliente y de su versión.
