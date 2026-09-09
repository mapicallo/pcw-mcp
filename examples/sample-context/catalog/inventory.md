# Example Taskboard Context Inventory

This inventory is a semantic map. Search it to identify a relevant source, then read only that source.

### Architecture Overview

Purpose: Understand how the fictional taskboard separates browser, API, and persistence responsibilities.

Topics: frontend, backend, HTTP API, persistence, boundaries.

Relationships: Start here before changing interactions between components.

Relevant source: `reference/product/architecture.md` in shared context `general`.

### Team Working Agreements

Purpose: Explain the fictional team's lightweight decision and review practices.

Topics: reviews, testing, ownership, handoff.

Relationships: Relevant when planning cross-workstream changes or recording durable decisions.

Relevant source: `reference/people/working-agreements.md` in shared context `organization`.

### Backend API Notes

Purpose: Provide implementation context for the BACKEND workstream.

Topics: task endpoints, request validation, error responses, tests.

Relationships: Read after the architecture overview when modifying the API.

Relevant source: `delivery/api/backend-api.md` in workstream context `BACKEND`.

### Operations Workstream

Purpose: Locate the current deployment-readiness checkpoint.

Topics: runbook planning, health checks, release readiness.

Relationships: OPERATIONS intentionally has continuity without a specialized context directory.

Relevant source: `continuity/OPERATIONS.md` through `get_continuity`.
