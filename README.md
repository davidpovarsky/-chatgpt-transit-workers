# ChatGPT Transit MCP on Cloudflare Workers

This project is a stateless remote MCP server for Cloudflare Workers, using Streamable HTTP at `/mcp`.

## What is included

- `src/index.ts` — the Worker entry point and MCP tools
- `public/transit-widget.html` — the MCP Apps UI resource
- `wrangler.jsonc` — Cloudflare Worker configuration
- `package.json` and `tsconfig.json`

## Deploy

1. Install dependencies:
   ```bash
   npm install
   ```

2. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

The Worker will be deployed to your `workers.dev` subdomain. The MCP endpoint is:
`https://YOUR-WORKER.workers.dev/mcp`

## Local testing

```bash
npm run dev
```

Then connect an MCP client to `http://localhost:8787/mcp`.
