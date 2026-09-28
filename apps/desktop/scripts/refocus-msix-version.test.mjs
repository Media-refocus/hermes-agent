import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { AppInfo } from '../../../node_modules/app-builder-lib/dist/appInfo.js'
import { substituteManifestMacros } from '../../../node_modules/app-builder-lib/dist/targets/win/winAppUtil.js'
import { canaryPackageVersionAt } from '../../../scripts/msix-shared.mjs'
import { stageReleaseManifest } from './before-build.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function refocusFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refocus-msix-'))
  roots.push(root)
  const desktop = path.join(root, 'apps/desktop')
  fs.mkdirSync(path.join(desktop, 'assets'), { recursive: true })
  fs.copyFileSync(new URL('../assets/msix-manifest.xml', import.meta.url), path.join(desktop, 'assets/msix-manifest.xml'))
  fs.writeFileSync(path.join(desktop, 'product-identity.cjs'), `module.exports = ${JSON.stringify({
    store: false, light: false, refocus: true, displayName: 'Hermes Refocus',
    appId: 'com.nousresearch.hermes-refocus', appNamePascal: 'HermesRefocus',
    artifactNamePascal: 'HermesRefocus', msixAppIdWithOrg: 'Refocus.HermesRefocus',
    msixPublisher: 'CN=Refocus Test'
  })}\n`)
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ name: 'hermes-refocus', version: '0.28.0' }))
  return desktop
}

const commit = '56f608cb9464bd12a7e7e04ad389d0fc7b9cc6d2'
const epoch = Date.parse('2026-09-28T10:59:53Z') / 1000

function pinRefocusEnv() {
  vi.stubEnv('HERMES_DESKTOP_VARIANT', 'refocus')
  vi.stubEnv('HERMES_BUILD_COMMIT', commit)
  vi.stubEnv('HERMES_PAYLOAD_VERSION', '0.28.0')
  vi.stubEnv('HERMES_RELEASE_EPOCH', String(epoch))
  vi.stubEnv('HERMES_PAYLOAD_TAG', '')
}

test('Refocus staged manifest survives app-builder-lib real MSIX version substitution intact', () => {
  pinRefocusEnv()
  const desktop = refocusFixture()
  const expected = canaryPackageVersionAt(epoch)
  const stagedPath = stageReleaseManifest(desktop, '')
  const staged = fs.readFileSync(stagedPath, 'utf8')
  assert.equal(staged.includes('${version}'), false)
  assert.equal(/<Identity\b[^>]*Version="([^"]+)"/.exec(staged)?.[1], expected)

  // The actual MsixTarget callback uses this AppInfo method with setBuildNumber=false.
  const appInfo = new AppInfo({
    config: { buildNumber: '5953' },
    metadata: { name: 'HermesRefocus', productName: 'Hermes Refocus', version: '26.928.10.5953' }
  }, null, {})
  assert.equal(appInfo.getVersionInWeirdWindowsForm(false), '26.928.10.0')
  const finalXml = substituteManifestMacros(staged, macro => {
    if (macro === 'version') return appInfo.getVersionInWeirdWindowsForm(false)
    if (macro === 'identityName') return 'Refocus.HermesRefocus'
    if (macro === 'publisher') return 'CN=Refocus Test'
    return `test-${macro}`
  })
  assert.equal(/<Identity\b[^>]*Version="([^"]+)"/.exec(finalXml)?.[1], expected)
  assert.match(finalXml, /Name="Refocus\.HermesRefocus"/)
  assert.match(finalXml, /Publisher='CN=Refocus Test'/)
  assert.equal(expected, '26.928.10.5953')
})

test('Refocus manifest staging fails closed without the pinned build epoch', () => {
  pinRefocusEnv()
  vi.stubEnv('HERMES_RELEASE_EPOCH', '')
  const desktop = refocusFixture()
  assert.throws(() => stageReleaseManifest(desktop, ''), /immutable HERMES_RELEASE_EPOCH/)
})

test('ordinary non-Refocus source manifest keeps the version macro for app-builder-lib', () => {
  const desktop = refocusFixture()
  const source = fs.readFileSync(path.join(desktop, 'assets/msix-manifest.xml'), 'utf8')
  assert.equal(source.includes('${version}'), true)
  assert.equal(fs.existsSync(path.join(desktop, 'build/msix-manifest.xml')), false)
})
