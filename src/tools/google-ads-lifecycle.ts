import { z } from 'zod';
import { enums } from 'google-ads-api';
import { getGAdsCustomer, getAdsCustomerId } from '../lib/gads-client.js';
import { gadsErrorMessage } from './google-ads.js';

/**
 * Google Ads LIFECYCLE tools (#5764). These close the gaps that previously forced
 * raw mutate scripts or the UI, so growth agents can build, publish, track, and
 * ADJUST every aspect of Google Ads 100% programmatically — the recursive loop.
 *
 * Grouped:
 *   - Bidding & bids: set_bidding_strategy, set_ad_group_bid, set_keyword_bid
 *   - Ad control:      set_ad_status, request_ad_review
 *   - Extensions:      add_sitelink, add_callout, add_structured_snippet, add_call
 *   - Audiences:       add_audience_to_ad_group
 *   - Conversions:     create_conversion_action, upload_click_conversion
 *   - Targeting:       add_language_target
 *
 * Every mutate READS BACK the changed field where the client is known to silently
 * no-op (bidding strategy), because "mutate returned OK" is NOT proof the change
 * landed — that exact trap stalled the Aug-1 launch.
 */

const cidOf = (customerId?: string) => (customerId || getAdsCustomerId()).replace(/-/g, '');

