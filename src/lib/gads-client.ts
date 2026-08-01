import { GoogleAdsApi, type Customer } from 'google-ads-api';
import { readFileSync } from 'fs';
import { homedir } from 'os';

let _customer: Customer | null = null;

function loadCreds(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = process.env.GADS_CLIENT_ID;
  const clientSecret = process.env.GADS_CLIENT_SECRET;
  const refreshToken = process.env.GADS_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken };
  }

  // Fall back to ADC file
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || `${homedir()}/.config/gcloud/application_default_credentials.json`;

  try {
    const raw = JSON.parse(readFileSync(adcPath, 'utf-8'));
    if (raw.client_id && raw.client_secret && raw.refresh_token) {
      return { clientId: raw.client_id, clientSecret: raw.client_secret, refreshToken: raw.refresh_token };
    }
  } catch { /* fall through */ }

  throw new Error(
    'Google Ads credentials not found. Set GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN env vars ' +
    `or run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/adwords`
  );
}

export function getAdsCustomerId(): string {
  return (process.env.GOOGLE_ADS_CUSTOMER_ID || '5799834262').replace(/-/g, '');
}

export function getGAdsCustomer(customerId?: string): Customer {
  const cid = (customerId || getAdsCustomerId()).replace(/-/g, '');

  // Re-use cached customer only if same CID
  if (_customer && (_customer as any)._client_args?.customer_id === cid) return _customer;

  const { clientId, clientSecret, refreshToken } = loadCreds();
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || 'PXn8PHeZqicxm2iafU3WgQ';

  const api = new GoogleAdsApi({
    client_id: clientId,
    client_secret: clientSecret,
    developer_token: developerToken,
  });

  _customer = api.Customer({
    customer_id: cid,
    refresh_token: refreshToken,
    login_customer_id: cid,
  });

  return _customer;
}

/** Execute a GAQL query and return typed rows */
export async function gadsQuery<T = Record<string, unknown>>(
  gaql: string,
  customerId?: string
): Promise<T[]> {
  const customer = getGAdsCustomer(customerId);
  const rows = await customer.query(gaql);
  return rows as unknown as T[];
}
