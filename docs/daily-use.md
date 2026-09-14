# Daily Use

[Espanol](daily-use-ES.md)

PCW is a checkpoint and selective-retrieval tool. It does not need to be invoked for every message.

## New Session

```text
Use PCW to continue the BACKEND workstream. Reconstruct persistent state before modifying anything. Do not update continuity yet.
```

Name workstreams after the durable line of work, such as `BACKEND`, `OBSERVABILITY`, `PAYMENTS`, or `CORE`. Do not name them after disposable sessions such as `CHAT-1`, `EXISTING-CHAT`, or `SESSION-3`.

## Same Session

Work normally. Search the inventory and read selected sources when durable context is needed; do not load every source by default.

## Create A Workstream

```text
Create a PCW workstream named PLATFORM-LAB with specialized context. Its initial objective is to validate the fictional platform workflow.
```

`create_workstream` uses a safe generated layout and makes the result visible without a server restart. Omit specialized context for the default continuity-only mode. Automatic names are 1-64 ASCII letters, digits, hyphens, or underscores, starting with a letter or digit. Use manual `pcw.yml` configuration only when a custom physical layout is required.

Different chats connected to the same context can immediately use different durable workstreams. Creation does not bind a workstream to its originating chat.

## Checkpoint

Create a checkpoint at meaningful milestones: a completed task, important commit or review, durable decision, rejected approach, blocker, end of day, long context window, or before switching clients.

```text
Update the BACKEND checkpoint in PCW. Reread continuity and its SHA first. Preserve only durable workstream state needed by a completely new session.
```

A checkpoint should retain the objective, technical state, completed work, decisions, rejected approaches, blockers, relevant sources, and next real technical action. Do not persist the mechanics of creating the checkpoint, pending approval to save it, temporary chat instructions, or a transcript.

## Broken Or Nearly Full Session

Checkpoint before the old session becomes unusable. If it is already broken, open a new session:

```text
Use PCW to continue BACKEND from its latest persistent checkpoint. Tell me the reconstructed state before making changes.
```

## Stale Write

If `PCW_CONTINUITY_STALE` is returned, never overwrite blindly:

```text
Reread the current continuity, reconcile with the newer checkpoint and propose the updated complete continuity again.
```

Multiple chats may read the same workstream, and different chats may use different workstreams. Concurrent writes to one workstream use optimistic concurrency, not distributed locking.

## References And Portability

PCW-managed continuity, inventory, sources, and `.pcw/history` live inside the configured context. A local repository or document path recorded in continuity is only a hint; mark it as local-only when it may not exist on another machine.
