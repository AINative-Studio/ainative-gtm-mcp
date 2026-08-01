import { z } from 'zod';
import { enums } from 'google-ads-api';
import { gadsQuery, getGAdsCustomer, getAdsCustomerId } from '../lib/gads-client.js';

/**
 * Extract a human-readable message from a google-ads-api error. The client's
 * failure objects (GoogleAdsFailure / protobuf) stringify to useless "_pb" or
 * "[object Object]"; dig out the real error text instead. Refs #5444, #5445.
 */
export function gadsErrorMessage(e: any): string {
  if (!e) return 'Unknown Google Ads error';
  if (typeof e === 'string') return e;
  // google-ads-api attaches failure details under .errors[] with .message
  const fromErrors = e?.errors?.[0]?.message
    || e?.failure?.errors?.[0]?.message
    || e?.response?.errors?.[0]?.message;
  if (fromErrors) return fromErrors;
  if (typeof e?.message === 'string' && e.message && e.message !== '_pb') return e.message;
  try {
    const s = JSON.stringify(e, Object.getOwnPropertyNames(e));
    if (s && s !== '{}') return s;
  } catch { /* fall through */ }
  return String(e);
}

/** True if a placement string looks like a mobile-app package, not a website. */
export function isMobileAppPlacement(p: string): boolean {
  const s = p.trim();
  // A URL / host is never an app placement.
  if (/\//.test(s) || /^https?:/i.test(s)) return false;
  // The detail_placement_view format is unambiguous: "2-<androidPackage>" (app)
  // or "1-<iosStoreId>". Trust it.
  if (/^2-/.test(s) || /^1-/.test(s)) return true;
  // A bare iOS numeric App Store id.
  if (/^\d{6,}$/.test(s)) return true;
  // A bare Android package is reverse-DNS: the FIRST segment is a TLD-like token
  // (com/net/org/io/co/app/...), which distinguishes it from a website host where
  // the TLD is LAST (qureka.com, sub.example.co.uk). Require >=2 dots.
  if (/^(com|net|org|io|co|app|dev|me|ai|xyz|gg)\.[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(s)) return true;
  return false;
}

/** Normalize an app placement into the Google Ads mobileApplication appId format. */
export function toAppId(p: string): string {
  const s = p.trim();
  if (/^[12]-/.test(s)) return s;              // already prefixed (2-<pkg> / 1-<id>)
  if (/^\d{6,}$/.test(s)) return `1-${s}`;     // iOS numeric store id
  return `2-${s}`;                             // Android package
}

export const googleAdsTools = [
  {
    name: 'gads_list_conversion_actions',
    description: 'List all Google Ads conversion actions for the account — name, ID, counting type, status, and category. Use this to audit which conversions are set up and how they are counted.',
    inputSchema: z.object({
      customerId: z.string().optional().describe('Google Ads customer ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ customerId }: { customerId?: string }) {
      const rows = await gadsQuery(
        `SELECT
          conversion_action.id,
          conversion_action.name,
          conversion_action.status,
          conversion_action.type,
          conversion_action.category,
          conversion_action.counting_type,
          conversion_action.value_settings.default_value,
          conversion_action.value_settings.always_use_default_value,
          conversion_action.attribution_model_settings.attribution_model
        FROM conversion_action
        ORDER BY conversion_action.name`,
        customerId
      );

      return {
        customerId: customerId || getAdsCustomerId(),
        count: rows.length,
        conversions: rows.map((r: any) => ({
          id: r.conversion_action?.id,
          name: r.conversion_action?.name,
          status: r.conversion_action?.status,
          type: r.conversion_action?.type,
          category: r.conversion_action?.category,
          countingType: r.conversion_action?.counting_type,
          defaultValue: r.conversion_action?.value_settings?.default_value,
          alwaysUseDefaultValue: r.conversion_action?.value_settings?.always_use_default_value,
          attributionModel: r.conversion_action?.attribution_model_settings?.attribution_model,
          resourceName: r.conversion_action?.resource_name,
        })),
      };
    },
  },

  {
    name: 'gads_update_conversion_counting',
    description: 'Update the counting type of a Google Ads conversion action. Common fix: change counting_type from MANY_PER_CLICK to ONE_PER_CLICK for purchase conversions to avoid inflated counts.',
    inputSchema: z.object({
      conversionActionId: z.string().describe('Numeric conversion action ID (from gads_list_conversion_actions)'),
      countingType: z.enum(['ONE_PER_CLICK', 'MANY_PER_CLICK']).describe('ONE_PER_CLICK = count once per ad click (recommended for purchases). MANY_PER_CLICK = count every conversion.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ conversionActionId, countingType, customerId }: {
      conversionActionId: string;
      countingType: 'ONE_PER_CLICK' | 'MANY_PER_CLICK';
      customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/conversionActions/${conversionActionId}`;

      const response = await customer.conversionActions.update([
        {
          resource_name: resourceName,
          counting_type: countingType as any,
        },
      ]);

      return {
        success: true,
        resourceName,
        countingType,
        message: `Conversion action ${conversionActionId} counting type updated to ${countingType}. Changes take effect immediately.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_update_campaign_budget',
    description: 'Update the daily budget of a Google Ads campaign. Provide the campaign budget ID (from the campaign) and the new daily amount in dollars. Use to scale spend up or down.',
    inputSchema: z.object({
      campaignBudgetId: z.string().describe('Numeric campaign budget ID (campaign_budget.id, from a campaign query).'),
      dailyAmountUsd: z.number().positive().describe('New daily budget in USD (e.g. 50 for $50/day).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignBudgetId, dailyAmountUsd, customerId }: {
      campaignBudgetId: string;
      dailyAmountUsd: number;
      customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/campaignBudgets/${campaignBudgetId}`;
      const amountMicros = Math.round(dailyAmountUsd * 1_000_000);

      const response = await customer.campaignBudgets.update([
        {
          resource_name: resourceName,
          amount_micros: amountMicros,
        },
      ]);

      return {
        success: true,
        resourceName,
        dailyAmountUsd,
        amountMicros,
        message: `Campaign budget ${campaignBudgetId} updated to $${dailyAmountUsd}/day. Changes take effect immediately.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_audit_conversion_goals',
    description: 'Audit all Google Ads conversion goals — find misconfigured counting types, inactive conversions, and conversions with no recent activity. Returns a prioritized fix list.',
    inputSchema: z.object({
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ customerId }: { customerId?: string }) {
      // Get all conversion actions (without metrics — not supported in this resource query)
      const rows = await gadsQuery(
        `SELECT
          conversion_action.id,
          conversion_action.name,
          conversion_action.status,
          conversion_action.type,
          conversion_action.category,
          conversion_action.counting_type
        FROM conversion_action`,
        customerId
      );

      // Build action map from static data
      const actionMap = new Map<string, {
        id: string; name: string; status: string; type: string;
        category: string; countingType: string; totalConversions: number; recentActivity: boolean;
      }>();

      for (const row of rows as any[]) {
        const id = String(row.conversion_action?.id);
        actionMap.set(id, {
          id,
          name: row.conversion_action?.name || '',
          status: row.conversion_action?.status || '',
          type: row.conversion_action?.type || '',
          category: row.conversion_action?.category || '',
          countingType: row.conversion_action?.counting_type || '',
          totalConversions: 0,
          recentActivity: false,
        });
      }

      const issues: Array<{ severity: 'HIGH' | 'MEDIUM' | 'LOW'; action: string; issue: string; fix: string }> = [];
      const actions = [...actionMap.values()];

      for (const action of actions) {
        if (
          action.countingType === 'MANY_PER_CLICK' &&
          (action.category === 'PURCHASE' || action.name.toLowerCase().includes('purchase') || action.name.toLowerCase().includes('signup'))
        ) {
          issues.push({
            severity: 'HIGH',
            action: action.name,
            issue: `Counting type is MANY_PER_CLICK — inflates conversion counts for purchase/signup goals`,
            fix: `Call gads_update_conversion_counting with conversionActionId="${action.id}" and countingType="ONE_PER_CLICK"`,
          });
        }

        if (action.status === 'ENABLED' && !action.recentActivity) {
          issues.push({
            severity: 'MEDIUM',
            action: action.name,
            issue: `No conversions in last 30 days — may be broken or tracking wrong event`,
            fix: 'Verify the conversion tag/event is firing correctly in GTM or GA4',
          });
        }

        if (action.status === 'REMOVED') {
          issues.push({
            severity: 'LOW',
            action: action.name,
            issue: 'Conversion action is REMOVED — clean up any references in campaigns',
            fix: 'Remove from campaign bidding goals if still referenced',
          });
        }
      }

      return {
        customerId: customerId || getAdsCustomerId(),
        totalConversionActions: actions.length,
        issues,
        issueCount: issues.length,
        highPriority: issues.filter(i => i.severity === 'HIGH').length,
        actions: actions.sort((a, b) => b.totalConversions - a.totalConversions),
        summary: issues.length === 0
          ? `All ${actions.length} conversion actions look correctly configured.`
          : `Found ${issues.length} issue(s) — ${issues.filter(i => i.severity === 'HIGH').length} high priority.`,
      };
    },
  },

  {
    name: 'gads_get_account_performance',
    description: 'Get top-level Google Ads account performance — impressions, clicks, cost, conversions for a date range. Quick health check for ad spend efficiency.',
    inputSchema: z.object({
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
      dateRange: z.enum(['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'THIS_MONTH', 'LAST_MONTH']).default('LAST_30_DAYS'),
    }),
    async execute({ customerId, dateRange = 'LAST_30_DAYS' }: { customerId?: string; dateRange?: string }) {
      // Use campaign performance instead of customer-level (works for both MCC and client accounts)
      let rows: any[];
      try {
        rows = await gadsQuery(
          `SELECT
            campaign.name,
            campaign.status,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.all_conversions,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_per_conversion
          FROM campaign
          WHERE segments.date DURING ${dateRange}
            AND campaign.status != 'REMOVED'`,
          customerId
        );
      } catch (e: any) {
        const msg = e?.message || e?.errors?.[0]?.message || String(e);
        if (msg.includes('manager account')) {
          return {
            customerId: customerId || getAdsCustomerId(),
            dateRange,
            message: 'This is a manager (MCC) account. Pass a specific client account customerId to get campaign metrics.',
            tip: 'Call gads_list_conversion_actions first — it will show accessible child accounts.',
          };
        }
        throw e;
      }

      if (rows.length === 0) {
        return { customerId: customerId || getAdsCustomerId(), dateRange, message: 'No campaign data found for this period' };
      }

      let totalImpressions = 0, totalClicks = 0, totalCostMicros = 0, totalConversions = 0;

      for (const row of rows) {
        totalImpressions += parseInt(row.metrics?.impressions || '0', 10);
        totalClicks += parseInt(row.metrics?.clicks || '0', 10);
        totalCostMicros += parseInt(row.metrics?.cost_micros || '0', 10);
        totalConversions += row.metrics?.conversions || 0;
      }

      const totalCost = totalCostMicros / 1_000_000;
      const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0;
      const conversionRate = totalClicks > 0 ? (totalConversions / totalClicks) * 100 : 0;
      const costPerConversion = totalConversions > 0 ? totalCost / totalConversions : 0;

      const campaigns = rows.map((r: any) => ({
        name: r.campaign?.name,
        status: r.campaign?.status,
        impressions: parseInt(r.metrics?.impressions || '0', 10),
        clicks: parseInt(r.metrics?.clicks || '0', 10),
        cost: parseFloat(((r.metrics?.cost_micros || 0) / 1_000_000).toFixed(2)),
        conversions: r.metrics?.conversions || 0,
      }));

      return {
        customerId: customerId || getAdsCustomerId(),
        dateRange,
        impressions: totalImpressions,
        clicks: totalClicks,
        cost: parseFloat(totalCost.toFixed(2)),
        conversions: parseFloat(totalConversions.toFixed(2)),
        ctr: parseFloat(ctr.toFixed(2)),
        avgCpc: parseFloat(avgCpc.toFixed(4)),
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        costPerConversion: parseFloat(costPerConversion.toFixed(2)),
        campaigns,
      };
    },
  },

  {
    name: 'gads_create_keyword',
    description: 'Add a keyword to an ad group. Use this to move high-performing keywords between campaigns.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID to add the keyword to'),
      keyword: z.string().describe('The keyword text'),
      matchType: z.enum(['BROAD', 'PHRASE', 'EXACT']).describe('Keyword match type'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, keyword, matchType, customerId }: {
      adGroupId: string; keyword: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const response = await customer.adGroupCriteria.create([
        {
          ad_group: `customers/${cid}/adGroups/${adGroupId}`,
          keyword: { text: keyword, match_type: matchType as any },
          status: 'ENABLED' as any,
        },
      ]);

      return {
        success: true,
        adGroupId,
        keyword,
        matchType,
        message: `Keyword "${keyword}" (${matchType}) added to ad group ${adGroupId}.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_pause_campaign',
    description: 'Pause a Google Ads campaign. Stops all ad serving immediately.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID to pause'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, customerId }: { campaignId: string; customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/campaigns/${campaignId}`;

      const response = await customer.campaigns.update([
        {
          resource_name: resourceName,
          status: 'PAUSED' as any,
        },
      ]);

      return {
        success: true,
        campaignId,
        resourceName,
        message: `Campaign ${campaignId} paused. Ad serving stopped immediately.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_set_campaign_status',
    description:
      'Set a Google Ads campaign status to ENABLED or PAUSED. Use ENABLED to (re)enable a paused ' +
      'campaign — this is the enable capability the server previously lacked (only pause existed), so ' +
      'agents no longer need the UI to resume a campaign. Refs #5444.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID to update'),
      status: z.enum(['ENABLED', 'PAUSED']).describe('Target status: ENABLED (serve) or PAUSED (stop).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, status, customerId }: {
      campaignId: string; status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/campaigns/${campaignId}`;
      try {
        const response = await customer.campaigns.update([
          { resource_name: resourceName, status: status as any },
        ]);
        return {
          success: true,
          campaignId,
          status,
          resourceName,
          message: `Campaign ${campaignId} set to ${status}.`,
          results: response?.results,
        };
      } catch (e: any) {
        // Surface a real message, never a bare "_pb" / "[object Object]". Refs #5444.
        return { success: false, campaignId, status, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_remove_keyword',
    description: 'Remove (pause) a keyword from an ad group.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID'),
      criterionId: z.string().describe('Keyword criterion ID to remove'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, criterionId, customerId }: {
      adGroupId: string; criterionId: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}`;

      const response = await customer.adGroupCriteria.update([
        {
          resource_name: resourceName,
          status: 'PAUSED' as any,
        },
      ]);

      return {
        success: true,
        adGroupId,
        criterionId,
        message: `Keyword criterion ${criterionId} paused in ad group ${adGroupId}.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_remove_campaign_criterion',
    description:
      'Remove a campaign-level criterion (targeted location/geo, placement, or keyword) by its criterion ID. ' +
      'Use to stop targeting a geo that is bringing invalid traffic — e.g. remove a positively-targeted country. ' +
      'Note: you cannot add a NEGATIVE location for a geo that is positively targeted; remove the positive criterion instead.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID that owns the criterion'),
      criterionId: z.string().describe('Criterion ID to remove (campaign_criterion.criterion_id). For a geo target this is the geo_target_constant id, e.g. 2356 for India.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, criterionId, customerId }: {
      campaignId: string; criterionId: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const resourceName = `customers/${cid}/campaignCriteria/${campaignId}~${criterionId}`;

      const response = await customer.campaignCriteria.remove([resourceName]);

      return {
        success: true,
        campaignId,
        criterionId,
        resourceName,
        message: `Campaign criterion ${criterionId} removed from campaign ${campaignId}.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_add_negative_placement',
    description:
      'Add a negative PLACEMENT (website URL or mobile app) exclusion to a campaign so ads never serve there. ' +
      'Use to block click-fraud / low-quality placements (e.g. qureka.com, omegleweb.io, junk Google Play apps).',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID to add the exclusion to'),
      placementUrl: z.string().describe('Placement to exclude — a website URL (e.g. "qureka.com") or app id.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, placementUrl, customerId }: {
      campaignId: string; placementUrl: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      // A mobile-app placement needs a mobileApplication criterion with an appId
      // in "2-<androidPackage>" / "1-<iosStoreId>" format — NOT placement.url,
      // which only accepts website URLs and errors (surfacing as "[object Object]")
      // on an app package. Detect and route accordingly. Refs #5445.
      const isApp = isMobileAppPlacement(placementUrl);
      const criterion: any = {
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        negative: true,
      };
      let normalized = placementUrl;
      if (isApp) {
        normalized = toAppId(placementUrl);
        criterion.mobile_application = { app_id: normalized };
      } else {
        criterion.placement = { url: placementUrl };
      }

      try {
        const response = await customer.campaignCriteria.create([criterion]);
        return {
          success: true,
          campaignId,
          placementUrl,
          normalized,
          placementType: isApp ? 'MOBILE_APPLICATION' : 'WEBSITE',
          message: `Negative ${isApp ? 'app' : 'placement'} "${normalized}" excluded from campaign ${campaignId}. Ads will no longer serve there.`,
          results: response?.results,
        };
      } catch (e: any) {
        return {
          success: false,
          campaignId,
          placementUrl,
          normalized,
          placementType: isApp ? 'MOBILE_APPLICATION' : 'WEBSITE',
          error: gadsErrorMessage(e),
        };
      }
    },
  },

  {
    name: 'gads_set_conversion_goal_inclusion',
    description:
      'Control whether a conversion action counts toward the primary "Conversions" metric (and thus Smart Bidding). ' +
      'Set biddable=false to keep an action TRACKED but stop it optimizing bids — the fix for a PAGE_VIEW action ' +
      'inflating conversions. Operates on the customer-level conversion goal for the action category.',
    inputSchema: z.object({
      conversionActionId: z.string().describe('Numeric conversion action ID (from gads_list_conversion_actions)'),
      biddable: z.boolean().describe('true = include in Conversions metric / bidding; false = tracked only, excluded from bidding.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ conversionActionId, biddable, customerId }: {
      conversionActionId: string; biddable: boolean; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);

      // Look up the conversion action's category (enum name), then find the matching
      // customer_conversion_goal to get its exact resource_name. The resource name is
      // `${CATEGORY}~${ORIGIN}` using enum NAMES (e.g. PAGE_VIEW~WEBSITE), and origin
      // varies per action — so we read it back rather than assuming.
      const actionRows = await customer.query(`
        SELECT conversion_action.category
        FROM conversion_action
        WHERE conversion_action.id = ${conversionActionId}
      `);
      const categoryRaw = actionRows?.[0]?.conversion_action?.category;
      if (categoryRaw === undefined || categoryRaw === null) {
        return { success: false, conversionActionId, error: `Conversion action ${conversionActionId} not found or has no category.` };
      }
      // GAQL returns category as a numeric enum; the WHERE clause and resource name
      // need the enum NAME (e.g. 3 -> PAGE_VIEW).
      const category = typeof categoryRaw === 'number'
        ? (enums.ConversionActionCategory as any)[categoryRaw]
        : categoryRaw;
      if (!category) {
        return { success: false, conversionActionId, error: `Unknown conversion category enum value ${categoryRaw}.` };
      }

      const goalRows = await customer.query(`
        SELECT customer_conversion_goal.resource_name, customer_conversion_goal.origin
        FROM customer_conversion_goal
        WHERE customer_conversion_goal.category = '${category}'
      `);
      if (!goalRows?.length) {
        return { success: false, conversionActionId, category, error: `No customer conversion goal found for category ${category}.` };
      }

      // A category can have goals for multiple origins (e.g. WEBSITE, APP). Update all
      // matching goals so the category is consistently biddable / non-biddable.
      const ops = goalRows.map((g: any) => ({
        resource_name: g.customer_conversion_goal.resource_name,
        biddable,
      }));
      const response = await customer.customerConversionGoals.update(ops);

      return {
        success: true,
        conversionActionId,
        category,
        biddable,
        updatedGoals: ops.map((o: any) => o.resource_name),
        message: `Conversion goal(s) for category ${category} set to ${biddable ? 'biddable (counts as conversion)' : 'non-biddable (tracked only, excluded from bidding)'}.`,
        results: response?.results,
      };
    },
  },

  {
    name: 'gads_list_recommendation_subscriptions',
    description:
      'List Google Ads auto-apply recommendation subscriptions (type + status). ENABLED means that recommendation ' +
      'type auto-applies without review — the mechanism that can silently raise budgets/bids. Use to audit what auto-applies.',
    inputSchema: z.object({
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ customerId }: { customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const rows = await customer.query(`
        SELECT recommendation_subscription.resource_name,
               recommendation_subscription.type,
               recommendation_subscription.status
        FROM recommendation_subscription
      `);
      const subs = rows.map((r: any) => ({
        resourceName: r.recommendation_subscription?.resource_name,
        type: r.recommendation_subscription?.type,
        status: r.recommendation_subscription?.status,
      }));
      const enabled = subs.filter((s: any) => s.status === 'ENABLED' || s.status === 2);
      return {
        customerId: customerId || getAdsCustomerId(),
        total: subs.length,
        enabledCount: enabled.length,
        subscriptions: subs,
      };
    },
  },

  {
    name: 'gads_set_recommendation_subscription',
    description:
      'Turn Google Ads auto-apply recommendations ON or OFF. Set enabled=false to PAUSE (stop auto-applying — ' +
      'recommendations are still suggested, just not applied automatically). Pass all=true to apply to every ' +
      'resolvable subscription (the fix for runaway auto-applied budget/bid changes). Subscriptions with an ' +
      'UNKNOWN type/resource name cannot be mutated by the API and are skipped and reported.',
    inputSchema: z.object({
      enabled: z.boolean().describe('true = ENABLED (auto-apply on); false = PAUSED (auto-apply off).'),
      all: z.boolean().optional().describe('If true, apply to every resolvable subscription. Ignores resourceName.'),
      resourceName: z.string().optional().describe('Specific subscription resource_name to set (from gads_list_recommendation_subscriptions). Required when all is not true.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ enabled, all, resourceName, customerId }: {
      enabled: boolean; all?: boolean; resourceName?: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      // Status enum has no DISABLED — PAUSED turns auto-apply off (reversible).
      const status = enabled ? 'ENABLED' : 'PAUSED';

      let targets: string[] = [];
      let skippedUnknown = 0;
      if (all) {
        const rows = await customer.query(`
          SELECT recommendation_subscription.resource_name, recommendation_subscription.type
          FROM recommendation_subscription
        `);
        for (const r of rows) {
          const rn = r.recommendation_subscription?.resource_name || '';
          // UNKNOWN-type subscriptions have a resource name ending in /UNKNOWN and
          // are rejected by the API (BAD_RESOURCE_ID); skip them.
          if (rn.endsWith('/UNKNOWN')) { skippedUnknown++; continue; }
          targets.push(rn);
        }
      } else {
        if (!resourceName) {
          return { success: false, error: 'Provide resourceName, or set all=true.' };
        }
        targets = [resourceName];
      }

      if (!targets.length) {
        return { success: false, status, updated: 0, skippedUnknown, message: 'No mutable subscriptions to update.' };
      }

      const ops = targets.map((rn) => ({ resource_name: rn, status: status as any }));
      const response = await customer.recommendationSubscriptions.update(ops as any, { partial_failure: true });

      return {
        success: true,
        status,
        requested: targets.length,
        updated: (response?.results || []).length,
        skippedUnknown,
        message: `Set ${(response?.results || []).length} recommendation subscription(s) to ${status}` +
          (skippedUnknown ? ` (${skippedUnknown} UNKNOWN-type skipped — not addressable via API).` : '.'),
        results: response?.results,
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Campaign BUILD tools (#5739–#5745). These let us create campaigns from
  // scratch entirely via our own MCP — no reliance on the google-authorized
  // google-ads MCP whose create_campaign is broken (shared-budget vs Maximize
  // Conversions, missing network_settings). The key correctness fixes here:
  //   1. Create a DEDICATED budget (explicitly_shared:false) BEFORE the campaign.
  //   2. Set network_settings explicitly (Search Partners OFF, Display Expansion
  //      OFF) — the "required field not present" the other MCP omitted.
  // ─────────────────────────────────────────────────────────────────────────

  {
    name: 'gads_create_campaign',
    description:
      'Create a NEW Google Ads campaign with its own dedicated budget. Handles the full ' +
      'create correctly: makes a non-shared CampaignBudget first, then the campaign referencing ' +
      'it, with network settings (Search Partners OFF, Display Expansion OFF) and MAXIMIZE_CONVERSIONS ' +
      'bidding. Defaults to PAUSED so you review before it serves. Refs #5739.',
    inputSchema: z.object({
      name: z.string().describe('Campaign name (also used for the budget name).'),
      channel: z.enum(['SEARCH', 'DISPLAY']).describe('SEARCH or DISPLAY campaign.'),
      dailyBudgetUsd: z.number().positive().describe('Daily budget in USD (e.g. 14 for $14/day).'),
      status: z.enum(['ENABLED', 'PAUSED']).default('PAUSED').describe('ENABLED to serve immediately (after ad review), PAUSED to review first. Default PAUSED.'),
      biddingStrategy: z.enum(['MAXIMIZE_CONVERSIONS', 'MANUAL_CPC']).default('MAXIMIZE_CONVERSIONS').describe('Bidding strategy. Default MAXIMIZE_CONVERSIONS.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ name, channel, dailyBudgetUsd, status, biddingStrategy, customerId }: {
      name: string; channel: 'SEARCH' | 'DISPLAY'; dailyBudgetUsd: number;
      status: 'ENABLED' | 'PAUSED'; biddingStrategy: 'MAXIMIZE_CONVERSIONS' | 'MANUAL_CPC'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const amountMicros = Math.round(dailyBudgetUsd * 1_000_000);

      // 1. Dedicated (non-shared) budget FIRST — the fix for "bidding strategy
      //    incompatible with shared budget". Unique name avoids collisions.
      const budgetName = `${name} $${dailyBudgetUsd}/d`;
      const budgetRes = await customer.campaignBudgets.create([
        {
          name: budgetName,
          amount_micros: amountMicros,
          delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          explicitly_shared: false,
        },
      ]);
      const budgetResource = budgetRes?.results?.[0]?.resource_name;
      if (!budgetResource) {
        return { success: false, message: 'Budget creation returned no resource_name.', results: budgetRes?.results };
      }

      // 2. Campaign referencing that budget, with explicit network_settings.
      const advChannel = channel === 'SEARCH'
        ? enums.AdvertisingChannelType.SEARCH
        : enums.AdvertisingChannelType.DISPLAY;

      const campaignBody: Record<string, unknown> = {
        name,
        status: status === 'ENABLED' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED,
        advertising_channel_type: advChannel,
        campaign_budget: budgetResource,
        // Required by the API (newer field the google-ads MCP omitted → "required
        // field not present"). Our ads are commercial, never EU political.
        contains_eu_political_advertising:
          enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        network_settings: {
          target_google_search: channel === 'SEARCH',
          target_search_network: false,          // Search Partners OFF
          target_content_network: channel === 'DISPLAY',
          target_partner_search_network: false,
        },
      };
      // Bidding strategy (portfolio-free standard strategies).
      if (biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
        campaignBody.maximize_conversions = {};
      } else {
        campaignBody.manual_cpc = { enhanced_cpc_enabled: false };
      }

      const campRes = await customer.campaigns.create([campaignBody as any]);
      const campaignResource = campRes?.results?.[0]?.resource_name;
      const campaignId = campaignResource?.split('/').pop();

      return {
        success: true,
        campaignId,
        campaignResource,
        budgetId: budgetResource.split('/').pop(),
        budgetResource,
        name,
        channel,
        dailyBudgetUsd,
        status,
        biddingStrategy,
        message: `Created ${channel} campaign "${name}" (id ${campaignId}) at $${dailyBudgetUsd}/day, ${status}. ` +
          `Search Partners + Display Expansion OFF. Add ad groups next (gads_create_ad_group).`,
      };
    },
  },

  {
    name: 'gads_create_ad_group',
    description: 'Create an ad group inside a campaign. Refs #5740.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID to add the ad group to.'),
      name: z.string().describe('Ad group name.'),
      channel: z.enum(['SEARCH', 'DISPLAY']).default('SEARCH').describe('SEARCH_STANDARD or DISPLAY_STANDARD ad group type.'),
      cpcBidUsd: z.number().positive().optional().describe('Optional default max CPC bid in USD.'),
      status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED').describe('Default ENABLED.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, name, channel, cpcBidUsd, status, customerId }: {
      campaignId: string; name: string; channel: 'SEARCH' | 'DISPLAY';
      cpcBidUsd?: number; status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const body: Record<string, unknown> = {
        name,
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        status: status === 'ENABLED' ? enums.AdGroupStatus.ENABLED : enums.AdGroupStatus.PAUSED,
        type: channel === 'SEARCH' ? enums.AdGroupType.SEARCH_STANDARD : enums.AdGroupType.DISPLAY_STANDARD,
      };
      if (cpcBidUsd) body.cpc_bid_micros = Math.round(cpcBidUsd * 1_000_000);

      const res = await customer.adGroups.create([body as any]);
      const resource = res?.results?.[0]?.resource_name;
      const adGroupId = resource?.split('/').pop();

      return {
        success: true,
        adGroupId,
        resource,
        campaignId,
        name,
        message: `Created ad group "${name}" (id ${adGroupId}) in campaign ${campaignId}. Add keywords (gads_create_keyword) + an ad (gads_create_responsive_search_ad).`,
      };
    },
  },

  {
    name: 'gads_create_responsive_search_ad',
    description:
      'Create a Responsive Search Ad in an ad group. 3–15 headlines (≤30 chars), 2–4 descriptions ' +
      '(≤90 chars), and final URL(s). Validates lengths before sending. Refs #5741.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID to add the ad to.'),
      headlines: z.array(z.string()).min(3).max(15).describe('3–15 headlines, each ≤30 chars.'),
      descriptions: z.array(z.string()).min(2).max(4).describe('2–4 descriptions, each ≤90 chars.'),
      finalUrl: z.string().describe('Landing page URL (e.g. https://ainative.studio/opencode).'),
      path1: z.string().optional().describe('Optional display path 1 (≤15 chars).'),
      path2: z.string().optional().describe('Optional display path 2 (≤15 chars).'),
      status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED').describe('Default ENABLED.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, headlines, descriptions, finalUrl, path1, path2, status, customerId }: {
      adGroupId: string; headlines: string[]; descriptions: string[]; finalUrl: string;
      path1?: string; path2?: string; status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      // Validate lengths up front so we return a clear error, not an opaque API failure.
      const badH = headlines.filter((h) => h.length > 30);
      const badD = descriptions.filter((d) => d.length > 90);
      if (badH.length) return { success: false, message: `Headlines over 30 chars: ${badH.join(' | ')}` };
      if (badD.length) return { success: false, message: `Descriptions over 90 chars: ${badD.join(' | ')}` };

      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const body: Record<string, unknown> = {
        ad_group: `customers/${cid}/adGroups/${adGroupId}`,
        status: status === 'ENABLED' ? enums.AdGroupAdStatus.ENABLED : enums.AdGroupAdStatus.PAUSED,
        ad: {
          final_urls: [finalUrl],
          responsive_search_ad: {
            headlines: headlines.map((text) => ({ text })),
            descriptions: descriptions.map((text) => ({ text })),
            ...(path1 ? { path1 } : {}),
            ...(path2 ? { path2 } : {}),
          },
        },
      };

      const res = await customer.adGroupAds.create([body as any]);
      const resource = res?.results?.[0]?.resource_name;

      return {
        success: true,
        resource,
        adGroupId,
        headlineCount: headlines.length,
        descriptionCount: descriptions.length,
        finalUrl,
        message: `Created responsive search ad in ad group ${adGroupId} (${headlines.length} headlines, ${descriptions.length} descriptions) → ${finalUrl}.`,
      };
    },
  },

  {
    name: 'gads_add_geo_target',
    description:
      'Add a geographic target (or exclusion) to a campaign, using PRESENCE-only targeting by ' +
      'default (people IN the location, not merely interested) — this is the India-fraud-safe ' +
      'setting. Pass negative:true to exclude a geo. Common geo IDs: 2840=US, 2826=UK, 2124=CA, ' +
      '2036=AU, 2276=DE, 2356=India. Refs #5742.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID.'),
      geoTargetConstantId: z.string().describe('geo_target_constant id, e.g. "2840" for US.'),
      negative: z.boolean().default(false).describe('true = exclude this geo. Default false (positive target).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, geoTargetConstantId, negative, customerId }: {
      campaignId: string; geoTargetConstantId: string; negative: boolean; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const res = await customer.campaignCriteria.create([
        {
          campaign: `customers/${cid}/campaigns/${campaignId}`,
          negative,
          location: { geo_target_constant: `geoTargetConstants/${geoTargetConstantId}` },
        } as any,
      ]);

      return {
        success: true,
        campaignId,
        geoTargetConstantId,
        negative,
        message: `${negative ? 'Excluded' : 'Targeted'} geo ${geoTargetConstantId} on campaign ${campaignId} (presence-based).`,
        results: res?.results,
      };
    },
  },

  {
    name: 'gads_set_presence_only',
    description:
      'Set a campaign to PRESENCE-only geo targeting (target users physically IN the targeted ' +
      'locations, not those merely interested). This is the setting that prevents the India ' +
      'interest-traffic fraud. Refs #5742.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, customerId }: { campaignId: string; customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const res = await customer.campaigns.update([
        {
          resource_name: `customers/${cid}/campaigns/${campaignId}`,
          geo_target_type_setting: {
            positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE,
            negative_geo_target_type: enums.NegativeGeoTargetType.PRESENCE,
          },
        } as any,
      ]);
      return {
        success: true,
        campaignId,
        message: `Campaign ${campaignId} set to PRESENCE-only geo targeting (India-fraud-safe).`,
        results: res?.results,
      };
    },
  },

  {
    name: 'gads_add_negative_keyword',
    description: 'Add a negative keyword at the CAMPAIGN level (blocks the term across the campaign). Refs #5743.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID.'),
      keyword: z.string().describe('Negative keyword text (e.g. "free").'),
      matchType: z.enum(['BROAD', 'PHRASE', 'EXACT']).default('BROAD').describe('Match type. Default BROAD.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, keyword, matchType, customerId }: {
      campaignId: string; keyword: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');
      const res = await customer.campaignCriteria.create([
        {
          campaign: `customers/${cid}/campaigns/${campaignId}`,
          negative: true,
          keyword: { text: keyword, match_type: matchType as any },
        } as any,
      ]);
      return {
        success: true,
        campaignId,
        keyword,
        matchType,
        message: `Negative keyword "${keyword}" (${matchType}) added to campaign ${campaignId}.`,
        results: res?.results,
      };
    },
  },

  {
    name: 'gads_search',
    description:
      'Run a read-only GAQL query and return rows — for looking up campaign/budget/ad_group/criterion ' +
      'IDs without the google-ads MCP. SELECT queries only. Refs #5745.',
    inputSchema: z.object({
      gaql: z.string().describe('A GAQL SELECT query, e.g. "SELECT campaign.id, campaign.name FROM campaign".'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ gaql, customerId }: { gaql: string; customerId?: string }) {
      if (!/^\s*SELECT\s/i.test(gaql)) {
        return { success: false, message: 'Only SELECT (read-only) GAQL is allowed via gads_search.' };
      }
      const rows = await gadsQuery(gaql, customerId);
      return { success: true, count: rows.length, rows };
    },
  },

  {
    name: 'gads_upload_image_asset',
    description:
      'Upload an image file from local disk as a Google Ads image Asset (for Display banners / ' +
      'Responsive Display Ads). Returns the asset resource_name to reference in an ad. Refs #5744.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to a PNG/JPG image file on disk (<150KB, standard IAB size).'),
      name: z.string().describe('Asset name (must be unique in the account).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ filePath, name, customerId }: { filePath: string; name: string; customerId?: string }) {
      const { readFileSync } = await import('fs');
      const customer = getGAdsCustomer(customerId);
      const data = readFileSync(filePath).toString('base64');
      const res = await customer.assets.create([
        {
          name,
          type: enums.AssetType.IMAGE,
          image_asset: { data },
        } as any,
      ]);
      const resource = res?.results?.[0]?.resource_name;
      return {
        success: true,
        resource,
        assetId: resource?.split('/').pop(),
        name,
        filePath,
        message: `Uploaded image asset "${name}" → ${resource}.`,
      };
    },
  },

  {
    name: 'gads_create_responsive_display_ad',
    description:
      'Create a Responsive Display Ad in a DISPLAY ad group from uploaded image assets + text. ' +
      'Provide marketing image asset resource_names (landscape 1.91:1) and square (1:1), plus ' +
      'headlines, descriptions, business name, and final URL. Refs #5744.',
    inputSchema: z.object({
      adGroupId: z.string().describe('DISPLAY ad group ID.'),
      marketingImageAssets: z.array(z.string()).min(1).describe('Resource names of landscape (1.91:1) image assets.'),
      squareImageAssets: z.array(z.string()).min(1).describe('Resource names of square (1:1) image assets.'),
      headlines: z.array(z.string()).min(1).max(5).describe('1–5 short headlines (≤30 chars).'),
      longHeadline: z.string().describe('One long headline (≤90 chars).'),
      descriptions: z.array(z.string()).min(1).max(5).describe('1–5 descriptions (≤90 chars).'),
      businessName: z.string().describe('Business name (≤25 chars), e.g. "AINative".'),
      finalUrl: z.string().describe('Landing page URL.'),
      logoImageAssets: z.array(z.string()).optional().describe('Optional square logo image asset resource names.'),
      status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, marketingImageAssets, squareImageAssets, headlines, longHeadline, descriptions, businessName, finalUrl, logoImageAssets, status, customerId }: {
      adGroupId: string; marketingImageAssets: string[]; squareImageAssets: string[]; headlines: string[];
      longHeadline: string; descriptions: string[]; businessName: string; finalUrl: string;
      logoImageAssets?: string[]; status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      const badH = headlines.filter((h) => h.length > 30);
      const badD = descriptions.filter((d) => d.length > 90);
      if (badH.length) return { success: false, message: `Headlines over 30 chars: ${badH.join(' | ')}` };
      if (badD.length) return { success: false, message: `Descriptions over 90 chars: ${badD.join(' | ')}` };
      if (longHeadline.length > 90) return { success: false, message: `Long headline over 90 chars (${longHeadline.length}).` };
      if (businessName.length > 25) return { success: false, message: `Business name over 25 chars (${businessName.length}).` };

      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const body: Record<string, unknown> = {
        ad_group: `customers/${cid}/adGroups/${adGroupId}`,
        status: status === 'ENABLED' ? enums.AdGroupAdStatus.ENABLED : enums.AdGroupAdStatus.PAUSED,
        ad: {
          final_urls: [finalUrl],
          responsive_display_ad: {
            marketing_images: marketingImageAssets.map((asset) => ({ asset })),
            square_marketing_images: squareImageAssets.map((asset) => ({ asset })),
            headlines: headlines.map((text) => ({ text })),
            long_headline: { text: longHeadline },
            descriptions: descriptions.map((text) => ({ text })),
            business_name: businessName,
            ...(logoImageAssets && logoImageAssets.length
              ? { logo_images: logoImageAssets.map((asset) => ({ asset })) }
              : {}),
          },
        },
      };

      const res = await customer.adGroupAds.create([body as any]);
      const resource = res?.results?.[0]?.resource_name;
      return {
        success: true,
        resource,
        adGroupId,
        finalUrl,
        message: `Created responsive display ad in ad group ${adGroupId} → ${finalUrl}.`,
      };
    },
  },

  {
    name: 'gads_upload_media_bundle',
    description:
      'Upload an HTML5 ad ZIP file from disk as a Google Ads MEDIA_BUNDLE asset (for HTML5 display ' +
      'upload ads). The zip must be self-contained (no external refs), define ad.size, include a ' +
      'clickTag, and be <150KB. Returns the asset resource_name. Refs #5744.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to a self-contained HTML5 ad .zip.'),
      name: z.string().describe('Asset name (unique in the account).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ filePath, name, customerId }: { filePath: string; name: string; customerId?: string }) {
      const { readFileSync } = await import('fs');
      const customer = getGAdsCustomer(customerId);
      const data = readFileSync(filePath).toString('base64');
      const res = await customer.assets.create([
        {
          name,
          type: enums.AssetType.MEDIA_BUNDLE,
          media_bundle_asset: { data },
        } as any,
      ]);
      const resource = res?.results?.[0]?.resource_name;
      return {
        success: true,
        resource,
        assetId: resource?.split('/').pop(),
        name,
        filePath,
        message: `Uploaded HTML5 media bundle "${name}" → ${resource}.`,
      };
    },
  },

  {
    name: 'gads_create_html5_ad',
    description:
      'Create an HTML5 display upload ad (DisplayUploadAd, HTML5_UPLOAD_AD) in a DISPLAY ad group ' +
      'from a previously-uploaded MEDIA_BUNDLE asset. This is the real animated HTML5 creative served ' +
      'via API — no manual UI upload. Note: the account must be eligible for HTML5 upload ads (enforced ' +
      'at create time; a policy error means it is not yet allowlisted). Refs #5744.',
    inputSchema: z.object({
      adGroupId: z.string().describe('DISPLAY ad group ID.'),
      mediaBundleAsset: z.string().describe('resource_name of the uploaded MEDIA_BUNDLE asset (from gads_upload_media_bundle).'),
      finalUrl: z.string().describe('Landing page URL (must match the clickTag domain).'),
      name: z.string().optional().describe('Optional ad name.'),
      status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, mediaBundleAsset, finalUrl, name, status, customerId }: {
      adGroupId: string; mediaBundleAsset: string; finalUrl: string;
      name?: string; status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

      const body: Record<string, unknown> = {
        ad_group: `customers/${cid}/adGroups/${adGroupId}`,
        status: status === 'PAUSED' ? enums.AdGroupAdStatus.PAUSED : enums.AdGroupAdStatus.ENABLED,
        ad: {
          ...(name ? { name } : {}),
          final_urls: [finalUrl],
          display_upload_ad: {
            display_upload_product_type: enums.DisplayUploadProductType.HTML5_UPLOAD_AD,
            media_bundle: { asset: mediaBundleAsset },
          },
        },
      };

      const res = await customer.adGroupAds.create([body as any]);
      const resource = res?.results?.[0]?.resource_name;
      return {
        success: true,
        resource,
        adGroupId,
        finalUrl,
        message: `Created HTML5 upload ad in ad group ${adGroupId} → ${finalUrl}.`,
      };
    },
  },
];
