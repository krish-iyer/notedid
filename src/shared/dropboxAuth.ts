import { sha256Bytes } from './sha256.ts';

/**
 * Letting the app use someone's Dropbox: OAuth with PKCE, so the app needs no secret. The app
 * makes a random verifier and sends its hash with the person to Dropbox; Dropbox shows them a code
 * to paste back into the app, which trades it (with the verifier) for tokens. No redirect: that
 * works the same on a laptop, on a phone, and in an app installed to a home screen.
 */

export const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A random verifier, and the challenge for it (its SHA-256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(globalThis.crypto.getRandomValues(new Uint8Array(48)));
  return { verifier, challenge: base64url(sha256Bytes(verifier)) };
}

/** Where to send someone to let the app in; with offline access, so the app can renew its access by itself. */
export function authorizeUrl(appKey: string, challenge: string): string {
  const params = new URLSearchParams({ client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
  return `${AUTHORIZE_URL}?${params}`;
}
