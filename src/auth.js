// Bearer-token auth for operational endpoints.

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Constant-time bearer token check. Returns false when no token is configured. */
export async function isAuthorized(request, expectedToken) {
  if (!expectedToken) return false;
  const header = request.headers.get('Authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [a, b] = await Promise.all([sha256(supplied), sha256(expectedToken)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
