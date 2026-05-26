const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const SESSION_COOKIE_NAME = 'app_pointer_session'
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

export type AppSession = {
  userId: number
  username: string
  role: 'ADMIN' | 'EMPLOYE'
  expiresAt: number
}

function encodeBase64Url(value: string) {
  const bytes = encoder.encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const paddedBase64 = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  const binary = atob(paddedBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return decoder.decode(bytes)
}

function getSessionSecret() {
  const secret = process.env.APP_SESSION_SECRET?.trim()

  if (!secret) {
    throw new Error('APP_SESSION_SECRET is missing.')
  }

  return secret
}

async function getSigningKey() {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(getSessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function signValue(value: string) {
  const signingKey = await getSigningKey()
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(value))
  const bytes = new Uint8Array(signature)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function createSessionToken(session: AppSession) {
  const payload = encodeBase64Url(JSON.stringify(session))
  const signature = await signValue(payload)
  return `${payload}.${signature}`
}

export async function verifySessionToken(token: string | undefined | null) {
  if (!token) {
    return null
  }

  const [payload, signature] = token.split('.')
  if (!payload || !signature) {
    return null
  }

  const expectedSignature = await signValue(payload)
  if (signature !== expectedSignature) {
    return null
  }

  try {
    const parsedPayload = JSON.parse(decodeBase64Url(payload)) as AppSession
    if (
      typeof parsedPayload.userId !== 'number' ||
      typeof parsedPayload.username !== 'string' ||
      (parsedPayload.role !== 'ADMIN' && parsedPayload.role !== 'EMPLOYE') ||
      typeof parsedPayload.expiresAt !== 'number'
    ) {
      return null
    }

    if (parsedPayload.expiresAt <= Date.now()) {
      return null
    }

    return parsedPayload
  } catch {
    return null
  }
}

export function buildSessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: new Date(expiresAt),
  }
}
