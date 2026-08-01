import { z } from 'zod';
import { getGTMClient, workspacePath } from '../lib/gtm-client.js';
import { gtmError } from '../lib/errors.js';

export const versionTools = [
  {
    name: 'gtm_list_workspaces',
    description: 'List workspaces in a GTM container',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
    }),
    async execute({ accountId, containerId }: { accountId: string; containerId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.list({
          parent: `accounts/${accountId}/containers/${containerId}`,
        });
        return res.data.workspace ?? [];
      } catch (e) { gtmError('gtm_list_workspaces', e); }
    },
  },
  {
    name: 'gtm_get_workspace_status',
    description: 'Get pending (unsaved) changes in a workspace before publishing',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.getStatus({
          path: workspacePath(accountId, containerId, workspaceId),
        });
        return res.data;
      } catch (e) { gtmError('gtm_get_workspace_status', e); }
    },
  },
  {
    name: 'gtm_create_version',
    description: 'Create a container version from current workspace changes',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      name: z.string().describe('Version name'),
      notes: z.string().optional().describe('Version notes / changelog'),
    }),
    async execute({ accountId, containerId, workspaceId, name, notes }: {
      accountId: string; containerId: string; workspaceId: string; name: string; notes?: string;
    }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.workspaces.create_version({
          path: workspacePath(accountId, containerId, workspaceId),
          requestBody: { name, notes },
        });
        return res.data;
      } catch (e) { gtmError('gtm_create_version', e); }
    },
  },
  {
    name: 'gtm_publish',
    description: 'Publish the current workspace — makes all changes live immediately',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        // Create version first, then publish it
        const versionRes = await gtm.accounts.containers.workspaces.create_version({
          path: workspacePath(accountId, containerId, workspaceId),
          requestBody: { name: `Auto-publish ${new Date().toISOString()}` },
        });
        const versionId = versionRes.data.containerVersion?.containerVersionId;
        if (!versionId) throw new Error('Failed to create version before publishing');

        const publishRes = await gtm.accounts.containers.versions.publish({
          path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
        });
        return {
          published: true,
          versionId,
          compilerError: publishRes.data.compilerError,
          containerVersion: publishRes.data.containerVersion,
        };
      } catch (e) { gtmError('gtm_publish', e); }
    },
  },
];
