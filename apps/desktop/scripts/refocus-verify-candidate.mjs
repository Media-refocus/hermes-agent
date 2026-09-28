// refocus-verify-candidate.mjs — fail-closed admission for a Hermes Refocus
// candidate. Reads the built install stamp and the freshly-evaluated product
// identity and refuses anything that would collide with the official product
// or claim a feed. Pure Node: runs identically in CI and locally.
//
// Usage: node refocus-verify-candidate.mjs <full-40-char-sha> [desktopDir]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The identity module lives in the real checkout; the stamp under verification
// may be a probe tree (CI verifies the checkout it built, so both resolve the
// same). identityDir keeps the two independently overridable.
const identityDir = process.argv[3]
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : desktopDir

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`[refocus-candidate] FAIL: ${message}`)
  process.exit(1)
}

const sha = process.argv[2] || ''
if (!/^[0-9a-f]{40}$/.test(sha)) fail('pass the full 40-character commit SHA as the first argument')
const short = sha.slice(0, 7)

const stampFile = path.join(desktopDir, "build/install-stamp.json")
if (!fs.existsSync(stampFile)) fail(`missing built stamp: ${stampFile} — build before verifying`)
const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))

if (stamp.commit !== sha) fail(`stamp commit ${stamp.commit} does not match the admitted ${sha}`)
if (stamp.payload !== 'bundled') fail(`refocus must tell the bundled runtime story, got payload=${stamp.payload}`)
if (stamp.updateMechanism !== 'external') fail(`refocus must never advertise updates, got updateMechanism=${stamp.updateMechanism}`)
if (stamp.tag !== null && stamp.tag !== undefined) fail(`refocus must not carry a release tag, got ${stamp.tag}`)
if (stamp.channelBuild) fail('refocus must not carry a channel build request')

const env = {
  ...process.env,
  HERMES_DESKTOP_VARIANT: 'refocus',
  HERMES_BUILD_COMMIT: sha,
  HERMES_PAYLOAD_VERSION: String(stamp.baseVersion || '0.0.0')
}
delete env._HERMES_CHANNEL_REQUEST_JSON
const identity = JSON.parse(execFileSync(
  process.execPath,
  ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(identityDir, "product-identity.cjs")],
  { env, encoding: 'utf8' }
))

if (identity.refocus !== true) fail('identity lacks the refocus flag')
if (identity.channel !== null) fail(`identity must own no feed channel, got ${identity.channel}`)

const expected = {
  displayName: `Hermes Refocus ${short}`,
  appId: `com.nousresearch.hermes-refocus-${short}`,
  msixAppIdWithOrg: `NousResearch.HermesRefocusCommit${short}`,
  cliName: `hermes-refocus-${short}`,
  windowsExecutableName: `hermes-refocus-${short}`
}
for (const [field, want] of Object.entries(expected)) {
  if (identity[field] !== want) fail(`identity ${field} is ${JSON.stringify(identity[field])}, expected ${JSON.stringify(want)}`)
}

// The official app must never share a marker with this candidate.
const official = JSON.parse(execFileSync(
  process.execPath,
  ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(identityDir, "product-identity.cjs")],
  { env: { ...process.env, HERMES_DESKTOP_VARIANT: 'bundled' }, encoding: 'utf8' }
))
for (const field of ['displayName', 'appId', 'appNamePascal', 'msixAppIdWithOrg', 'windowsExecutableName', 'cliName']) {
  if (identity[field] === official[field]) fail(`identity ${field} collides with the official bundled product`)
}

console.log(`[refocus-candidate] identity verified for ${sha}`)
console.log(`[refocus-candidate] ${identity.displayName} | appId=${identity.appId} | msix=${identity.msixAppIdWithOrg}`)
console.log('[refocus-candidate] updates: external (none). feed channel: none. side-by-side: clean.')
