export const slackUserScopes = ['channels:read', 'groups:read', 'chat:write'] as const;

export function slackRegistrationUrl(redirectUri: string) {
  const manifest = {
    display_information: { name: 'Runsett Studio' },
    oauth_config: { pkce_enabled: true, redirect_urls: [redirectUri], scopes: { user: slackUserScopes } },
    settings: { token_rotation_enabled: true },
  };
  const url = new URL('https://api.slack.com/apps');
  url.search = new URLSearchParams({ new_app: '1', manifest_json: JSON.stringify(manifest) }).toString();
  return url.href;
}
