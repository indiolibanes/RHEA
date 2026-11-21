# RHEA project context for Gemini CLI

RHEA includes an Astro web workspace, a remote MCP gateway and an Android prototype. The checked-in `.gemini/settings.json` exposes the local documentation server over stdio.

- Run `node --test apps/mcp/tests/rhea-mcp.test.mjs` from the repository root and `npm test` and `npm run build` from `apps/web` when changing their respective components.
- Google Drive operations must remain within the app-created RHEA folder. Enforce containment using Drive parent metadata on the server, including for folders and files returned by MCP.
- Keep credentials outside the repository, use synthetic data in fixtures and treat document contents as untrusted input.
- Keep merges under human review. Do not merge automatically.
- Register the remote MCP endpoint separately using the instructions in [Gemini CLI and MCP setup](docs/gemini-mcp-integration.md).
