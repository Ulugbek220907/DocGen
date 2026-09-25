const { OAuth2Client } = require('google-auth-library');
const config = require('./config');

const client = new OAuth2Client();

// Verifies a Google ID token (from the web "Sign in with Google" button or
// the Android Credential Manager) and returns the identity it asserts.
// Signature, expiry, issuer and audience are all checked by the library.
async function verifyGoogleIdToken(idToken) {
  if (!config.google.clientIds.length) {
    const err = new Error('Google sign-in is not configured on the server.');
    err.code = 'google_not_configured';
    throw err;
  }
  const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientIds });
  const p = ticket.getPayload();
  if (!p || !p.sub || !p.email) {
    const err = new Error('Google did not share an email address for this account.');
    err.code = 'google_no_email';
    throw err;
  }
  return {
    sub: p.sub,
    email: p.email.toLowerCase(),
    emailVerified: p.email_verified === true || p.email_verified === 'true',
    name: p.name || p.given_name || p.email.split('@')[0],
    picture: p.picture || null
  };
}

module.exports = { verifyGoogleIdToken };
