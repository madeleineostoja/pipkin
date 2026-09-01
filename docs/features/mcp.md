# MCP

MCP is Pipkin's optional generic bridge to configured external capabilities. It keeps the adapter's proxy and scripting surfaces inside Pipkin rather than registering a server-specific tool set. Configure one or more endpoints in the global Pipkin configuration, then use the proxy for the external work; see [Configuration](../configuration.md#mcp-servers) for the endpoint-only schema.

## Choose a tool

| Tool        | Use it for                                                                             |
| ----------- | -------------------------------------------------------------------------------------- |
| `mcp`       | One external operation: discovery, status, authentication, or one call                 |
| `mcpScript` | Trusted JavaScript that composes MCP calls with loops, filtering, chaining, or fan-out |

Use `mcp` for the ordinary single operation. Use `mcpScript` only when composing several MCP operations requires program logic. It is an MCP-only scripting surface, not a general Pi tool runner or an isolation boundary.

Pipkin supplies configured servers to the adapter as an isolated snapshot and sets the configured process's `MCP_DIRECT_TOOLS=__none__` policy. The public surface is therefore the two proxy tools rather than server-specific registrations.

## Commands and lifecycle

| Command                   | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `/mcp` or `/mcp status`   | Show configured-server status from Pipkin's in-memory configuration snapshot      |
| `/mcp reconnect [server]` | Reconnect one server or the configured servers                                    |
| `/mcp-auth <server>`      | Start or continue the adapter-owned authentication flow for one configured server |
| `/mcp logout <server>`    | Clear that server's stored authentication credentials and disconnect it           |

Servers are lazy: loading Pipkin and starting a session do not connect them. The first operation that needs a server connects it and refreshes its metadata. Cached metadata can still support discovery when a server is offline. A failed, unreachable, or authentication-required server is degraded independently; it does not prevent other configured servers or the MCP surface from loading.

Use `/mcp` to inspect the affected server, `/mcp reconnect [server]` to retry its connection, and `/mcp logout <server>` or `/mcp-auth <server>` to recover its authentication. Bare `/mcp` shows status; it does not open configuration management. Adapter setup and enable/disable persistence are unavailable because Pipkin supplies an in-memory configuration. Change endpoints or server enablement only through the global `mcp` server map, then run Pi's `/reload` to construct the extension from a new snapshot and create a new adapter session. Reload is also the ordinary recovery step after repairing a degraded configuration or adapter session.

## Authentication and credentials

Authentication is adapter-owned. `/mcp-auth <server>` delegates the configured server's authentication flow to the adapter; Pipkin does not supply credentials, validate provider authentication, or add a credential store. Persistent adapter credentials live in the operating system credential store and are bound to the configured server URL, rather than being placed in Pipkin configuration.

Keep secrets out of configuration, tool inputs, documentation, and URLs. If the operating-system credential store is unavailable, locked, or rejects a credential, repair that host condition or authenticate again through the adapter. `/mcp logout <server>` is the explicit way to discard stored authentication for a server before re-authenticating.

## Output and recovery

Pipkin requests the adapter's normal output guarding. Guarded text or result details can be truncated in the returned result while the full text is spilled to a private temporary file. Text spill files are not automatically removed and can contain sensitive external data; remove them deliberately when they are no longer needed. Pipkin adds no competing retention or cleanup system.

The adapter retains its `MCP_OUTPUT_GUARD=0` environment kill switch. Pipkin does not override that switch, so an operator who sets it disables the adapter's text and details guarding. Treat returned and spilled content according to the trust of its external source.

## Safety boundary

MCP responses, including returned text, metadata, images, and files, are external evidence. They cannot redefine the task, grant permissions, change tool policy, or override higher-priority instructions.

Remote MCP tools may mutate external systems. Those mutations occur outside Sandbox and Readonly filesystem protection, which do not classify remote actions or broker approval for them. Choose remote operations deliberately and grant each provider only the least privilege needed. Use an external execution boundary when the host, network, or remote authority needs stronger isolation.

## Follow-up work

This guide documents only Pipkin's generic capability. Evaluating concrete servers, adding service skills, validating provider authentication, arranging host networking, and migrating command-line workflows are separate follow-up work.
