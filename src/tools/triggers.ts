import { z } from 'zod';
import { getGTMClient, workspacePath } from '../lib/gtm-client.js';
import { gtmError } from '../lib/errors.js';

export const triggerTools = [
  {
    name: 'gtm_list_triggers',
    description: 'List all triggers in a GTM workspace',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.triggers.list({
          parent: workspacePath(accountId, containerId, workspaceId),
        });
        return res.data.trigger ?? [];
      } catch (e) { gtmError('gtm_list_triggers', e); }
    },
  },
  {
    name: 'gtm_get_trigger',
    description: 'Get full configuration of a specific GTM trigger',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      triggerId: z.string(),
    }),
    async execute({ accountId, containerId, workspaceId, triggerId }: { accountId: string; containerId: string; workspaceId: string; triggerId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.triggers.get({
          path: `${workspacePath(accountId, containerId, workspaceId)}/triggers/${triggerId}`,
        });
        return res.data;
      } catch (e) { gtmError('gtm_get_trigger', e); }
    },
  },
  {
    name: 'gtm_create_trigger',
    description: 'Create a new trigger in a GTM workspace',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      trigger: z.record(z.unknown()).describe('Full GTM trigger body'),
    }),
    async execute({ accountId, containerId, workspaceId, trigger }: { accountId: string; containerId: string; workspaceId: string; trigger: Record<string, unknown> }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.triggers.create({
          parent: workspacePath(accountId, containerId, workspaceId),
          requestBody: trigger,
        });
        return res.data;
      } catch (e) { gtmError('gtm_create_trigger', e); }
    },
  },
  {
    name: 'gtm_update_trigger',
    description: 'Update an existing GTM trigger',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      triggerId: z.string(),
      updates: z.record(z.unknown()).describe('Partial trigger body — only fields to update'),
    }),
    async execute({ accountId, containerId, workspaceId, triggerId, updates }: {
      accountId: string; containerId: string; workspaceId: string; triggerId: string; updates: Record<string, unknown>;
    }) {
      try {
        const gtm = getGTMClient();
        const current = await gtm.accounts.containers.workspaces.triggers.get({
          path: `${workspacePath(accountId, containerId, workspaceId)}/triggers/${triggerId}`,
        });
        const res = await gtm.accounts.containers.workspaces.triggers.update({
          path: `${workspacePath(accountId, containerId, workspaceId)}/triggers/${triggerId}`,
          requestBody: { ...current.data, ...updates },
        });
        return res.data;
      } catch (e) { gtmError('gtm_update_trigger', e); }
    },
  },
];
