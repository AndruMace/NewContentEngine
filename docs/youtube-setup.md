# Connecting YouTube (one-time, about 10 minutes)

Sim Studio reads your channel's stats with **read-only** access. It can't upload, edit or delete anything.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>, sign in with the Google account that owns the channel.
2. Project picker (top bar) → **New project** → name it e.g. `sim-studio` → **Create**, then select it.

## 2. Enable the two APIs

**APIs & Services → Library**, search for and **Enable** each:

- **YouTube Data API v3**
- **YouTube Analytics API**

## 3. Configure the consent screen

**APIs & Services → OAuth consent screen** (may be shown as **Google Auth Platform → Branding / Audience**):

1. User type **External** → app name `Sim Studio`, your email as support and developer contact → save.
2. **Scopes / Data access**: you can skip adding scopes here; the app requests them when you connect.
3. **Audience → Publishing status → Publish app** (switch from *Testing* to **In production**).
   - This matters: in *Testing* mode Google expires the connection every **7 days**.
   - You don't need to submit for verification. You'll see an "unverified app" warning once when connecting. Click **Advanced → Go to Sim Studio (unsafe)**. It's your own app talking to your own channel.

## 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Desktop app**
- Name: `Sim Studio (local)` → **Create**

Copy the **Client ID** and **Client secret** into `.env` in the project root:

```
GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
```

`.env` is gitignored. Restart the dev server (`npm run dev`) so it picks the values up.

## 5. Connect

Open **Analytics** in Sim Studio → **Connect YouTube** → pick the channel's account → allow both permissions (YouTube and YouTube Analytics).

The connection is stored in `data/youtube-token.json` (gitignored, readable only by you). **Disconnect** on the Analytics tab revokes it.

## How posts get linked

Upload each exported video with the **exported title** (from `youtube.txt`). **Refresh stats** (or starting a batch) reads your latest 50 uploads and links exact title matches automatically. Close matches are listed under *Uploads to link* for one-click confirmation. You can also paste the video's link under **Posted** on its review card.

## What's collected, and when

| When | What |
|---|---|
| Every refresh (posts < 30 days old; weekly to 90 days) | Views, likes, comments (live), plus watch time, avg % viewed, avg duration, shares, subscribers gained/lost (lag ~2 days) |
| At 3 days, and again after 7 days | Audience-retention curve and share of views from the Shorts feed |
| By hand (optional) | "Stayed to watch" % from YouTube Studio, which isn't available through the API |

Learning uses each video's numbers at **7 days old**, so results from different days are comparable.
