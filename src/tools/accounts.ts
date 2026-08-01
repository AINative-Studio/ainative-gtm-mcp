import { z } from 'zod';
import { getGTMClient } from '../lib/gtm-client.js';
import { gtmError } from '../lib/errors.js';

export const accountTools = [
  {
    name: 'gtm_list_accounts',
    description: 'List all GTM accounts accessible to the service account',
    inputSchema: z.object({}),
    async execute() {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.list();
        return res.data.account ?? [];
      } catch (e) { gtmError('gtm_list_accounts', e); }
    },
  },
  {
    name: 'gtm_list_containers',
    description: 'List all containers in a GTM account',
    inputSchema: z.object({
      accountId: z.string().describe('GTM account ID'),
    }),
    async execute({ accountId }: { accountId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.list({ parent: `accounts/${accountId}` });
        return res.data.container ?? [];
      } catch (e) { gtmError('gtm_list_containers', e); }
    },
  },
  {
    name: 'gtm_get_container',
    description: 'Get details of a specific GTM container',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
    }),
    async execute({ accountId, containerId }: { accountId: string; containerId: string }) {
      try {
        const gtm = getGTMClient();
        const res = await gtm.accounts.containers.get({
          path: `accounts/${accountId}/containers/${containerId}`,
        });
        return res.data;
      } catch (e) { gtmError('gtm_get_container', e); }
    },
  },
];
