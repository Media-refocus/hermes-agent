// The desktop product identity — THE single source for every name-shaped
// value a variant owns. HERMES_DESKTOP_VARIANT=light builds "Hermes
// Light", the remote-only client; everything else is full "Hermes".
//
// Consumed at build time by electron-builder.config.cjs (packaging
// identity). electron/product-identity.ts is the typed runtime accessor.
// @ts-check
/// <reference types="node" />
'use strict'

const variants = {
  '': { display: 'Hermes', kebab: 'hermes', pascal: 'Hermes' },
  light: {
    display: 'Hermes Light',
    kebab: 'hermes-light',
    pascal: 'HermesLight'
  },
  bundled: {
    display: 'Hermes Agent',
    kebab: 'hermes-bundled',
    pascal: 'HermesBundled'
  },
  refocus: {
    display: 'Hermes Refocus',
    kebab: 'hermes-refocus',
    pascal: 'HermesRefocus'
  }
}

const variant = process.env.HERMES_DESKTOP_VARIANT || ''
if (!['', 'light', 'bundled', 'store', 'refocus'].includes(variant)) {
  throw new Error(`Unknown HERMES_DESKTOP_VARIANT ${variant}. expected one of (empty), light, bundled, store, refocus`)
}

// 'store' is a Store-submission packaging identity layered on the bundled
// variant: same Electron app (displayName/appId/appNamePascal -> shared
// userData + single-instance lock with the out-of-store install), different
// MSIX package identity. The Store re-signs on submission.
const store = variant === 'store'
const light = variant === 'light'
const name = variants[store ? 'bundled' : (variant || '')]

// The electron-updater feed channel this build PUBLISHES to. A canary
// tag (vX.Y.Z+canary.YYYYMMDDTHHMMSSZ) writes canary.yml / light-canary.yml;
// stable tags write latest.yml / light.yml. Keyed on the payload tag so
// the one release workflow serves both channels — a canary build can
// never overwrite the stable feed file, and vice versa.
const canary = /\+canary\.20\d{6}T\d{6}Z$/.test(process.env.HERMES_PAYLOAD_TAG || '')

// 'refocus' is the INSTALLED private product 'Hermes Refocus': full bundled
// packaging (agent payload, MSIX) but never a release feed, never the Store,
// and never the official package family. Unlike official commit builds, its
// identity is commit-INDEPENDENT (see below).
const refocus = variant === 'refocus'

// Nonstable installs own their package family and local desktop state. The
// seven-character commit suffix also names the CLI and fits MSIX's name cap.
const buildCommitEnv = process.env.HERMES_BUILD_COMMIT || ''
const buildCommit = /^[a-f0-9]{40}$/.test(buildCommitEnv) ? buildCommitEnv.slice(0, 7) : null

// Official commit builds (bundled/light) carry the commit suffix on every OS
// marker: each commit is its own throwaway side-by-side product. Refocus is
// the opposite trade: it is the *installed product* and must update in place,
// and MSIX refuses an in-place update when the package Name changes. So its
// markers are byte-identical across commits; the commit lives in the install
// stamp (HERMES_BUILD_COMMIT is still required by the build), never in the
// product identity. userData follows appNamePascal (see
// electron/product-identity.ts) and stays stable for the same reason.
const displayName = refocus
  ? name.display
  : buildCommit
    ? `${name.display} ${buildCommit}`
    : canary
      ? `${name.display} Canary`
      : name.display

const kebabSuffix = refocus ? '' : buildCommit ? `-${buildCommit}` : canary ? '-canary' : ''
const pascalSuffix = refocus ? '' : buildCommit ? `Commit${buildCommit}` : canary ? 'Canary' : ''
const cliName = `${light || refocus ? name.kebab : 'hermes'}${kebabSuffix}`
// The exe stem must be a valid Windows filename; the display name alone
// qualifies only when it carries no spaces (commit-suffixed names do).
const windowsExecutableName = kebabSuffix || light
  ? cliName
  : refocus
    ? name.kebab
    : displayName
if (store && (canary || buildCommit)) {
  throw new Error('Store packaging is only eligible for stable releases')
}
if (refocus && (canary || process.env.HERMES_PAYLOAD_TAG)) {
  throw new Error('Refocus builds are commit builds; a release tag would claim the release namespace')
}
if (refocus && !buildCommitEnv) {
  throw new Error('Refocus builds require HERMES_BUILD_COMMIT (the commit is stamped, not worn)')
}

