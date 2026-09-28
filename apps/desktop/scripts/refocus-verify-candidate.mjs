// refocus-verify-candidate.mjs — fail-closed admission for a Hermes Refocus
// candidate. Reads the built install stamp and the freshly-evaluated product
// identity and refuses anything that would collide with the official product
// or claim a feed. Pure Node: runs identically in CI and locally.
//
// The identity contract is commit-INDEPENDENT: 'Hermes Refocus' is one
// installed product that must update in place, so its OS markers never carry
// the commit (the stamp does). This gate also refuses any relapse to
// per-commit naming.
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

const stampFile = path.join(desktopDir, "build/install-stamp.json")
if (!fs.existsSync(stampFile)) fail(`missing built stamp: ${stampFile} — build before verifying`)
const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))

if (stamp.commit !== sha) fail(`stamp commit ${stamp.commit} does not match the admitted ${sha}`)
if (stamp.payload !== 'bundled') fail(`refocus must tell the bundled runtime story, got payload=${stamp.payload}`)
if (stamp.variant !== 'refocus') fail(`stamp must carry variant=refocus so the runtime derives the private identity, got ${JSON.stringify(stamp.variant)}`)
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

// The installed product identity is commit-independent and byte-stable.
const expected = {
  displayName: 'Hermes Refocus',
  appId: 'com.nousresearch.hermes-refocus',
  appNamePascal: 'HermesRefocus',
  msixAppIdWithOrg: 'Refocus.HermesRefocus',
  cliName: 'hermes-refocus',
  windowsExecutableName: 'hermes-refocus'
}
for (const [field, want] of Object.entries(expected)) {
  if (identity[field] !== want) fail(`identity ${field} is ${JSON.stringify(identity[field])}, expected ${JSON.stringify(want)}`)
}

// Publisher isolation: the candidate's MSIX Publisher is a REFOCUS identity,
// never Nous's. Unsigned candidates ride the provisional publisher; a signed
// (installable) build must have named its cert Subject via
// HERMES_MSIX_PUBLISHER — the identity module enforces that gate, so a
// missing/placeholder publisher on a signed build fails above at require
// time. Here we pin the remaining invariants.
if (!identity.msixPublisher) fail('identity must carry the refocus msixPublisher (never inherit an official one)')
if (/nous/i.test(identity.msixPublisher)) fail(`msixPublisher must never be a Nous identity: ${JSON.stringify(identity.msixPublisher)}`)
const signedBuild = Boolean(process.env.AZURE_SIGN_ENDPOINT || process.env.AZURE_CLIENT_ID)
if (signedBuild && identity.msixPublisher === 'CN=Refocus Development') {
  fail('a SIGNED (installable) build must carry the real certificate Subject via HERMES_MSIX_PUBLISHER, not the provisional CN=Refocus Development')
}
if (!signedBuild && identity.msixPublisher !== 'CN=Refocus Development') {
  // Unsigned candidates must be the provisional publisher so a later real
  // install is never promised to update over this one (a Publisher change
  // after install breaks in-place update by definition).
  fail(`an UNSIGNED candidate must carry exactly the provisional 'CN=Refocus Development' (got ${JSON.stringify(identity.msixPublisher)}); the real publisher belongs to signed builds only`)
}

// The official app must never share a marker with this candidate — including
// the official commit-build flavors of the SAME commit.
const officialEnvs = [
  { HERMES_DESKTOP_VARIANT: 'bundled' },
  { HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: sha },
  { HERMES_DESKTOP_VARIANT: 'light' },
  { HERMES_DESKTOP_VARIANT: 'store' }
]
for (const officialEnv of officialEnvs) {
  const official = JSON.parse(execFileSync(
    process.execPath,
    ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(identityDir, "product-identity.cjs")],
    { env: { ...process.env, ...officialEnv }, encoding: 'utf8' }
  ))
  for (const field of Object.keys(expected)) {
    if (identity[field] === official[field]) fail(`identity ${field} collides with the official ${officialEnv.HERMES_DESKTOP_VARIANT} product`)
  }
}

console.log(`[refocus-candidate] identity verified for ${sha}`)
console.log(`[refocus-candidate] ${identity.displayName} | appId=${identity.appId} | msix=${identity.msixAppIdWithOrg}`)
console.log('[refocus-candidate] markers are commit-independent: in-place update across commits is the design.')
console.log('[refocus-candidate] updates: external (none). feed channel: none. side-by-side: clean.')
