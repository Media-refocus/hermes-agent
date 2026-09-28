// Hermes Refocus is a private side-by-side build identity layered on the
// bundled packaging story. These tests hold its contract: every OS-visible
// marker disagrees with the official stable/canary/commit identities (no
// install collision, no userData sharing), and it can never acquire a release
// feed channel — the refocus variant must stay publish-null and update-external.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

const COMMIT = '56f608cb9464bd12a7e7e04ad389d0fc7b9cc6d2'
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

const MARKERS = [
  'displayName',
  'appId',
  'appNamePascal',
  'msixAppIdWithOrg',
  'windowsExecutableName',
  'cliName'
]

test('refocus commit builds disagree with every official identity on all OS markers', () => {
  const refocus = identityFor({
    HERMES_DESKTOP_VARIANT: 'refocus',
    HERMES_BUILD_COMMIT: COMMIT,
    ...VERSION_ENV
  })

  assert.equal(refocus.refocus, true)
  assert.equal(refocus.light, false)
  assert.equal(refocus.store, false)
  assert.equal(refocus.storeMsix, undefined)
  assert.equal(refocus.displayName, 'Hermes Refocus 56f608c')
  assert.equal(refocus.appId, 'com.nousresearch.hermes-refocus-56f608c')
  assert.equal(refocus.msixAppIdWithOrg, 'NousResearch.HermesRefocusCommit56f608c')
  assert.ok(refocus.appNamePascal.startsWith('HermesRefocusCommit'))

  // Every official flavor the machine may already have installed.
  const officials = [
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled' }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_PAYLOAD_TAG: CANARY_TAG }),
    identityFor({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT, ...VERSION_ENV }),
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
  const refocus = identityFor({
    HERMES_DESKTOP_VARIANT: 'refocus',
    HERMES_BUILD_COMMIT: COMMIT,
    ...VERSION_ENV
  })
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

test('refocus packaging keeps the full bundled runtime story', async () => {
  // The payload story is decided by the stamp writer, not the identity module;
  // pin both halves of the contract here.
  const { buildStampPayload } = await import('./write-build-stamp.mjs')
  const stamp = {
    commit: COMMIT,
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
    commands: { hermes: 'bin/hermes-56f608c' }
  }
  const env = { HERMES_DESKTOP_VARIANT: 'refocus', HERMES_BUILD_COMMIT: COMMIT, ...VERSION_ENV }
  const payload = buildStampPayload(stamp, env, 'win32', { runtime })
  assert.equal(payload.payload, 'bundled')
  assert.equal(payload.source, 'commit-build')
  assert.equal(payload.updateMechanism, 'external')
  assert.equal(payload.tag, null)
  assert.deepEqual(payload.runtime, runtime)

  // ...and refuses to run without the staged payload, exactly like bundled.
  assert.throws(
    () => buildStampPayload(stamp, env, 'win32'),
    /payload/
  )
})

test('refocus packaging is publish-null even when feed vars leak into the build', () => {
  process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://feeds.example.invalid'
  process.env.GITHUB_REPOSITORY = 'Refocus/hermes-agent'
  try {
    identityFor({
      HERMES_DESKTOP_VARIANT: 'refocus',
      HERMES_BUILD_COMMIT: COMMIT,
      ...VERSION_ENV
    })
    const config = require('../electron-builder.config.cjs')
    assert.equal(config.publish, null)
    assert.equal(config.extraMetadata.name, 'HermesRefocusCommit56f608c')
    assert.equal(config.extraMetadata.productName, 'Hermes Refocus 56f608c')
    assert.equal(config.msix.identityName, 'NousResearch.HermesRefocusCommit56f608c')
    assert.equal(config.win.executableName, 'hermes-refocus-56f608c')
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
  }
})

test('official variants never carry the refocus flag', () => {
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'bundled' }).refocus, false)
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'light' }).refocus, false)
  assert.equal(identityFor({ HERMES_DESKTOP_VARIANT: 'store' }).refocus, false)
  assert.equal(identityFor().refocus, false)
})
