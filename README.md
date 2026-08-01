# @ainative/gtm-mcp

Google Tag Manager **and Google Ads** MCP server — audit, fix, and manage GTM containers and Google Ads campaigns, budgets, conversions, placements, geo targeting, and auto-apply recommendations from AI agents (Claude, Cursor, and any MCP client).

Part of the [AINative open-source tools](https://ainative.studio).

**57 tools** across 7 categories: accounts, tags, triggers, audit, versions/publishing, and a **complete Google Ads lifecycle** (39 tools) — build, publish, track, and adjust campaigns end-to-end: create campaigns/ad groups/RSAs/RDAs/HTML5 ads, Performance Max, bidding strategy & bid control, ad extensions (sitelinks/callouts/snippets/call), audiences, offline gclid conversion import, geo/language targeting, budgets, placements, and auto-apply recommendations — fully programmatic, no UI required.

**Keywords:** google tag manager mcp, google ads mcp, gtm mcp server, google ads api mcp, conversion tracking mcp, campaign budget management, negative placement / click-fraud exclusion, geo targeting, auto-apply recommendations, recommendation subscriptions, conversion goals, Smart Bidding, PPC automation, ad spend control, Claude MCP, model context protocol, AI agent advertising tools.

## Quick Start

### 1. Install

```bash
# Claude Code (recommended)
claude mcp add ainative-gtm-mcp npx -- -y @ainative/gtm-mcp \
  -e GTM_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json

# Or run directly
npx @ainative/gtm-mcp
```

### 2. Set up Google Cloud authentication

The server authenticates via a Google Cloud **service account** with Tag Manager API access. There is no browser OAuth flow — it's designed for headless/agent use.

#### Step 1 — Enable the Tag Manager API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Navigate to **APIs & Services → Library**
4. Search for **Tag Manager API** (`tagmanager.googleapis.com`) and click **Enable**

#### Step 2 — Create a service account

1. Go to **IAM & Admin → Service Accounts**
2. Click **Create Service Account**
3. Give it a name (e.g. `gtm-mcp-agent`)
4. Skip role assignment at GCP level — GTM has its own permission system
5. Click **Done**, then open the service account
6. Go to **Keys → Add Key → Create new key → JSON**
7. Download the JSON key file — keep it safe

#### Step 3 — Grant the service account access in GTM

This is the step most people miss. The GCP service account needs to be added as a user **inside Google Tag Manager** separately:

1. Go to [tagmanager.google.com](https://tagmanager.google.com)
2. Click **Admin** (top nav)
3. Under **Account**, click **User Management**
4. Click **+** → **Add users**
5. Enter the service account email (e.g. `gtm-mcp-agent@your-project.iam.gserviceaccount.com`)
6. Set permission to **Publish** (required for tag editing and publishing)
7. Save

> **Note:** If you only need read access (auditing), **Read** permission is sufficient.

#### Step 4 — Configure the env var

```bash
export GTM_SERVICE_ACCOUNT_KEY_PATH="/path/to/service-account.json"

# Or use inline JSON (useful for CI/CD)
export GTM_SERVICE_ACCOUNT_KEY_JSON='{"type":"service_account","project_id":"...","private_key":"..."}'

# Or use Application Default Credentials
gcloud auth application-default login
```

### 3. Connect to Claude Code

```bash
claude mcp add ainative-gtm-mcp npx -- -y @ainative/gtm-mcp \
  -e GTM_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json
```

Or add a `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "ainative-gtm-mcp": {
      "command": "npx",
      "args": ["-y", "@ainative/gtm-mcp"],
      "env": {
        "GTM_SERVICE_ACCOUNT_KEY_PATH": "/path/to/service-account.json"
      }
    }
  }
}
```

> **Security:** Add `.mcp.json` to `.gitignore` if it contains key paths. Use `.mcp.example.json` as a template for teammates.

### 4. Verify it works

Ask Claude:
```
List my GTM accounts
```

Expected: your GTM account name and ID. If you get an empty array `[]`, the service account hasn't been added to GTM yet (Step 3 above).

---

## Important: GTM vs Google Ads conversions

This MCP server manages **Google Tag Manager containers** — tags, triggers, variables, and publishing. 

If you see events like `ads_conversion_PURCHASE_1` in GA4, those may be coming from **Google Ads auto-imported conversions** (via GA4 ↔ Google Ads account linking), not GTM tags. In that case:

- If the event fires via a GTM tag → use `gtm_find_misfiring_conversion_tags` to fix it
- If the event is a GA4-imported Google Ads conversion → fix it in **Google Ads → Tools → Conversions**, not in GTM

To tell the difference: if your GTM container has no tags (`gtm_list_tags` returns `[]`), the conversion event is coming from outside GTM.

---

## Example: Fix a misfiring conversion tag

The most common GTM billing issue — a Google Ads conversion tag fires on every page view instead of only on purchase confirmation.

```
1. List your accounts:
   "List my GTM accounts"
   → accountId: 123456789

2. List containers:
   "List containers for account 123456789"
   → containerId: 987654321, publicId: GTM-XXXXXXX

3. Audit the container:
   "Audit container 987654321 in account 123456789"
   → health score, list of issues including misfiring tags

4. Find misfiring conversion tags:
   "Find misfiring conversion tags in container 987654321"
   → shows which tags fire on All Pages instead of specific events

5. Fix the tag:
   "Fix tag 42 to only fire on the purchase_confirmed event"
   → gtm_fix_conversion_tag_trigger creates a scoped Custom Event trigger
     and rewires the tag automatically

6. Review and publish:
   "Show pending workspace changes, then publish"
   → gtm_get_workspace_status + gtm_publish
```

---

## Tool Reference

### Account & Container (3 tools)

| Tool | Description |
|------|-------------|
| `gtm_list_accounts` | List all accessible GTM accounts |
| `gtm_list_containers` | List containers in an account |
| `gtm_get_container` | Get container details |

### Tags (4 tools)

| Tool | Description |
|------|-------------|
| `gtm_list_tags` | List all tags in a workspace |
| `gtm_get_tag` | Get full tag configuration |
| `gtm_update_tag` | Update a tag (trigger, params, name) |
| `gtm_delete_tag` | Delete a tag |

### Triggers (4 tools)

| Tool | Description |
|------|-------------|
| `gtm_list_triggers` | List all triggers |
| `gtm_get_trigger` | Get trigger configuration |
| `gtm_create_trigger` | Create a new trigger |
| `gtm_update_trigger` | Update an existing trigger |

### Audit & Fix (3 tools)

| Tool | Description |
|------|-------------|
| `gtm_audit_container` | Full container audit — health score 0–100, issues list |
| `gtm_find_misfiring_conversion_tags` | Find conversion tags firing on All Pages instead of specific events |
| `gtm_fix_conversion_tag_trigger` | Fix a misfiring tag — creates scoped Custom Event trigger, rewires tag |

### Versions & Publishing (4 tools)

| Tool | Description |
|------|-------------|
| `gtm_list_workspaces` | List workspaces |
| `gtm_get_workspace_status` | View pending changes before publishing |
| `gtm_create_version` | Create a named version from workspace changes |
| `gtm_publish` | Publish workspace to live |

### Google Ads (39 tools)

Full programmatic campaign lifecycle — an agent can build, launch, measure, and optimize a campaign end-to-end with no UI.

**Build (campaigns, ad groups, ads, assets)**

| Tool | Description |
|------|-------------|
| `gads_create_campaign` | Create a Search/Display campaign with a dedicated budget + correct network settings |
| `gads_create_pmax_campaign` | **One-call Performance Max builder** — campaign + budget + asset group (headlines, descriptions, images, logo) in a single call; Google's AI optimizes across Search/Display/YouTube/Gmail |
| `gads_create_ad_group` | Create an ad group inside a campaign |
| `gads_create_responsive_search_ad` | Create an RSA (3–15 headlines, 2–4 descriptions, length-validated) |
| `gads_create_responsive_display_ad` | Create a responsive display ad |
| `gads_create_html5_ad` | Create an HTML5 upload (animated) display ad from a media bundle |
| `gads_upload_image_asset` | Upload an image asset by URL |
| `gads_upload_media_bundle` | Upload an HTML5 media-bundle (zip) asset |

**Bidding & bids**

| Tool | Description |
|------|-------------|
| `gads_set_bidding_strategy` | Swap bidding strategy (Maximize Clicks / Maximize Conversions / Target CPA / Target ROAS / Manual CPC) — **reads back the change to confirm it landed** (empty-payload swaps silently no-op) |
| `gads_set_ad_group_bid` | Set an ad group's default max CPC bid |
| `gads_set_keyword_bid` | Set a specific keyword's max CPC bid |

**Ad control**

| Tool | Description |
|------|-------------|
| `gads_set_ad_status` | Pause / enable / remove an individual ad |
| `gads_request_ad_review` | Request re-review (appeal) of a disapproved/limited ad where API-appealable; honest result for UI-only policy topics |

**Ad extensions (assets)**

| Tool | Description |
|------|-------------|
| `gads_add_sitelink` | Create + attach a sitelink |
| `gads_add_callout` | Create + attach a callout (e.g. "7-Day Free Trial") |
| `gads_add_structured_snippet` | Create + attach a structured snippet |
| `gads_add_call_extension` | Create + attach a call (phone) extension |

**Audiences & conversions (attribution)**

| Tool | Description |
|------|-------------|
| `gads_add_audience_to_ad_group` | Attach a user-list audience (observation or targeting) |
| `gads_create_conversion_action` | Create an offline (UPLOAD_CLICKS) conversion action for gclid import |
| `gads_upload_click_conversion` | Upload an offline conversion keyed by gclid — ties a real signup back to the ad click that drove it |

**Conversions & reporting**

| Tool | Description |
|------|-------------|
| `gads_list_conversion_actions` | List all conversion actions — name, ID, counting type, status, category |
| `gads_update_conversion_counting` | Fix counting type (ONE_PER_CLICK vs MANY_PER_CLICK) for a conversion action |
| `gads_audit_conversion_goals` | Audit all conversion goals — find misconfigured counting, inactive conversions |
| `gads_set_conversion_goal_inclusion` | Include/exclude a conversion action from the primary Conversions metric & Smart Bidding (e.g. stop a PAGE_VIEW action inflating conversions) |
| `gads_get_account_performance` | Account-level performance — impressions, clicks, cost, conversions by date range |

**Campaigns & budgets**

| Tool | Description |
|------|-------------|
| `gads_update_campaign_budget` | Set a campaign's daily budget (scale spend up or down) |
| `gads_pause_campaign` | Pause a campaign — stop ad serving immediately |
| `gads_create_keyword` | Add a keyword to an ad group |
| `gads_remove_keyword` | Remove (pause) a keyword from an ad group |

**Targeting & fraud protection**

| Tool | Description |
|------|-------------|
| `gads_remove_campaign_criterion` | Remove a campaign criterion (targeted geo/placement/keyword) by ID — e.g. stop targeting a country sending invalid traffic |
| `gads_add_negative_placement` | Exclude a website/app placement (block click-fraud sites like quiz farms and junk apps) |
| `gads_add_geo_target` | Add a geo target (presence-only by default — the India-fraud-safe setting) |
| `gads_set_presence_only` | Force presence-only geo targeting on a campaign |
| `gads_add_negative_keyword` | Add a campaign-level negative keyword |
| `gads_add_language_target` | Add a language target to a campaign |

**Auto-apply recommendations**

| Tool | Description |
|------|-------------|
| `gads_list_recommendation_subscriptions` | List auto-apply recommendation subscriptions and their status (audit what auto-applies) |
| `gads_set_recommendation_subscription` | Turn auto-apply recommendations ON/OFF (pause budget/bid recommendations that can silently raise spend) |

#### Google Ads Authentication

The Google Ads tools use OAuth2 credentials. Provide them via environment variables or your ADC file:

```bash
# Option A: Explicit env vars
export GADS_CLIENT_ID="your-client-id"
export GADS_CLIENT_SECRET="your-client-secret"
export GADS_REFRESH_TOKEN="your-refresh-token"
export GOOGLE_ADS_DEVELOPER_TOKEN="your-developer-token"
export GOOGLE_ADS_CUSTOMER_ID="1234567890"

# Option B: Use Application Default Credentials (gcloud OAuth)
# Run: gcloud auth application-default login
# The server reads ~/.config/gcloud/application_default_credentials.json automatically
export GOOGLE_ADS_DEVELOPER_TOKEN="your-developer-token"
export GOOGLE_ADS_CUSTOMER_ID="1234567890"
```

> **Developer token:** Get yours at [Google Ads API Center](https://developers.google.com/google-ads/api/docs/first-call/dev-token). A test token works for sandbox accounts; a standard token is required for production.

> **Note on GA4-imported conversions:** If you see events like `ads_conversion_PURCHASE_1` in GA4 but `gads_list_conversion_actions` returns an empty list, those conversions are **GA4-imported** into Google Ads (configured under Google Ads → Tools → Conversions). They are not standalone conversion actions and must be managed through the Google Ads UI.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `gtm_list_accounts` returns `[]` | Service account not added to GTM | Add service account email in GTM → Admin → User Management |
| `Tag Manager API has not been used` error | API not enabled | Enable at console.cloud.google.com → APIs & Services → Tag Manager API |
| `Permission denied` on tag update | Service account has Read-only | Upgrade to Publish permission in GTM User Management |
| `gtm_list_tags` returns `[]` | Workspace is empty (no tags published) | Check a different workspaceId, or confirm tags exist in GTM dashboard |
| Conversion event in GA4 but no matching GTM tag | Event comes from Google Ads auto-import | Fix in Google Ads → Tools → Conversions, not in GTM |

---

## Development

```bash
git clone https://github.com/AINative-Studio/core
cd packages/mcp-servers/ainative-gtm-mcp
npm install
npm run build
npm run dev
```

## License

MIT — [AINative Studio](https://ainative.studio)