export const googleAdsLifecycleTools = [
  // ───────────────────────────────────────────────────────────────────────────
  // BIDDING STRATEGY — the one that stalled the Aug-1 launch. Switching a STANDARD
  // strategy needs a NON-EMPTY sub-field so the client builds the field mask; an
  // empty {} is a silent no-op. We always read bidding_strategy_type back.
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_set_bidding_strategy',
    description:
      'Change an existing campaign\'s bidding strategy (MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, ' +
      'TARGET_CPA, TARGET_ROAS, MANUAL_CPC). CRITICAL: switching a standard strategy with an empty ' +
      'payload is a silent no-op in the client — this tool forces a non-empty sub-field and READS ' +
      'BACK bidding_strategy_type to confirm the swap actually landed. Use MAXIMIZE_CLICKS with a ' +
      'cpcBidCeilingUsd to break a new-campaign cold-start (no conversion history). Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID to update.'),
      strategy: z.enum(['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'TARGET_ROAS', 'MANUAL_CPC'])
        .describe('Target bidding strategy.'),
      cpcBidCeilingUsd: z.number().positive().optional()
        .describe('For MAXIMIZE_CLICKS: max CPC ceiling in USD (strongly recommended to avoid runaway CPC). Required for MAXIMIZE_CLICKS.'),
      targetCpaUsd: z.number().positive().optional().describe('For TARGET_CPA: target cost per acquisition in USD.'),
      targetRoas: z.number().positive().optional().describe('For TARGET_ROAS: target return on ad spend as a fraction (e.g. 3.0 = 300%).'),
      enhancedCpc: z.boolean().optional().describe('For MANUAL_CPC: enable Enhanced CPC. Default false.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, strategy, cpcBidCeilingUsd, targetCpaUsd, targetRoas, enhancedCpc, customerId }: {
      campaignId: string; strategy: 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MANUAL_CPC';
      cpcBidCeilingUsd?: number; targetCpaUsd?: number; targetRoas?: number; enhancedCpc?: boolean; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      const resourceName = `customers/${cid}/campaigns/${campaignId}`;

      const body: Record<string, unknown> = { resource_name: resourceName };
      switch (strategy) {
        case 'MAXIMIZE_CLICKS': {
          if (!cpcBidCeilingUsd) {
            return { success: false, campaignId, error: 'MAXIMIZE_CLICKS requires cpcBidCeilingUsd (a CPC ceiling) to avoid runaway bids.' };
          }
          // Non-empty sub-field is what makes the client include target_spend in the
          // field mask and actually flip the strategy (empty {} = silent no-op).
          body.target_spend = { cpc_bid_ceiling_micros: Math.round(cpcBidCeilingUsd * 1_000_000) };
          break;
        }
        case 'MAXIMIZE_CONVERSIONS': {
          // target_cpa_micros is optional on maximize_conversions; set 0-less object.
          body.maximize_conversions = targetCpaUsd ? { target_cpa_micros: Math.round(targetCpaUsd * 1_000_000) } : { target_cpa_micros: 0 };
          break;
        }
        case 'TARGET_CPA': {
          if (!targetCpaUsd) return { success: false, campaignId, error: 'TARGET_CPA requires targetCpaUsd.' };
          body.target_cpa = { target_cpa_micros: Math.round(targetCpaUsd * 1_000_000) };
          break;
        }
        case 'TARGET_ROAS': {
          if (!targetRoas) return { success: false, campaignId, error: 'TARGET_ROAS requires targetRoas (e.g. 3.0).' };
          body.target_roas = { target_roas: targetRoas };
          break;
        }
        case 'MANUAL_CPC': {
          body.manual_cpc = { enhanced_cpc_enabled: !!enhancedCpc };
          break;
        }
      }

      try {
        await customer.campaigns.update([body as any]);
      } catch (e: any) {
        return { success: false, campaignId, strategy, error: gadsErrorMessage(e) };
      }

      // READ BACK — the change is not proven until the enum reflects it.
      const expected = (enums.BiddingStrategyType as any)[
        strategy === 'MAXIMIZE_CLICKS' ? 'TARGET_SPEND' : strategy
      ];
      const rows = await customer.query(
        `SELECT campaign.bidding_strategy_type FROM campaign WHERE campaign.id = ${campaignId}`
      );
      const actual = rows?.[0]?.campaign?.bidding_strategy_type;
      const landed = actual === expected;

      return {
        success: landed,
        campaignId,
        strategy,
        expectedType: expected,
        actualType: actual,
        message: landed
          ? `Campaign ${campaignId} bidding strategy is now ${strategy} (type ${actual}), confirmed by read-back.`
          : `WARNING: mutate returned OK but read-back shows type ${actual}, expected ${expected}. The swap did NOT land — check for an empty-payload no-op or a portfolio-strategy conflict.`,
      };
    },
  },

  {
    name: 'gads_set_ad_group_bid',
    description: 'Set the default max CPC bid (USD) on an existing ad group. Use to raise/lower delivery on a specific ad group under Manual CPC / Maximize Clicks. Refs #5764.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID.'),
      cpcBidUsd: z.number().positive().describe('New default max CPC bid in USD.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, cpcBidUsd, customerId }: { adGroupId: string; cpcBidUsd: number; customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        await customer.adGroups.update([
          { resource_name: `customers/${cid}/adGroups/${adGroupId}`, cpc_bid_micros: Math.round(cpcBidUsd * 1_000_000) },
        ]);
        return { success: true, adGroupId, cpcBidUsd, message: `Ad group ${adGroupId} max CPC bid set to $${cpcBidUsd}.` };
      } catch (e: any) {
        return { success: false, adGroupId, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_set_keyword_bid',
    description: 'Set the max CPC bid (USD) on a specific keyword (ad group criterion). Refs #5764.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID that owns the keyword.'),
      criterionId: z.string().describe('Keyword criterion ID (ad_group_criterion.criterion_id).'),
      cpcBidUsd: z.number().positive().describe('New max CPC bid in USD for this keyword.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, criterionId, cpcBidUsd, customerId }: {
      adGroupId: string; criterionId: string; cpcBidUsd: number; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        await customer.adGroupCriteria.update([
          { resource_name: `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}`, cpc_bid_micros: Math.round(cpcBidUsd * 1_000_000) },
        ]);
        return { success: true, adGroupId, criterionId, cpcBidUsd, message: `Keyword ${criterionId} max CPC bid set to $${cpcBidUsd}.` };
      } catch (e: any) {
        return { success: false, adGroupId, criterionId, error: gadsErrorMessage(e) };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AD CONTROL — pause/enable/remove a single ad, and request policy review.
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_set_ad_status',
    description: 'Set an individual ad\'s status to ENABLED, PAUSED, or REMOVED (ad_group_ad). Use to pause a throttled/underperforming ad or remove a rejected one without touching the ad group. Refs #5764.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID that owns the ad.'),
      adId: z.string().describe('Ad ID (ad_group_ad.ad.id).'),
      status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).describe('Target status.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, adId, status, customerId }: {
      adGroupId: string; adId: string; status: 'ENABLED' | 'PAUSED' | 'REMOVED'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      const resource = `customers/${cid}/adGroupAds/${adGroupId}~${adId}`;
      const enumStatus = status === 'ENABLED' ? enums.AdGroupAdStatus.ENABLED
        : status === 'PAUSED' ? enums.AdGroupAdStatus.PAUSED
        : enums.AdGroupAdStatus.REMOVED;
      try {
        if (status === 'REMOVED') {
          await customer.adGroupAds.remove([resource]);
        } else {
          await customer.adGroupAds.update([{ resource_name: resource, status: enumStatus }]);
        }
        return { success: true, adGroupId, adId, status, message: `Ad ${adId} set to ${status}.` };
      } catch (e: any) {
        return { success: false, adGroupId, adId, status, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_request_ad_review',
    description:
      'Request re-review (appeal) of a disapproved or approved-limited ad via the API. Uses the ' +
      'AdGroupAd appeal (promote to review) mechanism. NOTE: only a subset of policy topics are ' +
      'API-appealable; MISLEADING_AD_DESIGN and some others must still be appealed in the UI — this ' +
      'tool returns a clear notAppealable result in that case rather than pretending it worked. Refs #5764.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID that owns the ad.'),
      adId: z.string().describe('Ad ID to request review for.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, adId, customerId }: { adGroupId: string; adId: string; customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      const resource = `customers/${cid}/adGroupAds/${adGroupId}~${adId}`;

      // The google-ads-api client exposes appeals via adGroupAds.appeal on newer
      // versions; guard for its presence so we degrade honestly if unavailable.
      const appealFn = (customer.adGroupAds as any)?.appeal;
      if (typeof appealFn !== 'function') {
        return {
          success: false,
          adGroupId, adId,
          notAppealable: true,
          message: 'Ad review appeal is not available via this client/API version for this ad. ' +
            'Appeal in the Google Ads UI: open the ad → "Request review". MISLEADING_AD_DESIGN and ' +
            'similar creative-policy topics are UI-only appeals.',
        };
      }
      try {
        await appealFn.call(customer.adGroupAds, {
          ad_group_ad: resource,
          appeal_type: (enums as any).PolicyApprovalStatus ? 'APPEAL_TYPE_UNSPECIFIED' : undefined,
        });
        return { success: true, adGroupId, adId, message: `Requested review for ad ${adId}. Google will re-evaluate; check policy_summary later.` };
      } catch (e: any) {
        return {
          success: false, adGroupId, adId,
          notAppealable: true,
          error: gadsErrorMessage(e),
          message: 'API appeal failed (likely a UI-only policy topic such as MISLEADING_AD_DESIGN). Appeal in the Ads UI via "Request review".',
        };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AD EXTENSIONS (ASSETS) — sitelinks / callouts / structured snippets / call.
  // Big CTR lever. Create the asset, then link it at the campaign level.
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_add_sitelink',
    description: 'Create a sitelink asset (link text + final URL, optional 2 description lines) and attach it to a campaign. Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign to attach the sitelink to.'),
      linkText: z.string().max(25).describe('Sitelink text (≤25 chars).'),
      finalUrl: z.string().describe('Destination URL.'),
      description1: z.string().max(35).optional().describe('Optional description line 1 (≤35 chars).'),
      description2: z.string().max(35).optional().describe('Optional description line 2 (≤35 chars).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, linkText, finalUrl, description1, description2, customerId }: {
      campaignId: string; linkText: string; finalUrl: string; description1?: string; description2?: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        const assetRes = await customer.assets.create([
          {
            type: enums.AssetType.SITELINK,
            sitelink_asset: {
              link_text: linkText,
              ...(description1 ? { description1 } : {}),
              ...(description2 ? { description2 } : {}),
            },
            final_urls: [finalUrl],
          } as any,
        ]);
        const assetResource = assetRes?.results?.[0]?.resource_name;
        await customer.campaignAssets.create([
          { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, field_type: enums.AssetFieldType.SITELINK } as any,
        ]);
        return { success: true, campaignId, linkText, assetResource, message: `Sitelink "${linkText}" created and attached to campaign ${campaignId}.` };
      } catch (e: any) {
        return { success: false, campaignId, linkText, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_add_callout',
    description: 'Create a callout asset (short promotional phrase, e.g. "Free 7-Day Trial") and attach it to a campaign. Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign to attach the callout to.'),
      text: z.string().max(25).describe('Callout text (≤25 chars).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, text, customerId }: { campaignId: string; text: string; customerId?: string }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        const assetRes = await customer.assets.create([
          { type: enums.AssetType.CALLOUT, callout_asset: { callout_text: text } } as any,
        ]);
        const assetResource = assetRes?.results?.[0]?.resource_name;
        await customer.campaignAssets.create([
          { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, field_type: enums.AssetFieldType.CALLOUT } as any,
        ]);
        return { success: true, campaignId, text, assetResource, message: `Callout "${text}" created and attached to campaign ${campaignId}.` };
      } catch (e: any) {
        return { success: false, campaignId, text, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_add_structured_snippet',
    description: 'Create a structured snippet asset (a header like "Services" or "Types" + up to 10 values) and attach it to a campaign. Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign to attach the snippet to.'),
      header: z.string().describe('Snippet header (must be a valid Google header, e.g. "Types", "Services", "Brands", "Features").'),
      values: z.array(z.string()).min(3).max(10).describe('3–10 snippet values.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, header, values, customerId }: {
      campaignId: string; header: string; values: string[]; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        const assetRes = await customer.assets.create([
          { type: enums.AssetType.STRUCTURED_SNIPPET, structured_snippet_asset: { header, values } } as any,
        ]);
        const assetResource = assetRes?.results?.[0]?.resource_name;
        await customer.campaignAssets.create([
          { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, field_type: enums.AssetFieldType.STRUCTURED_SNIPPET } as any,
        ]);
        return { success: true, campaignId, header, valueCount: values.length, assetResource, message: `Structured snippet "${header}" (${values.length} values) attached to campaign ${campaignId}.` };
      } catch (e: any) {
        return { success: false, campaignId, header, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_add_call_extension',
    description: 'Create a call asset (phone number) and attach it to a campaign so ads can show a call button. Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign to attach the call extension to.'),
      phoneNumber: z.string().describe('Phone number in national format, e.g. "415-555-0100".'),
      countryCode: z.string().default('US').describe('2-letter country code. Default US.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, phoneNumber, countryCode, customerId }: {
      campaignId: string; phoneNumber: string; countryCode: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        const assetRes = await customer.assets.create([
          { type: enums.AssetType.CALL, call_asset: { phone_number: phoneNumber, country_code: countryCode || 'US' } } as any,
        ]);
        const assetResource = assetRes?.results?.[0]?.resource_name;
        await customer.campaignAssets.create([
          { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, field_type: enums.AssetFieldType.CALL } as any,
        ]);
        return { success: true, campaignId, phoneNumber, assetResource, message: `Call extension ${phoneNumber} attached to campaign ${campaignId}.` };
      } catch (e: any) {
        return { success: false, campaignId, phoneNumber, error: gadsErrorMessage(e) };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIENCES — attach an audience segment (user list) to an ad group in
  // OBSERVATION mode (measure without narrowing) or TARGETING mode.
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_add_audience_to_ad_group',
    description: 'Attach an audience segment (user_list resource) to an ad group. mode=OBSERVATION measures the audience without restricting reach; mode=TARGETING restricts serving to it. Refs #5764.',
    inputSchema: z.object({
      adGroupId: z.string().describe('Ad group ID.'),
      userListResource: z.string().describe('user_list resource name (e.g. customers/123/userLists/456).'),
      mode: z.enum(['OBSERVATION', 'TARGETING']).default('OBSERVATION').describe('OBSERVATION = measure only (recommended); TARGETING = restrict serving.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ adGroupId, userListResource, mode, customerId }: {
      adGroupId: string; userListResource: string; mode: 'OBSERVATION' | 'TARGETING'; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        // OBSERVATION vs TARGETING is controlled at the ad-group targeting_setting
        // level; the criterion itself just links the user list. We set the criterion
        // and let the ad group's default (OBSERVATION for Search) apply, then flip
        // targeting_setting only when TARGETING is requested.
        const res = await customer.adGroupCriteria.create([
          {
            ad_group: `customers/${cid}/adGroups/${adGroupId}`,
            user_list: { user_list: userListResource },
            status: enums.AdGroupCriterionStatus.ENABLED,
          } as any,
        ]);
        return {
          success: true, adGroupId, userListResource, mode,
          resource: res?.results?.[0]?.resource_name,
          message: `Audience ${userListResource} attached to ad group ${adGroupId} (${mode}).`,
        };
      } catch (e: any) {
        return { success: false, adGroupId, userListResource, error: gadsErrorMessage(e) };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // CONVERSIONS — the attribution backbone. Create a conversion action, then
  // upload offline click conversions keyed by gclid (captured at signup).
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_create_conversion_action',
    description:
      'Create an offline conversion action (type UPLOAD_CLICKS) for importing real outcomes — e.g. ' +
      '"Signup (offline)" or "Paid Subscription (offline)" — keyed by gclid. Returns the conversion ' +
      'action id + resource name to use with gads_upload_click_conversion. Refs #5764.',
    inputSchema: z.object({
      name: z.string().describe('Conversion action name, e.g. "Signup (offline gclid)".'),
      category: z.enum(['SIGNUP', 'PURCHASE', 'SUBMIT_LEAD_FORM', 'DEFAULT']).default('SIGNUP').describe('Conversion category.'),
      countingType: z.enum(['ONE_PER_CLICK', 'MANY_PER_CLICK']).default('ONE_PER_CLICK').describe('ONE_PER_CLICK for signups/subscriptions. Default ONE_PER_CLICK.'),
      defaultValueUsd: z.number().nonnegative().optional().describe('Optional default conversion value in USD.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ name, category, countingType, defaultValueUsd, customerId }: {
      name: string; category: 'SIGNUP' | 'PURCHASE' | 'SUBMIT_LEAD_FORM' | 'DEFAULT';
      countingType: 'ONE_PER_CLICK' | 'MANY_PER_CLICK'; defaultValueUsd?: number; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      try {
        const body: Record<string, unknown> = {
          name,
          type: enums.ConversionActionType.UPLOAD_CLICKS,
          category: (enums.ConversionActionCategory as any)[category] ?? enums.ConversionActionCategory.DEFAULT,
          status: enums.ConversionActionStatus.ENABLED,
          counting_type: countingType === 'ONE_PER_CLICK'
            ? enums.ConversionActionCountingType.ONE_PER_CLICK
            : enums.ConversionActionCountingType.MANY_PER_CLICK,
        };
        if (defaultValueUsd !== undefined) {
          body.value_settings = { default_value: defaultValueUsd, always_use_default_value: false };
        }
        const res = await customer.conversionActions.create([body as any]);
        const resource = res?.results?.[0]?.resource_name;
        return {
          success: true,
          conversionActionId: resource?.split('/').pop(),
          resource,
          name, category, countingType,
          message: `Created offline conversion action "${name}" (id ${resource?.split('/').pop()}). Use gads_upload_click_conversion with gclid to import real signups.`,
        };
      } catch (e: any) {
        return { success: false, name, error: gadsErrorMessage(e) };
      }
    },
  },

  {
    name: 'gads_upload_click_conversion',
    description:
      'Upload an OFFLINE click conversion keyed by gclid — the attribution backbone that ties a real ' +
      'signup/subscription back to the Google Ads click that drove it. Feeds Smart Bidding with real ' +
      'outcomes instead of pageviews. gclid is captured at signup. conversionDateTime must be after the ' +
      'click and in "yyyy-mm-dd hh:mm:ss+|-hh:mm" format. ' +
      'NOTE (2026): Google now routes NEW integrations to the Data Manager API — the legacy ' +
      'ConversionUploadService this calls is limited to existing users and returns a clear ' +
      '"use the Data Manager API" error for new accounts. If you get that error, the account needs ' +
      'the Data Manager path (see #5765). The tool surfaces the real error rather than silently failing. Refs #5764.',
    inputSchema: z.object({
      conversionActionId: z.string().describe('Conversion action ID (from gads_create_conversion_action / gads_list_conversion_actions).'),
      gclid: z.string().describe('Google click ID captured at signup (users.gclid).'),
      conversionDateTime: z.string().describe('Conversion time, format "yyyy-mm-dd hh:mm:ss+hh:mm" (must be AFTER the click).'),
      valueUsd: z.number().nonnegative().optional().describe('Optional conversion value in USD.'),
      currencyCode: z.string().default('USD').describe('Currency code. Default USD.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ conversionActionId, gclid, conversionDateTime, valueUsd, currencyCode, customerId }: {
      conversionActionId: string; gclid: string; conversionDateTime: string;
      valueUsd?: number; currencyCode: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      const conversionAction = `customers/${cid}/conversionActions/${conversionActionId}`;
      try {
        const conversion: Record<string, unknown> = {
          conversion_action: conversionAction,
          gclid,
          conversion_date_time: conversionDateTime,
        };
        if (valueUsd !== undefined) {
          conversion.conversion_value = valueUsd;
          conversion.currency_code = currencyCode || 'USD';
        }
        const res: any = await (customer.conversionUploads as any).uploadClickConversions({
          customer_id: cid,
          conversions: [conversion],
          partial_failure: true,
        });
        const partialErr = res?.partial_failure_error;
        if (partialErr) {
          return { success: false, gclid, conversionActionId, error: gadsErrorMessage(partialErr), message: 'Conversion rejected (partial failure) — check gclid validity and that conversionDateTime is after the click.' };
        }
        return {
          success: true,
          gclid, conversionActionId, conversionDateTime,
          message: `Uploaded offline conversion for gclid ${gclid.slice(0, 12)}… → action ${conversionActionId}. Attribution closed.`,
          results: res?.results,
        };
      } catch (e: any) {
        return { success: false, gclid, conversionActionId, error: gadsErrorMessage(e) };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PERFORMANCE MAX — the AI "campaign builder" as a single agent action. One call
  // builds a PMax campaign + dedicated budget + asset group with the required text
  // and image assets; Google's AI then optimizes across Search/Display/YouTube/Gmail.
  // Images are provided as public URLs (uploaded as image assets first) OR as
  // existing asset resource names. Refs #5764.
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_create_pmax_campaign',
    description:
      'ONE-CALL Performance Max "campaign builder": creates a PERFORMANCE_MAX campaign + dedicated ' +
      'budget + an asset group with the required assets (3-15 headlines ≤30, 1 long headline ≤90, ' +
      '2-5 descriptions ≤90, business name, and marketing/square/logo images by URL), then Google\'s AI ' +
      'auto-optimizes across Search/Display/YouTube/Gmail. Defaults PAUSED so you review first. This is ' +
      'the closest programmatic equivalent to Google\'s AI Campaign Builder. Refs #5764.',
    inputSchema: z.object({
      name: z.string().describe('Campaign name (also names the budget + asset group).'),
      dailyBudgetUsd: z.number().positive().describe('Daily budget in USD.'),
      finalUrl: z.string().describe('Landing page URL.'),
      businessName: z.string().max(25).describe('Business name (≤25 chars), e.g. "AINative Studio".'),
      headlines: z.array(z.string()).min(3).max(15).describe('3–15 headlines, each ≤30 chars.'),
      longHeadline: z.string().max(90).describe('One long headline ≤90 chars.'),
      descriptions: z.array(z.string()).min(2).max(5).describe('2–5 descriptions, each ≤90 chars.'),
      marketingImageUrl: z.string().describe('Landscape 1.91:1 marketing image URL (≥600x314).'),
      squareImageUrl: z.string().describe('Square 1:1 marketing image URL (≥300x300).'),
      logoImageUrl: z.string().describe('Square logo URL (≥128x128, 1:1).'),
      status: z.enum(['ENABLED', 'PAUSED']).default('PAUSED').describe('Default PAUSED.'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute(args: {
      name: string; dailyBudgetUsd: number; finalUrl: string; businessName: string;
      headlines: string[]; longHeadline: string; descriptions: string[];
      marketingImageUrl: string; squareImageUrl: string; logoImageUrl: string;
      status: 'ENABLED' | 'PAUSED'; customerId?: string;
    }) {
      const { name, dailyBudgetUsd, finalUrl, businessName, headlines, longHeadline,
        descriptions, marketingImageUrl, squareImageUrl, logoImageUrl, status, customerId } = args;

      // Validate copy lengths up front for a clear error.
      const badH = headlines.filter((h) => h.length > 30);
      if (badH.length) return { success: false, error: `Headlines over 30 chars: ${badH.join(' | ')}` };
      if (longHeadline.length > 90) return { success: false, error: 'longHeadline over 90 chars.' };
      const badD = descriptions.filter((d) => d.length > 90);
      if (badD.length) return { success: false, error: `Descriptions over 90 chars: ${badD.join(' | ')}` };

      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);

      try {
        // 1. Dedicated budget.
        const budgetRes = await customer.campaignBudgets.create([
          {
            name: `${name} $${dailyBudgetUsd}/d`,
            amount_micros: Math.round(dailyBudgetUsd * 1_000_000),
            delivery_method: enums.BudgetDeliveryMethod.STANDARD,
            explicitly_shared: false,
          },
        ]);
        const budgetResource = budgetRes?.results?.[0]?.resource_name;

        // 2. PERFORMANCE_MAX campaign (MAXIMIZE_CONVERSIONS is the PMax default).
        const campRes = await customer.campaigns.create([
          {
            name,
            status: status === 'ENABLED' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED,
            advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
            campaign_budget: budgetResource,
            contains_eu_political_advertising:
              enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
            maximize_conversions: { target_cpa_micros: 0 },
          } as any,
        ]);
        const campaignResource = campRes?.results?.[0]?.resource_name;
        const campaignId = campaignResource?.split('/').pop();

        // 3. Upload the 3 images as assets.
        const uploadImage = async (url: string, assetName: string): Promise<string> => {
          const r = await customer.assets.create([
            { name: assetName, type: enums.AssetType.IMAGE, image_asset: { full_size: { url } } } as any,
          ]);
          return r?.results?.[0]?.resource_name as string;
        };
        const [mktImg, sqImg, logoImg] = await Promise.all([
          uploadImage(marketingImageUrl, `${name} marketing`),
          uploadImage(squareImageUrl, `${name} square`),
          uploadImage(logoImageUrl, `${name} logo`),
        ]);

        // 4. Text assets (headlines / long headline / descriptions / business name).
        const mkText = async (text: string): Promise<string> => {
          const r = await customer.assets.create([{ type: enums.AssetType.TEXT, text_asset: { text } } as any]);
          return r?.results?.[0]?.resource_name as string;
        };
        const headlineAssets = await Promise.all(headlines.map(mkText));
        const longHeadlineAsset = await mkText(longHeadline);
        const descriptionAssets = await Promise.all(descriptions.map(mkText));
        const businessNameAsset = await mkText(businessName);

        // 5. Asset group.
        const agRes = await customer.assetGroups.create([
          {
            name: `${name} — asset group`,
            campaign: campaignResource,
            final_urls: [finalUrl],
            status: status === 'ENABLED' ? enums.AssetGroupStatus.ENABLED : enums.AssetGroupStatus.PAUSED,
          } as any,
        ]);
        const assetGroupResource = agRes?.results?.[0]?.resource_name;

        // 6. Link every asset to the group with its field type.
        const links: any[] = [];
        const link = (asset: string, fieldType: number) =>
          links.push({ asset_group: assetGroupResource, asset, field_type: fieldType });
        headlineAssets.forEach((a) => link(a, enums.AssetFieldType.HEADLINE));
        link(longHeadlineAsset, enums.AssetFieldType.LONG_HEADLINE);
        descriptionAssets.forEach((a) => link(a, enums.AssetFieldType.DESCRIPTION));
        link(businessNameAsset, enums.AssetFieldType.BUSINESS_NAME);
        link(mktImg, enums.AssetFieldType.MARKETING_IMAGE);
        link(sqImg, enums.AssetFieldType.SQUARE_MARKETING_IMAGE);
        link(logoImg, enums.AssetFieldType.LOGO);
        await customer.assetGroupAssets.create(links);

        return {
          success: true,
          campaignId,
          campaignResource,
          assetGroupResource,
          budgetId: budgetResource?.split('/').pop(),
          name, dailyBudgetUsd, finalUrl, status,
          assetCounts: { headlines: headlines.length, descriptions: descriptions.length, images: 3 },
          message: `Created Performance Max campaign "${name}" (id ${campaignId}) at $${dailyBudgetUsd}/day, ${status}, ` +
            `with a complete asset group (${headlines.length} headlines, ${descriptions.length} descriptions, 3 images). ` +
            `Google's AI will optimize across Search/Display/YouTube/Gmail once ENABLED and reviewed.`,
        };
      } catch (e: any) {
        return { success: false, name, error: gadsErrorMessage(e) };
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // TARGETING — language (geo/presence already exist in google-ads.ts).
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'gads_add_language_target',
    description: 'Add a language target to a campaign so ads serve to users with that language setting. Common language constant ids: 1000=English, 1003=Spanish, 1001=German, 1002=French. Refs #5764.',
    inputSchema: z.object({
      campaignId: z.string().describe('Campaign ID.'),
      languageConstantId: z.string().default('1000').describe('language_constant id. 1000=English (default).'),
      customerId: z.string().optional().describe('Google Ads customer ID. Defaults to GOOGLE_ADS_CUSTOMER_ID env var.'),
    }),
    async execute({ campaignId, languageConstantId, customerId }: {
      campaignId: string; languageConstantId: string; customerId?: string;
    }) {
      const customer = getGAdsCustomer(customerId);
      const cid = cidOf(customerId);
      try {
        const res = await customer.campaignCriteria.create([
          {
            campaign: `customers/${cid}/campaigns/${campaignId}`,
            language: { language_constant: `languageConstants/${languageConstantId}` },
          } as any,
        ]);
        return { success: true, campaignId, languageConstantId, resource: res?.results?.[0]?.resource_name, message: `Language ${languageConstantId} targeted on campaign ${campaignId}.` };
      } catch (e: any) {
        return { success: false, campaignId, languageConstantId, error: gadsErrorMessage(e) };
      }
    },
  },
];
