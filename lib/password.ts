import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

const HASH_PREFIX = 'scrypt'
const SALT_LENGTH = 16
const KEY_LENGTH = 64

export async function hashPassword(password: string) {
  const salt = randomBytes(SALT_LENGTH).toString('hex')
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
  return `${HASH_PREFIX}$${salt}$${derivedKey.toString('hex')}`
}

export function isHashedPassword(value: string) {
  return value.startsWith(`${HASH_PREFIX}$`)
}

export async function verifyPassword(password: string, storedValue: string) {
  const parts = storedValue.split('$')
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) {
    return false
  }

  const [, salt, storedHashHex] = parts
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
  const storedHash = Buffer.from(storedHashHex, 'hex')

  if (storedHash.length !== derivedKey.length) {
    return false
  }

  return timingSafeEqual(storedHash, derivedKey)
}

