// refocus-signed-gates.test.mjs — the SIGNED lane's decision logic, pinned
// locally. Every rejection the runner must produce is a case here; nothing
// touches the network, git, or real certificate material.
import { describe, expect, it } from 'vitest'

import {
  PACKAGE_NAME,
  PROVISIONAL_PUBLISHER,
  manifestGate,
  parseCertInfo,
  secretAdmission,
  signatureGate,
  unsignedCandidateGate
} from './refocus-signed-gates.mjs'

const SUBJECT = 'CN=Refocus Canary, O=Refocus, L=Lisbon, S=Lisbon, C=PT'
const THUMB = 'a'.repeat(40)

describe('secretAdmission', () => {
  it('accepts a coherent secret environment', () => {
    const verdict = secretAdmission({
      HERMES_MSIX_PFX_PATH: 'C:\\runner-temp\\x.pfx',
      HERMES_MSIX_PFX_PASSWORD: 'pw',
      HERMES_MSIX_PUBLISHER: SUBJECT
    })
    expect(verdict).toEqual({ ok: true, pfxPath: 'C:\\runner-temp\\x.pfx', publisher: SUBJECT })
  })

  it('refuses every missing or degenerate secret (fail closed, never falls back to unsigned)', () => {
    const base = { HERMES_MSIX_PFX_PATH: 'x.pfx', HERMES_MSIX_PFX_PASSWORD: 'pw', HERMES_MSIX_PUBLISHER: SUBJECT }
    for (const key of Object.keys(base)) {
      const verdict = secretAdmission({ ...base, [key]: '' })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain(key)
    }
    expect(secretAdmission({ ...base, HERMES_MSIX_PFX_PATH: '   ' }).ok).toBe(false)
  })

  it('refuses the provisional publisher on the signed lane', () => {
    const verdict = secretAdmission({ ...{ HERMES_MSIX_PFX_PATH: 'x.pfx', HERMES_MSIX_PFX_PASSWORD: 'pw' }, HERMES_MSIX_PUBLISHER: PROVISIONAL_PUBLISHER })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/provisional/)
  })

  it('refuses a Nous publisher and XML-unsafe publishers', () => {
    const base = { HERMES_MSIX_PFX_PATH: 'x.pfx', HERMES_MSIX_PFX_PASSWORD: 'pw' }
    expect(secretAdmission({ ...base, HERMES_MSIX_PUBLISHER: 'CN=Nous Research Inc.' }).ok).toBe(false)
    expect(secretAdmission({ ...base, HERMES_MSIX_PUBLISHER: 'CN=x"y' }).ok).toBe(false)
    expect(secretAdmission({ ...base, HERMES_MSIX_PUBLISHER: 'Refocus' }).ok).toBe(false)
  })
})

describe('manifestGate', () => {
  const manifest = { publisher: SUBJECT, packageName: PACKAGE_NAME, version: '26.922.0.1403' }
  const expected = { certSubject: SUBJECT, expectedVersion: '26.922.0.1403' }

  it('accepts the byte-matching publisher, stable Name and exact quad', () => {
    expect(manifestGate(manifest, expected)).toEqual({ ok: true, reason: expect.stringContaining(PACKAGE_NAME) })
  })

  it('refuses a publisher that does not BYTE-match the cert Subject (0x8007000B)', () => {
    const nearMiss = SUBJECT.replace('Refocus Canary', 'Refocus  Canary')
    expect(manifestGate({ ...manifest, publisher: nearMiss }, expected).ok).toBe(false)
    expect(manifestGate({ ...manifest, publisher: 'CN=Refocus Development' }, expected).ok).toBe(false)
  })

  it('refuses the official package Name and a drifted version', () => {
    expect(manifestGate({ ...manifest, packageName: 'NousResearch.HermesBundled' }, expected).ok).toBe(false)
    expect(manifestGate({ ...manifest, version: '26.922.0.1404' }, expected).ok).toBe(false)
    expect(manifestGate({ ...manifest, version: '0.0.0.0' }, expected).ok).toBe(false)
  })
})

