# MCP Tool Contract

All tools are exposed by server `pcw-mcp`. Structured success and error payloads are serialized as JSON in one MCP text content item unless noted otherwise. Inputs shown as strings require at least one character where marked `min 1`.

| Tool | Type | Purpose |
| --- | --- | --- |
| `hello` | Diagnostic | Verify that the MCP server responds. |
| `get_project_info` | Read | Return configured project and inventory metadata. |
| `list_workstreams` | Discovery | List configured logical workstreams. |
| `get_workstream_info` | Discovery | Return configuration and filesystem status for one workstream. |
| `get_continuity` | Read | Read one workstream's canonical continuity snapshot. |
| `list_shared_context` | Discovery | List configured shared logical sections and path status. |
| `list_sources` | Discovery | List immediate entries without reading content. |
| `get_inventory` | Read | Read the complete configured inventory. |
| `search_inventory` | Search | Select matching inventory sections. |
| `read_text_source` | Read | Read one Markdown or TXT source. |
| `read_docx_source` | Read | Extract text and warnings from one DOCX source. |
| `read_pdf_source` | Read | Extract selectable text from one PDF source. |
| `update_continuity` | Write | Atomically replace continuity using optimistic concurrency. |

## Project And Workstreams

### hello

Input: `name: string`.

Result: plain text `Hello <name>. PCW MCP is running correctly.`

Status: development compatibility tool; its decision is pending before beta contract freeze. New integrations should not depend on it because MCP initialization already provides a health check.

### get_project_info

Input: none.

Result: `contextRoot`, `configPath`, configuration `version`, `project: { id, name }`, and configured `inventory` path. Missing optional values are returned as `null`.

Configuration read, YAML parse, and schema-validation failures are MCP errors.

### list_workstreams

Input: none.

Result: an ordered array of `{ name, contextPath, continuityPath }` derived from dynamic `pcw.yml` keys. Optional paths are `null`.

### get_workstream_info

Input: `name: string` (min 1), resolved case-insensitively.

Result: canonical `name`, plus `context` and `continuity` objects containing `path`, `configured`, `exists`, `absolutePath`, and `type` (`file`, `directory`, `other`, or `null`).

Unknown names return `error` and `availableWorkstreams`.

### list_shared_context

Input: none.

Result: an array of dynamic shared sections with `name`, `path`, `configured`, `exists`, `absolutePath`, and `type`.

## Sources

Source scope is `shared` or `workstream`. Logical names are resolved case-insensitively while results preserve configured spelling. Reads remain within the selected section and PCW root.

### list_sources

Input: `scope` and `name: string` (min 1).

Result: `scope`, canonical `name`, configured `path`, `absolutePath`, `sourceCount`, and non-recursive `sources`. Each source has `name`, `type`, `sizeBytes`, and ISO `modifiedAt`.

Notable errors: unknown logical name, workstream without specialized context, missing context path, or listing failure with `path`.

### read_text_source

Input: `scope`, `name: string` (min 1), and relative `source: string` (min 1).

Result: `scope`, canonical `name`, `source`, `absolutePath`, `sizeBytes`, `modifiedAt`, and UTF-8 `text`.

Only `.md` and `.txt` are accepted. Failures include `error`, and either `source`, available names, or sanitized `details`.

### read_docx_source

Same input and metadata shape as text reads. Only `.docx` is accepted. Result adds extracted `text` and `warnings` from Mammoth. Extraction is text-oriented.

### read_pdf_source

Same input and metadata shape as text reads. Only `.pdf` is accepted. Result includes extracted selectable `text`; OCR is not supported.

## Inventory

### get_inventory

Input: none.

Result: configured `path`, `absolutePath`, `sizeBytes`, `modifiedAt`, and complete `inventory` text.

Notable errors: inventory absent, configured target not a file, or read failure with `path`.

### search_inventory

Input:

- `query: string` (min 1);
- optional `limit: integer`, minimum 1, maximum 20.

The service default is 8 when `limit` is absent.

Result: `query`, configured `inventory` path, `matchCount`, and ordered `matches`. Each match is `{ title, content }`. Matching is case-insensitive substring search over inventory sections and preserves document order.

## Continuity

### get_continuity

Input: `name: string` (min 1), resolved case-insensitively.

Result: canonical `workstream`, configured `path`, lowercase hexadecimal `sha256`, `absolutePath`, and complete `continuity` text.

Notable errors: unknown workstream with `availableWorkstreams`, continuity not configured, or read failure with `path`.

### update_continuity

Input:

- `name: string` (min 1);
- complete replacement `content: string` (1 to 200,000 characters);
- `expectedSha256: string` (exactly 64 characters; hexadecimal form is not currently schema-enforced).

Result: canonical `workstream`, configured `path`, `absolutePath`, `previousSha256`, `newSha256`, `backupPath`, and `updated: true`.

Only configured Markdown continuity files can be updated. A stale write returns `error`, `workstream`, `expectedSha256`, `currentSha256`, and `action`; no overwrite or backup occurs. Other failures retain category-specific `path`, `availableWorkstreams`, or `details`.
