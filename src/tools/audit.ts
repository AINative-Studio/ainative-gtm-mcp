import { z } from 'zod';
import { getGTMClient, workspacePath } from '../lib/gtm-client.js';
import { gtmError } from '../lib/errors.js';

export const auditTools = [
  {
    name: 'gtm_audit_container',
    description: 'Comprehensive container audit — finds broken tags, duplicate tags, misfiring conversion tags, tags missing triggers, and tags firing too broadly. Returns a health score 0–100.',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        const parent = workspacePath(accountId, containerId, workspaceId);

        const [tagsRes, triggersRes, varsRes] = await Promise.all([
          gtm.accounts.containers.workspaces.tags.list({ parent }),
          gtm.accounts.containers.workspaces.triggers.list({ parent }),
          gtm.accounts.containers.workspaces.variables.list({ parent }),
        ]);

        const tags = tagsRes.data.tag ?? [];
        const triggers = triggersRes.data.trigger ?? [];

        const issues: string[] = [];
        let deductions = 0;

        // Tags with no triggers (paused or broken)
        const noTriggerTags = tags.filter(t => !t.firingTriggerId || t.firingTriggerId.length === 0);
        if (noTriggerTags.length > 0) {
          issues.push(`${noTriggerTags.length} tag(s) have no firing triggers: ${noTriggerTags.map(t => t.name).join(', ')}`);
          deductions += noTriggerTags.length * 5;
        }

        // Tags firing on "All Pages" that look like conversion tags
        const allPagesTrigger = triggers.find(t => t.type === 'PAGEVIEW' && t.name?.toLowerCase().includes('all'));
        if (allPagesTrigger) {
          const conversionTagsOnAllPages = tags.filter(t =>
            t.firingTriggerId?.includes(allPagesTrigger.triggerId!) &&
            (t.name?.toLowerCase().includes('conversion') || t.name?.toLowerCase().includes('purchase') || t.name?.toLowerCase().includes('ads'))
          );
          if (conversionTagsOnAllPages.length > 0) {
            issues.push(`MISFIRING: ${conversionTagsOnAllPages.length} conversion tag(s) firing on All Pages trigger: ${conversionTagsOnAllPages.map(t => t.name).join(', ')} — should use a specific event trigger`);
            deductions += conversionTagsOnAllPages.length * 15;
          }
        }

        // Duplicate tag names
        const tagNames = tags.map(t => t.name?.toLowerCase());
        const dupes = tagNames.filter((n, i) => tagNames.indexOf(n) !== i);
        if (dupes.length > 0) {
          issues.push(`Duplicate tag names detected: ${[...new Set(dupes)].join(', ')}`);
          deductions += dupes.length * 3;
        }

        // Tags with no type
        const noTypeTags = tags.filter(t => !t.type);
        if (noTypeTags.length > 0) {
          issues.push(`${noTypeTags.length} tag(s) have no type configured`);
          deductions += noTypeTags.length * 5;
        }

        const score = Math.max(0, 100 - deductions);

        return {
          healthScore: score,
          grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
          tagCount: tags.length,
          triggerCount: triggers.length,
          variableCount: varsRes.data.variable?.length ?? 0,
          issues,
          summary: issues.length === 0
            ? 'Container looks healthy — no issues detected.'
            : `${issues.length} issue(s) found. Fix priority items to improve your health score.`,
        };
      } catch (e) { gtmError('gtm_audit_container', e); }
    },
  },
  {
    name: 'gtm_find_misfiring_conversion_tags',
    description: 'Find conversion/purchase tags that are firing too broadly (e.g. on All Pages instead of a specific event). This is the most common GTM billing/analytics issue.',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
    }),
    async execute({ accountId, containerId, workspaceId }: { accountId: string; containerId: string; workspaceId: string }) {
      try {
        const gtm = getGTMClient();
        const parent = workspacePath(accountId, containerId, workspaceId);

        const [tagsRes, triggersRes] = await Promise.all([
          gtm.accounts.containers.workspaces.tags.list({ parent }),
          gtm.accounts.containers.workspaces.triggers.list({ parent }),
        ]);

        const tags = tagsRes.data.tag ?? [];
        const triggers = triggersRes.data.trigger ?? [];

        // Build a map of triggerId → trigger
        const triggerMap = new Map(triggers.map(t => [t.triggerId, t]));

        const misfiring = tags
          .filter(t =>
            t.name?.toLowerCase().match(/conversion|purchase|ads_conversion|remarketing/)
          )
          .map(tag => {
            const firingTriggers = (tag.firingTriggerId ?? []).map(id => triggerMap.get(id)).filter(Boolean);
            const broadTriggers = firingTriggers.filter(t =>
              t!.type === 'PAGEVIEW' || t!.name?.toLowerCase().includes('all pages')
            );
            return {
              tagName: tag.name,
              tagId: tag.tagId,
              tagType: tag.type,
              firingTriggers: firingTriggers.map(t => ({ id: t!.triggerId, name: t!.name, type: t!.type })),
              misfiring: broadTriggers.length > 0,
              broadTriggers: broadTriggers.map(t => ({ id: t!.triggerId, name: t!.name, type: t!.type })),
              recommendation: broadTriggers.length > 0
                ? `Change trigger from "${broadTriggers.map(t => t!.name).join(', ')}" to a specific Custom Event trigger (e.g. "purchase_confirmed" or "upgrade_completed")`
                : 'Trigger looks correctly scoped',
            };
          });

        const misfireCount = misfiring.filter(t => t.misfiring).length;
        return {
          totalConversionTags: misfiring.length,
          misfiring: misfireCount,
          clean: misfiring.length - misfireCount,
          tags: misfiring,
        };
      } catch (e) { gtmError('gtm_find_misfiring_conversion_tags', e); }
    },
  },
  {
    name: 'gtm_fix_conversion_tag_trigger',
    description: 'Fix a misfiring conversion tag by replacing its broad trigger (e.g. All Pages) with a specific Custom Event trigger. Creates the new trigger if needed.',
    inputSchema: z.object({
      accountId: z.string(),
      containerId: z.string(),
      workspaceId: z.string().default('1'),
      tagId: z.string().describe('Tag ID to fix'),
      eventName: z.string().describe('Custom event name to fire on (e.g. "purchase_confirmed")'),
      removeBroadTriggers: z.boolean().default(true).describe('Remove All Pages / broad triggers from this tag'),
    }),
    async execute({ accountId, containerId, workspaceId, tagId, eventName, removeBroadTriggers }: {
      accountId: string; containerId: string; workspaceId: string; tagId: string; eventName: string; removeBroadTriggers: boolean;
    }) {
      try {
        const gtm = getGTMClient();
        const parent = workspacePath(accountId, containerId, workspaceId);

        // Get current tag
        const tagRes = await gtm.accounts.containers.workspaces.tags.get({
          path: `${parent}/tags/${tagId}`,
        });
        const tag = tagRes.data;

        // Get all triggers to find broad ones
        const triggersRes = await gtm.accounts.containers.workspaces.triggers.list({ parent });
        const triggers = triggersRes.data.trigger ?? [];
        const triggerMap = new Map(triggers.map(t => [t.triggerId, t]));

        // Create a new Custom Event trigger for this specific event
        const newTriggerRes = await gtm.accounts.containers.workspaces.triggers.create({
          parent,
          requestBody: {
            name: `CE - ${eventName}`,
            type: 'CUSTOM_EVENT',
            customEventFilter: [{
              type: 'EQUALS',
              parameter: [
                { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
                { type: 'TEMPLATE', key: 'arg1', value: eventName },
              ],
            }],
          },
        });
        const newTriggerId = newTriggerRes.data.triggerId!;

        // Build new firing trigger list: remove broad ones, add new specific trigger
        let firingTriggers = tag.firingTriggerId ?? [];
        if (removeBroadTriggers) {
          firingTriggers = firingTriggers.filter(id => {
            const t = triggerMap.get(id);
            return !(t?.type === 'PAGEVIEW' || t?.name?.toLowerCase().includes('all pages'));
          });
        }
        firingTriggers = [...new Set([...firingTriggers, newTriggerId])];

        // Update the tag
        const updatedTag = await gtm.accounts.containers.workspaces.tags.update({
          path: `${parent}/tags/${tagId}`,
          requestBody: { ...tag, firingTriggerId: firingTriggers },
        });

        return {
          success: true,
          tagName: updatedTag.data.name,
          newTriggerId,
          newTriggerName: `CE - ${eventName}`,
          firingTriggers: updatedTag.data.firingTriggerId,
          message: `Tag "${tag.name}" now fires only on custom event "${eventName}". Publish the workspace to make this live.`,
        };
      } catch (e) { gtmError('gtm_fix_conversion_tag_trigger', e); }
    },
  },
];
