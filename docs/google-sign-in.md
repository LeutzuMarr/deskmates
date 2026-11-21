# Google sign-in (one-time setup for whoever builds Deskmates)

Users connect Google with one button: **Extras → Connectors → Google account → Sign in with Google**.
Their browser opens Google's own sign-in page, they pick an account and allow access, and Deskmates
is connected. Gmail, Google Calendar and Google Drive then work for the Work tab's assistant under the
tool names the operating prompt uses (`mcp__Gmail__…`, `mcp__Google_Calendar__…`, `mcp__Google_Drive__…`).

Google only lets an app ask for that access through an OAuth client the app owns. Make it once:

1. Open <https://console.cloud.google.com/> and create a project (for example "Deskmates").
2. **APIs & Services → Library**: enable **Gmail API**, **Google Calendar API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience):
   - App name "Deskmates", your support email.
   - Audience: **External**. While the app is in *Testing*, add every Google account that will sign in
     under **Test users** (up to 100).
   - Data access: add the scopes `gmail.modify`, `calendar`, `drive` (plus `openid`, `email`).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Desktop app**.
   Download the JSON (`client_secret_….json`).
5. In Deskmates: **Extras → Connectors → Google account → Load client file…** and pick that JSON.
   The button changes to **Sign in with Google**.

To ship it inside a build instead, set `DESKMATES_GOOGLE_CLIENT_ID` and
`DESKMATES_GOOGLE_CLIENT_SECRET` in the environment the app starts with. (For a Desktop app client
Google does not treat the secret as confidential; the sign-in is protected with PKCE.)

## What users see

- While the app is in *Testing*, Google shows "Google hasn't verified this app". Test users press
  **Continue**. Sign-ins from accounts not on the test-user list are refused.
- Gmail access is a *restricted* scope: to let anyone sign in without that warning, the app must go
  through Google's verification (and, for Gmail, a security assessment).
- Access lasts until the user presses **Disconnect** in Deskmates or removes Deskmates at
  <https://myaccount.google.com/permissions>. Apps in *Testing* get refresh tokens that Google expires
  after 7 days; publish the app (Audience → In production) to avoid weekly re-sign-ins.

## Safety

Reading mail, calendars and files runs without asking. Sending, replying, forwarding, deleting drafts
or labels, trashing or sharing Drive files, and creating, changing, deleting or answering calendar
events always ask the user first. The refresh token is stored encrypted with Windows DPAPI.
