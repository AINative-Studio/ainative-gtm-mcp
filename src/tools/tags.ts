import { z } from 'zod';
import { getGTMClient, workspacePath } from '../lib/gtm-client.js';
import { gtmError } from '../lib/errors.js';

export const tagTools = [
  {
    name: 'gtm_list_tags',
    description: 'List all tags in a GTM workspace',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.tags.list({
          parent: workspacePath(accountId, containerId, workspaceId),
        });
        return res.data.tag ?? [];
      } catch (e) { gtmError('gtm_list_tags', e); }
    },
  },
  {
    name: 'gtm_get_tag',
    description: 'Get full configuration of a specific GTM tag',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      tagId: z.string(),
    }),
    async execute({ accountId, containerId, workspaceId, tagId }: { accountId: string; containerId: string; workspaceId: string; tagId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.tags.get({
          path: `${workspacePath(accountId, containerId, workspaceId)}/tags/${tagId}`,
        });
        return res.data;
      } catch (e) { gtmError('gtm_get_tag', e); }
    },
  },
  {
    name: 'gtm_update_tag',
    description: 'Update an existing GTM tag (e.g. fix its trigger, rename it, update parameters)',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      tagId: z.string(),
      updates: z.record(z.unknown()).describe('Partial tag body — only fields to update'),
    }),
    async execute({ accountId, containerId, workspaceId, tagId, updates }: {
      accountId: string; containerId: string; workspaceId: string; tagId: string; updates: Record<string, unknown>;
    }) {
      try {
        const gtm = getGTMClient();
        // Fetch current tag first so we can merge
        const current = await gtm.accounts.containers.workspaces.tags.get({
          path: `${workspacePath(accountId, containerId, workspaceId)}/tags/${tagId}`,
        });
        const res = await gtm.accounts.containers.workspaces.tags.update({
          path: `${workspacePath(accountId, containerId, workspaceId)}/tags/${tagId}`,
          requestBody: { ...current.data, ...updates },
        });
        return res.data;
      } catch (e) { gtmError('gtm_update_tag', e); }
    },
  },
  {
    name: 'gtm_delete_tag',
    description: 'Delete a GTM tag from a workspace',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      tagId: z.string(),
    }),
    async execute({ accountId, containerId, workspaceId, tagId }: { accountId: string; containerId: string; workspaceId: string; tagId: string }) {
      try {
        const gtm = getGTMClient();
        await gtm.accounts.containers.workspaces.tags.delete({
          path: `${workspacePath(accountId, containerId, workspaceId)}/tags/${tagId}`,
        });
        return { deleted: true, tagId };
      } catch (e) { gtmError('gtm_delete_tag', e); }
    },
  },
];
