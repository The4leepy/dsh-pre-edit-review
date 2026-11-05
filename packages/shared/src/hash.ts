import { createHash, randomBytes } from 'node:crypto'

/** Lower-case hex SHA-256 of the UTF-8 encoding of `value`. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 32 random bytes as hex; used for IPC tokens and per-request nonces. */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}
