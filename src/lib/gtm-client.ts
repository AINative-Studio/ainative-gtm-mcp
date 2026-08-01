import { google } from 'googleapis';

export type TagManager = ReturnType<typeof google.tagmanager>;

let _client: TagManager | null = null;

export function getGTMClient(): TagManager {
  if (_client) return _client;

  const keyPath = process.env.GTM_SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.GTM_SERVICE_ACCOUNT_KEY_JSON;
  const defaultCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;

  if (keyJson) {
    const key = JSON.parse(keyJson);
    auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers',
               'https://www.googleapis.com/auth/tagmanager.readonly',
               'https://www.googleapis.com/auth/tagmanager.publish'],
    });
  } else if (keyPath || defaultCreds) {
    auth = new google.auth.GoogleAuth({
      keyFile: keyPath || defaultCreds,
      scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers',
               'https://www.googleapis.com/auth/tagmanager.readonly',
               'https://www.googleapis.com/auth/tagmanager.publish'],
    });
  } else {
    // Fall back to application default credentials (gcloud auth)
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers',
               'https://www.googleapis.com/auth/tagmanager.readonly',
               'https://www.googleapis.com/auth/tagmanager.publish'],
    });
  }

  _client = google.tagmanager({ version: 'v2', auth });
  return _client;
}

/** Helper — returns the default workspace path for a container */
export function workspacePath(accountId: string, containerId: string, workspaceId = '1') {
  return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
}
