# Adopt An Existing AI Session

PCW can be introduced after a project or AI conversation has already accumulated useful temporary state. The first adoption should be reviewed rather than written automatically.

## Phase 1: Propose, Do Not Write

Ask the agent to:

1. read the current PCW continuity and obtain its SHA;
2. use the current conversation as evidence;
3. optionally consult existing manual continuity notes;
4. prepare a complete replacement Markdown checkpoint;
5. remove conversational noise and transient checkpoint mechanics;
6. avoid calling `update_continuity`.

Review the proposal. It should describe durable workstream state that remains true after the checkpoint is written, not statements such as "adoption is in progress", "approval is pending", or "the next action is to save this checkpoint".

## Phase 2: Approve And Write

After human approval:

1. reread continuity and verify the latest SHA;
2. reconcile if another writer changed it;
3. call `update_continuity` with the complete approved document;
4. read it back and verify the persisted content and new SHA.

## Migrating Manual Continuity

Keep an existing manual file temporarily as a safety backup and use it as evidence for the first PCW checkpoint. Once PCW has proved stable, stop updating both systems in parallel because two canonical continuity sources can diverge. Do not delete historical notes immediately.

## What Has Been Validated

In a generalized private-beta scenario, a long-running IDE conversation adopted PCW, wrote a reviewed checkpoint, and a completely new desktop conversation reconstructed objective, completed work, decisions, rejected actions, blocker, and next action from continuity alone. No previous conversation, repository inspection, specialized context, shared context, or populated inventory was required.

Some MCP clients can expose a newly registered PCW server to an existing session. If PCW is not visible, reconnect or restart the client. This behavior depends on the client and version.
