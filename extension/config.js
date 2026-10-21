// Settings for the "Add to Chope" extension.
export const CONFIG = {
  // Where Chope is hosted (also listed under host_permissions in manifest.json).
  CHOPE_ORIGIN: 'https://chope.vercel.app',
  // The Google OAuth client Chope's "Connect Gmail" already uses. The extension signs in through it
  // too — its redirect URI (https://<extension-id>.chromiumapp.org/) must be added to that client in
  // Google Cloud Console. See extension/README.md.
  GOOGLE_CLIENT_ID: '1052353371305-ibjabb8j5o8okn4ou5a05q8g1ta3s3li.apps.googleusercontent.com',
  // Same keys/labels as CATEGORIES in index.html. Anything else is saved as Admin by the server.
  CATEGORIES: [
    ['admin', 'Admin'], ['portfolio', 'Portfolio & Assets'], ['acq', 'Acquisitions'], ['debt', 'Debt & Capital'],
    ['ir', 'Investor Relations'], ['fund', 'Fund Raising'], ['compliance', 'Compliance & Legal'],
    ['corp', 'Corporate Development'], ['projects', 'Projects'], ['strategic', 'Strategic Initiatives'],
  ],
};
