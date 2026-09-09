# Example Taskboard Architecture

Example Taskboard is a fictional application used only to demonstrate PCW.

The browser client sends task commands to a local HTTP API. The API validates each request, applies task rules, and stores records through a persistence adapter. The adapter boundary keeps storage decisions separate from request handling.

The example deliberately places this document under `reference/product` while `pcw.yml` exposes it as the logical shared context `general`.
