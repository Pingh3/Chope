# Add to Chope — Chrome extension

One click in Gmail turns the email you're reading into a Chope task (subject, sender and a link back to the email). It appears in Chope the next time Chope is open.

## Try it yourself (about 5 minutes)

1. Chrome → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → choose this `extension` folder.
2. Note the **extension ID** Chrome shows under the extension's name.
3. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) open the OAuth client Chope already uses (the client ID is in `config.js`) and add this under **Authorised redirect URIs**:
   `https://<extension-id>.chromiumapp.org/`
   Without this, Google refuses the sign-in.
4. Open Gmail, open an email, click the Chope icon (or press **Alt+Shift+C**), sign in once, and add.

The extension ID changes between machines when loaded unpacked. For your team, publish it once so everyone gets the same ID (below).

## Giving it to colleagues

People install it themselves, so it needs to be on the Chrome Web Store:

1. Create a developer account (one-off US$5 registration fee).
2. Zip the contents of this folder and upload it as a new item.
3. Set **Visibility** to **Unlisted**, so only people with the link can install it.
4. Copy the permanent extension ID from the store listing and register `https://<that-id>.chromiumapp.org/` on the OAuth client as in step 3.

Google reviews new items, typically within a few days.

## What it can access

- **identity**: sign in with Google, to prove who you are to Chope.
- **activeTab / scripting**: read the subject and sender of the Gmail tab you're looking at, only when you click the icon.
- **storage**: remember your sign-in and your last-used category.
- **chope.vercel.app**: send the task there.

It cannot read your mail in the background, and it never sees your inbox.

## For Outlook-sync colleagues (Google Workspace Sync)

Extensions don't run in Outlook. Instead, label any email **Chope** in Gmail, or drag it into the Chope folder in Outlook (Gmail labels appear as Outlook folders). Chope picks these up while it's open and Gmail is connected.

## Files

`manifest.json` · `background.js` (sign-in) · `popup.html/css/js` (the form) · `lib.js` (pure helpers, unit tested) · `config.js` (settings) · `icons/` (made by `scripts/make-extension-icons.mjs`; replace with real artwork any time)