// The MSIX Publisher is HALF the package identity (with the Name): Windows
// compares the manifest Publisher against the signing certificate's Subject
// at install (a mismatch is event 150 / 0x8007000B), and once a package is
// installed a CHANGED Publisher makes later builds a different package —
// every in-place update is refused
// (https://learn.microsoft.com/windows/msix/package/signing-known-issues).
//
// Refocus owns its publisher and never wears Nous's: the manifest Publisher
// must be byte-identical to the Subject of the certificate that signs the
// package, and semantically the product is not a Nous product. The
// definitive value is the exact Subject of the future Refocus signing
// certificate — unknowable until that certificate and its legal entity
// exist — so it MUST arrive via HERMES_MSIX_PUBLISHER at build time.
//
// Until then, UNSIGNED build-verification candidates carry the provisional
// 'CN=Refocus Development'. A publisher change after an install breaks
// in-place update by definition, so no provisional-publisher build may ever
// claim to update (or be updated by) a definitive-publisher build: moving
// from the provisional candidate to the real product is a FRESH INSTALL
// (uninstall first), never an update.
const REFOCUS_PUBLISHER_ENV = 'HERMES_MSIX_PUBLISHER'
const PROVISIONAL_REFOCUS_PUBLISHER = 'CN=Refocus Development'
const refocusSignedBuild = Boolean(process.env.AZURE_SIGN_ENDPOINT || process.env.AZURE_CLIENT_ID)
let refocusPublisher
if (refocus) {
  refocusPublisher = (process.env[REFOCUS_PUBLISHER_ENV] || '').trim()
  if (refocusPublisher) {
    if (!/^CN=../.test(refocusPublisher)) {
      throw new Error(`${REFOCUS_PUBLISHER_ENV} must be a distinguished name starting with CN=, got ${JSON.stringify(refocusPublisher)}`)
    }
    if (/nous/i.test(refocusPublisher)) {
      throw new Error(`${REFOCUS_PUBLISHER_ENV} must be a Refocus identity, never a Nous one (got ${JSON.stringify(refocusPublisher)})`)
    }
    if (/[<>&'"\r\n]/.test(refocusPublisher)) {
      throw new Error(`${REFOCUS_PUBLISHER_ENV} contains characters unsafe for the MSIX XML Publisher attribute`)
    }
  } else {
    // An installable build requires the exact certificate Subject. An unsigned
    // verification-only candidate may use the provisional publisher.
    if (refocusSignedBuild) {
      throw new Error(`A signed refocus build requires ${REFOCUS_PUBLISHER_ENV} set to the exact Subject of the signing certificate; without it Windows refuses install and update (0x8007000B)`)
    }
    refocusPublisher = PROVISIONAL_REFOCUS_PUBLISHER
  }
}

/** @typedef {import("./product-identity.d.cts")} ProductIdentity */

/** @type {ProductIdentity} */
const identity = {
  store,
  light,
  refocus,
  displayName,
  appId: `com.nousresearch.${name.kebab}${kebabSuffix}`,
  // Store and commit builds do not publish a release feed. Refocus owns its
  // name-space only: it publishes nothing and subscribes to nothing.
  channel: store || buildCommit || refocus ? null : light ? (canary ? 'light-canary' : 'light') : (canary ? 'canary' : 'latest'),
  appNamePascal: `${name.pascal}${pascalSuffix}`,
  artifactNamePascal: name.pascal,
  windowsExecutableName,
  cliName,
  // MSIX namespace: the package Name and Publisher are one identity. Refocus
  // carries its own Name segment (Refocus.*), never the official NousResearch
  // namespace — and its Publisher through refocusPublisher above: the
  // provisional value for unsigned candidates, the exact cert Subject for
  // signed builds (HERMES_MSIX_PUBLISHER). The key exists on refocus only,
  // so official identities keep their exact historical shape.
  msixAppIdWithOrg: refocus ? `Refocus.${name.pascal}` : `NousResearch.${name.pascal}${pascalSuffix}`,
  ...(refocus ? { msixPublisher: refocusPublisher } : {}),
  ...(store
    ? {
        storeMsix: {
          // Partner Center publisher identity (the account's publisher ID) —
          // validated + re-signed by the Store on submission.
          identityName: 'NousResearchInc.HermesAgent',
          publisher: 'CN=EE6D86E4-606F-4E38-B940-AD7248C9D519',
          publisherDisplayName: 'Nous Research Inc.'
        }
      }
    : {})
}

const { channelBuildRequest } = require('../../scripts/msix-shared.mjs')
const request = channelBuildRequest()
module.exports = request
  ? Object.freeze({ ...request.identity, store: false, light: false, refocus: false, channel: request.channel })
  : identity