describe('unsignedCandidateGate', () => {
  const candidate = {
    publisher: SUBJECT,
    packageName: PACKAGE_NAME,
    version: '26.922.0.1403',
    signatureStatus: 'NotSigned'
  }
  const expected = { expectedSubject: SUBJECT, expectedVersion: '26.922.0.1403' }

  it('accepts expected unsigned identity and exact package version', () => {
    expect(unsignedCandidateGate(candidate, expected).ok).toBe(true)
  })

  it('rejects signed or unverifiable input before signing', () => {
    for (const signatureStatus of ['Valid', 'HashMismatch', 'NotTrusted', null]) {
      expect(unsignedCandidateGate({ ...candidate, signatureStatus }, expected).ok).toBe(false)
    }
  })

  it('rejects wrong identity, publisher, version, missing pin, and out-of-range version', () => {
    expect(unsignedCandidateGate({ ...candidate, packageName: 'Other.Name' }, expected).ok).toBe(false)
    expect(unsignedCandidateGate({ ...candidate, publisher: 'CN=Other' }, expected).ok).toBe(false)
    expect(unsignedCandidateGate(candidate, { ...expected, expectedVersion: '26.922.0.1404' }).ok).toBe(false)
    expect(unsignedCandidateGate(candidate, { expectedSubject: '' }).ok).toBe(false)
    expect(unsignedCandidateGate({ ...candidate, version: '26.922.0.65536' }, { expectedSubject: SUBJECT }).ok).toBe(false)
  })
})

describe('signatureGate', () => {
  const expected = { expectedThumbprint: THUMB, expectedSubject: SUBJECT }

  it('demands Authenticode Valid', () => {
    expect(signatureGate({ status: 'Valid', thumbprint: THUMB, subject: SUBJECT }, expected).ok).toBe(true)
    for (const status of ['NotSigned', 'NotTrusted', 'HashMismatch', 'UnknownError']) {
      const verdict = signatureGate({ status, thumbprint: THUMB, subject: SUBJECT }, expected)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain(status)
    }
    expect(signatureGate(null, expected).ok).toBe(false)
  })

  it('checks the thumbprint case-insensitively and exactly', () => {
    expect(signatureGate({ status: 'Valid', thumbprint: THUMB.toUpperCase(), subject: SUBJECT }, expected).ok).toBe(true)
    const bad = signatureGate({ status: 'Valid', thumbprint: 'b'.repeat(40), subject: SUBJECT }, expected)
    expect(bad.ok).toBe(false)
    const missing = signatureGate({ status: 'Valid', thumbprint: null, subject: SUBJECT }, expected)
    expect(missing.ok).toBe(false)
  })

  it('requires fixed expected pins and refuses a Subject that differs', () => {
    expect(signatureGate({ status: 'Valid', thumbprint: THUMB, subject: SUBJECT }, { expectedThumbprint: null, expectedSubject: SUBJECT }).ok).toBe(false)
    expect(signatureGate({ status: 'Valid', thumbprint: THUMB, subject: SUBJECT }, { expectedThumbprint: THUMB, expectedSubject: null }).ok).toBe(false)
    const verdict = signatureGate(
      { status: 'Valid', thumbprint: THUMB, subject: 'CN=Someone Else' },
      expected
    )
    expect(verdict.ok).toBe(false)
  })
})

describe('parseCertInfo', () => {
  it('reads Subject=/Thumbprint= lines and fails closed on garbage', () => {
    const output = 'Subject=CN=Refocus Canary, O=Refocus\nThumbprint=' + 'A'.repeat(40) + '\n'
    expect(parseCertInfo(output)).toEqual({ subject: 'CN=Refocus Canary, O=Refocus', thumbprint: 'A'.repeat(40) })
    expect(parseCertInfo('Thumbprint=zz')).toEqual({ subject: null, thumbprint: null })
    expect(parseCertInfo('')).toEqual({ subject: null, thumbprint: null })
  })
})
