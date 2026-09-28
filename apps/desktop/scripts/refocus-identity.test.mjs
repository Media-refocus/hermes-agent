// Hermes Refocus is the installed private product 'Hermes Refocus', layered
// on the bundled packaging story. These tests hold its contract:
//
// 1. The OS-visible markers are COMMIT-INDEPENDENT — 'Hermes Refocus' is one
//    product that must update in place, and MSIX refuses an in-place update
//    when the package Name changes. Two builds of different commits must
//    resolve the exact same identity (and therefore the same userData).
// 2. Every marker still disagrees with the official stable/canary/commit
//    identities: no install collision, no userData sharing.
// 3. It can never acquire a release feed channel, and it keeps the full
//    bundled runtime story with updates stamped external.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

const COMMIT_A = '56f608cb9464bd12a7e7e04ad389d0fc7b9cc6d2'
const COMMIT_B = 'cc8600b4a8c13b7fbb79fbc2a3cc92069cd6bcf7'
const VERSION_ENV = { HERMES_PAYLOAD_VERSION: '0.28.0' }
const CANARY_TAG = 'v1.2.3+canary.20260818T000000Z'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  for (const key of ['HERMES_DESKTOP_VARIANT', 'HERMES_PAYLOAD_TAG', 'HERMES_BUILD_COMMIT', 'HERMES_PAYLOAD_VERSION']) {
    delete process.env[key]
  }
  vi.resetModules()
})

function identityFor(env = {}) {
  for (const key of ['HERMES_DESKTOP_VARIANT', 'HERMES_PAYLOAD_TAG', 'HERMES_BUILD_COMMIT', 'HERMES_PAYLOAD_VERSION']) {
    delete process.env[key]
    if (env[key] !== undefined) process.env[key] = env[key]
  }
  delete require.cache[require.resolve('../product-identity.cjs')]
  vi.resetModules()
  return require('../product-identity.cjs')
}

function refocusIdentity(commit) {
  return identityFor({
    HERMES_DESKTOP_VARIANT: 'refocus',
    HERMES_BUILD_COMMIT: commit,
    ...VERSION_ENV
  })
}

const MARKERS = [
  'displayName',
  'appId',
  'appNamePascal',
  'msixAppIdWithOrg',
  'windowsExecutableName',
  'cliName'
]

test('refocus identity is identical across commits (in-place update precondition)', () => {
  const a = refocusIdentity(COMMIT_A)
  const b = refocusIdentity(COMMIT_B)

  assert.equal(a.refocus, true)
  assert.equal(a.light, false)
  assert.equal(a.store, false)
  assert.equal(a.storeMsix, undefined)
  for (const field of MARKERS) {
    assert.equal(a[field], b[field], `${field} must not vary with the commit`)
  }
  assert.equal(a.displayName, 'Hermes Refocus')
  assert.equal(a.appId, 'com.nousresearch.hermes-refocus')
  assert.equal(a.appNamePascal, 'HermesRefocus')
  assert.equal(a.msixAppIdWithOrg, 'NousResearch.HermesRefocus')
  assert.equal(a.cliName, 'hermes-refocus')
  assert.equal(a.windowsExecutableName, 'hermes-refocus')
})

test('refocus markers disagree with every official identity on all OS markers', () => {
  const refocus = refocusIdentity(COMMIT_A)

  // Every official flavor the machine may already have installed, including
  // the commit-build flavor of the very same commit.
  const officials = [
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled' }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_PAYLOAD_TAG: CANARY_TAG }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT_A, ...VERSION_ENV }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'light' }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'store' })
  ]

  for (const official of officials) {
    for (const field of MARKERS) {
      assert.notEqual(refocus[field], official[field], `${field} must isolate the refocus install`)
    }
  }
})

test('refocus never owns or subscribes to a release feed channel', () => {
  const refocus = refocusIdentity(COMMIT_A)
  assert.equal(refocus.channel, null)
})

test('refocus refuses release tags: tags belong to the official release namespace', () => {
  for (const tag of ['v1.2.3', CANARY_TAG]) {
    assert.throws(
      () => identityFor({ HERMES_DESKTOP_VARIANT: 'refocus', HERMES_PAYLOAD_TAG: tag }),
      /Refocus builds are commit builds/
    )
  }
})

test('refocus requires the build commit even though the identity ignores it', () => {
  assert.throws(
    () => identityFor({ HERMES_DESKTOP_VARIANT: 'refocus', ...VERSION_ENV }),
    /HERMES_BUILD_COMMIT/
  )
})

