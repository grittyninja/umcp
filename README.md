# umcp (Unified MCP)

`umcp` solves MCP configuration sprawl by aggregating multiple upstream MCP servers behind one server entry.

Core features:
- Aggregation with namespaced tools: `{category}.{provider}.{tool}`
- Tool aliasing via config (`upstream` + optional `alias`)
- Round-robin env rotation (`string[]` values rotate per invocation)
- Transport bridging:
  - umcp serve transport: `stdio` or Streamable HTTP
  - upstream transport: `stdio`, `sse`, or `streamable-http`

## Install

```bash
npm install
npm test
npm run build
```

Install directly from GitHub:

```bash
npm install github:grittyninja/umcp
```

Run once with `npx` from GitHub:

```bash
npx github:grittyninja/umcp --help
```

## Config source of truth

`umcp` uses one JSONC file:
- Default path: `~/.config/umcp/umcp.jsonc`
- Only `.jsonc` is supported.
- On first run, umcp auto-creates this file with detailed placeholders.

Schema file in this repo:
- `umcp.config.schema.json`

Example:
- `examples/umcp.config.jsonc`

## CLI

```bash
umcp serve [--transport stdio|http] [--host 127.0.0.1] [--port 8787] [--path /mcp] [--config /path/to/umcp.jsonc]
umcp validate [--config /path/to/umcp.jsonc]
umcp dry-run [--config /path/to/umcp.jsonc]
```

Compatibility flags:

```bash
umcp --validate
umcp --dry-run
```

## Before vs After

Before (3 separate servers in host config):

```json
{
  "mcpServers": {
    "brave": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "..." }
    },
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": { "TAVILY_API_KEY": "..." }
    },
    "linear": {
      "url": "https://linear-mcp.example.com/mcp"
    }
  }
}
```

After (single umcp entry):

```json
{
  "mcpServers": {
    "umcp": {
      "command": "npx",
      "args": ["-y", "github:grittyninja/umcp", "serve", "--transport", "stdio"]
    }
  }
}
```

Your host then sees tools like:
- `web_search.brave.search`
- `web_search.tavily.search`
- `project_mgmt.linear.add_task`

## Naming rules

To keep canonical names deterministic as exactly three segments:
- category names must match `[a-zA-Z0-9_-]+`
- provider names must match `[a-zA-Z0-9_-]+`
- tool aliases must match `[a-zA-Z0-9_-]+`

If an auto-discovered upstream tool name contains unsupported characters (for example `.`), umcp requires an explicit `tools` mapping with a valid `alias`.

## Round-robin env rotation

In `env`, use either:
- `"KEY": "single-value"`
- `"KEY": ["value-1", "value-2", "value-3"]`

Array values rotate per invocation. State is in-memory and resets on process restart.

## Structured logs

Logs are emitted as JSON lines to `stderr`:
- `config.loaded`, `config.created`
- `provider.connected`, `provider.disconnected`
- `tool.discovered`, `tool.registered`, `tool.called`
- `env.rotated`
- `dry_run.complete`
- `config.invalid`
