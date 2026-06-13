# s33k MCP server

This is the MCP (Model Context Protocol) control layer for s33k. It lets an LLM client such as Claude Code operate s33k entirely over a single connection: list domains, list keywords with live Google rankings, add new keywords, trigger fresh SERP scrapes, and read Search Console insight.

The server is a thin wrapper over the s33k REST API. It speaks stdio transport and authenticates with the s33k Bearer API key, so it runs fully headless with no login cookie.

## Tools

| Tool | What it does | Arguments |
|---|---|---|
| `list_domains` | List all domains tracked in s33k. | none |
| `list_keywords` | List a domain's keywords with current rank, ranking URL, target page, and last 7 days of rank history. | `domain` |
| `add_keyword` | Add a keyword to track. Queues a background SERP scrape. | `keyword`, `domain`, `country` (default `US`), `device` (`desktop` or `mobile`, default `desktop`), `target_page` (optional) |
| `refresh_keywords` | Trigger a fresh SERP scrape, either for specific keyword IDs or for a whole domain. | `ids` (array of numbers) OR `domain` |
| `get_insight` | Read Google Search Console insight for a domain (top pages, keywords, countries, stats). Requires Search Console to be connected for that domain. | `domain` |

## Requirements

- Node 20 (the s33k repo pins Node 20 via nvm; native deps are built for it). The MCP SDK requires Node 18 or newer, so Node 20 is fine.
- A running s33k instance. By default the server talks to `http://localhost:3005`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `S33K_API_KEY` | yes | none | The value of `APIKEY` in the s33k root `.env` file. |
| `S33K_BASE_URL` | no | `http://localhost:3005` | The base URL of the running s33k instance. |

The Bearer API key path is whitelisted in s33k's `utils/verifyUser.ts` for the routes these tools use (`GET /api/domains`, `GET /api/keywords`, `POST /api/keywords`, `POST /api/domains`, `POST /api/refresh`, `GET /api/insight`).

## Install and build

Run from the `mcp/` directory. Make sure Node 20 is active first.

```bash
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20
cd /Users/ben/Projects/s33k/mcp
npm install
npm run build
```

This compiles `src/index.ts` to `dist/index.js`.

## Register it in Claude Code

The compiled entry point is `/Users/ben/Projects/s33k/mcp/dist/index.js`. Register it with the `claude mcp add` command, passing the env vars with `-e`:

```bash
claude mcp add s33k \
  -e S33K_API_KEY=YOUR_S33K_API_KEY \
  -e S33K_BASE_URL=http://localhost:3005 \
  -- node /Users/ben/Projects/s33k/mcp/dist/index.js
```

Or, equivalently, add this block to a Claude Code MCP JSON config (for example `.mcp.json` at the repo root, or your user `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "s33k": {
      "command": "node",
      "args": ["/Users/ben/Projects/s33k/mcp/dist/index.js"],
      "env": {
        "S33K_API_KEY": "YOUR_S33K_API_KEY",
        "S33K_BASE_URL": "http://localhost:3005"
      }
    }
  }
}
```

After registering, restart Claude Code (or reload MCP servers) and the five s33k tools become available. Confirm with `claude mcp list`.

## Run it directly (manual check)

The server speaks stdio and waits for a client, so running it by hand will simply print a startup line to stderr and then block:

```bash
S33K_API_KEY=... S33K_BASE_URL=http://localhost:3005 node dist/index.js
```

A clean boot prints `s33k-mcp connected (base URL: ...). 5 tools registered.` to stderr. Press Ctrl-C to stop.

## Notes

- All protocol traffic is on stdout. Diagnostic lines (startup, fatal errors) are written to stderr so they do not corrupt the MCP stream.
- Tool errors (for example a missing domain or an unconfigured scraper) are returned as MCP tool error results, not thrown, so the LLM can read and react to them.
