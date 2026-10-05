import { createMatcher } from './glob.mjs';

/**
 * Entries that may hold secrets. They are never read, hashed or parsed; only their existence is recorded.
 * Conservative on purpose: a false positive only means a file is not indexed.
 */
export const DEFAULT_SECRET_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*.der',
  '*.jks',
  '*.keystore',
  '*.ppk',
  'id_rsa',
  'id_rsa.*',
  'id_dsa',
  'id_dsa.*',
  'id_ecdsa',
  'id_ecdsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.git-credentials',
  'credentials',
  'credentials.*',
  '*credentials*.json',
  '*.secret',
  '*.secrets',
  'secrets.*',
  'secret.*',
  '*service-account*.json',
  '*.tfvars',
  'terraform.tfstate',
  'terraform.tfstate.*',
  '.ssh/',
  '.aws/',
  '.gnupg/',
]);

/** Returns (relPath, isDir) => boolean. */
export function createSecretMatcher(extraPatterns = []) {
  return createMatcher([...DEFAULT_SECRET_PATTERNS, ...extraPatterns]);
}
