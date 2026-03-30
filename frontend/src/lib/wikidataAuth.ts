// Wikimedia OAuth 2.0 (confidential client with PKCE)
//
// Flow:
// 1. Browser generates PKCE verifier, redirects user to Wikimedia authorization
// 2. User approves → Wikimedia redirects back with ?code=
// 3. Browser sends code to our backend, which exchanges it for tokens (using client secret)
// 4. Browser stores access_token + refresh_token in localStorage
// 5. All Wikidata API calls use Authorization: Bearer <token> directly from browser

const CLIENT_ID = import.meta.env.VITE_WIKIMEDIA_CLIENT_ID ?? 'c1ffa900869cdd4bb56638a48d41761a';
const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const AUTH_URL = 'https://meta.wikimedia.org/w/rest.php/oauth2/authorize';

const TOKEN_KEY = 'wm-oauth-token';
const REFRESH_KEY = 'wm-oauth-refresh';
const EXPIRY_KEY = 'wm-oauth-expiry';
const VERIFIER_KEY = 'wm-oauth-verifier';
const RETURN_KEY = 'wm-oauth-return';

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, len);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Redirect user to Wikimedia authorization page. */
export async function startOAuthLogin() {
  const verifier = randomString(64);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  // Remember where the user was so we can navigate back after callback
  sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);

  const challenge = base64url(await sha256(verifier));
  const redirectUri = `${window.location.origin}/oauth/callback`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${AUTH_URL}?${params}`;
}

/** Handle the OAuth callback — exchange code for tokens via backend. */
export async function handleOAuthCallback(code: string): Promise<boolean> {
  const redirectUri = `${window.location.origin}/oauth/callback`;
  const codeVerifier = sessionStorage.getItem(VERIFIER_KEY) ?? '';

  const res = await fetch(
    `${API_BASE}/oauth/callback?${new URLSearchParams({ code, redirect_uri: redirectUri, code_verifier: codeVerifier })}`,
  );

  if (!res.ok) {
    console.error('[oauth] token exchange failed:', await res.text());
    return false;
  }

  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem(TOKEN_KEY, data.access_token);
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
    if (data.expires_in) {
      localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
    }
    return true;
  }
  console.error('[oauth] no access_token in response:', data);
  return false;
}

/** Get the stored return path (where user was before login redirect). */
export function getReturnPath(): string {
  return sessionStorage.getItem(RETURN_KEY) ?? '/';
}

/** Get a valid access token, refreshing if expired. Returns null if not logged in. */
export async function getAccessToken(): Promise<string | null> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;

  const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
  // Refresh if expiring within 60 seconds
  if (expiry && Date.now() > expiry - 60_000) {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) {
      clearOAuthTokens();
      return null;
    }
    try {
      const res = await fetch(`${API_BASE}/oauth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        clearOAuthTokens();
        return null;
      }
      const data = await res.json();
      if (data.access_token) {
        localStorage.setItem(TOKEN_KEY, data.access_token);
        if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
        if (data.expires_in) {
          localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
        }
        return data.access_token;
      }
    } catch {
      clearOAuthTokens();
      return null;
    }
  }

  return token;
}

/** Check if user is logged in by querying Wikidata via our backend proxy. */
export async function checkOAuthLogin(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${API_BASE}/wikidata-proxy?${new URLSearchParams({
        action: 'query', meta: 'userinfo', format: 'json',
      })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    const u = data.query?.userinfo;
    return (u && !('anon' in u)) ? u.name as string : null;
  } catch {
    return null;
  }
}

/** Clear all stored OAuth tokens (logout). */
export function clearOAuthTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(RETURN_KEY);
}
