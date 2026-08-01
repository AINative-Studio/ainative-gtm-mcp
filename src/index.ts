#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountTools } from './tools/accounts.js';
import { tagTools } from './tools/tags.js';
import { triggerTools } from './tools/triggers.js';
import { auditTools } from './tools/audit.js';
import { versionTools } from './tools/versions.js';
import { googleAdsTools } from './tools/google-ads.js';
import { googleAdsLifecycleTools } from './tools/google-ads-lifecycle.js';

const server = new McpServer({
  name: 'ainative-gtm-mcp',
  version: '0.2.0',
});

const allTools = [
  ...accountTools,
  ...tagTools,
  ...triggerTools,
  ...auditTools,
  ...versionTools,
  ...googleAdsTools,
  ...googleAdsLifecycleTools,
];

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape ?? {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const result = await (tool.execute as (args: unknown) => Promise<unknown>)(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
