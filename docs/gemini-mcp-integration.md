# Gemini CLI and MCP setup

RHEA provides two MCP servers. The local server reads project documentation over stdio. The remote gateway exposes scoped Google Drive tools after OAuth approval.

## Local documentation

From the repository root, use the checked-in `.gemini/settings.json`. In Gemini CLI, run `/mcp` to check the `rheaContext` registration. Call `rhea_project_status` for an overview or `rhea_read_document` with one of the paths listed in its tool schema.

## Remote Drive

Deploy the [MCP gateway](mcp-gateway.md) and register the Gemini CLI OAuth client before adding it to your CLI configuration. Use the endpoint and configuration shown in the web workspace, or adapt the [example settings](examples/gemini-rhea-drive.settings.example.json) to the gateway you administer. Run `/mcp auth rheaDrive` and approve the request in RHEA. Call `rhea_connection_status` before using Drive tools and use `rhea_list_folder` to inspect the authorized root.

[Gemini CLI MCP guide](https://geminicli.com/docs/tools/mcp-server/)