test('refocus packaging keeps the full bundled runtime story and stamps the variant', async () => {
  // The payload story is decided by the stamp writer, not the identity module;
  // pin both halves of the contract here.
  const { buildStampPayload } = await import('./write-build-stamp.mjs')
  const stamp = {
    commit: COMMIT_A,
    branch: null,
    builtAt: '2026-09-28T00:00:00Z',
    dirty: false,
    source: 'commit-build'
  }
  const runtime = {
    repoDir: 'app',
    toolsDir: 'tools',
    storePython: 'tools/python/bin/python3',
    sitePackages: 'venv/site-packages',
    commands: { hermes: 'bin/hermes-refocus' }
  }
  const env = { HERMES_DESKTOP_VARIANT: 'refocus', HERMES_BUILD_COMMIT: COMMIT_A, ...VERSION_ENV }
  const payload = buildStampPayload(stamp, env, 'win32', { runtime })
  assert.equal(payload.payload, 'bundled')
  assert.equal(payload.source, 'commit-build')
  assert.equal(payload.updateMechanism, 'external')
  assert.equal(payload.tag, null)
  assert.equal(payload.variant, 'refocus')
  assert.deepEqual(payload.runtime, runtime)

  // ...and refuses to run without the staged payload, exactly like bundled.
  assert.throws(
    () => buildStampPayload(stamp, env, 'win32'),
    /payload/
  )

  // Official variants never gain the override field.
  const official = buildStampPayload(stamp, { ...env, HERMES_DESKTOP_VARIANT: 'bundled' }, 'win32', { runtime })
  assert.equal(official.variant, undefined)
})

test('refocus packaging is publish-null even when feed vars leak into the build', () => {
  process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://feeds.example.invalid'
  process.env.GITHUB_REPOSITORY = 'Refocus/hermes-agent'
  try {
    refocusIdentity(COMMIT_A)
    delete require.cache[require.resolve('../electron-builder.config.cjs')]
    const config = require('../electron-builder.config.cjs')
    assert.equal(config.publish, null)
    assert.equal(config.extraMetadata.name, 'HermesRefocus')
    assert.equal(config.extraMetadata.productName, 'Hermes Refocus')
    assert.equal(config.msix.identityName, 'NousResearch.HermesRefocus')
    assert.equal(config.win.executableName, 'hermes-refocus')
    // Commit builds never claim the release manifest template path.
    assert.equal(config.msix.customManifestPath, 'build/msix-manifest.xml')
    // The agent payload ships: refocus tells the full bundled runtime story.
    assert.ok(Array.isArray(config.extraResources))
    assert.ok(
      config.extraResources.some((entry) => entry?.from === 'build/agent-payload'),
      'refocus must carry the agent-payload extraResource'
    )
  } finally {
    delete process.env.CLOUDFLARE_R2_PUBLIC_URL
    delete process.env.GITHUB_REPOSITORY
    delete require.cache[require.resolve('../electron-builder.config.cjs')]
  }
})

test('the runtime bundle derives the refocus identity from the stamped variant, not from payload', async () => {
  // bundle-electron-main.productIdentity keys the identity process off the
  // stamp. A refocus stamp must select the refocus variant (payload='bundled'
  // alone would resolve the OFFICIAL bundled identity and share its userData).
  const source = await import('./bundle-electron-main.mjs')
  assert.equal(typeof source.bundleElectronMain, 'function')
  const { execFileSync } = await import('node:child_process')
  const stamp = { payload: 'bundled', updateMechanism: 'external', source: 'commit-build', commit: COMMIT_A, variant: 'refocus', tag: null }
  const script = [
    "const stamp = " + JSON.stringify(stamp),
    "const variant = stamp.variant === 'refocus' ? 'refocus' : (stamp.updateMechanism === 'microsoft-store' ? 'store' : (stamp.payload === 'bootstrap' ? '' : stamp.payload))",
    "process.env.HERMES_DESKTOP_VARIANT = variant",
    "process.env.HERMES_PAYLOAD_TAG = stamp.tag || ''",
    "process.env.HERMES_BUILD_COMMIT = (stamp.source === 'commit-build' || stamp.variant === 'refocus') ? (stamp.commit || '') : ''",
    "console.log(JSON.stringify(require(process.argv[1])))"
  ].join(';')
  const probe = JSON.parse(execFileSync(
    process.execPath,
    ['-e', script, path.join(path.dirname(import.meta.dirname), 'product-identity.cjs')],
    { encoding: 'utf8', env: { ...process.env, ...VERSION_ENV } }
  ))
  assert.equal(probe.displayName, 'Hermes Refocus')
  assert.equal(probe.appNamePascal, 'HermesRefocus')
  // And a stamp WITHOUT the variant flag (payload='bundled' only) resolves the
  // OFFICIAL commit-suffixed bundled identity — the collision the override
  // field removes (same family, shared userData family, wrong product).
  const legacyStamp = { ...stamp }
  delete legacyStamp.variant
  const legacyScript = script.replace(JSON.stringify(stamp), JSON.stringify(legacyStamp))
  const legacy = JSON.parse(execFileSync(
    process.execPath,
    ['-e', legacyScript, path.join(path.dirname(import.meta.dirname), 'product-identity.cjs')],
    { encoding: 'utf8', env: { ...process.env, ...VERSION_ENV, HERMES_DESKTOP_VARIANT: '' } }
  ))
  assert.equal(legacy.displayName, 'Hermes Agent 56f608c')
  assert.equal(legacy.appNamePascal, 'HermesBundledCommit56f608c')
  assert.equal(legacy.refocus, false)
})

test('official variants never carry the refocus flag', () => {
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'bundled' }).refocus, false)
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'light' }).refocus, false)
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'store' }).refocus, false)
  assert.equal(identityFor().refocus, false)
})
