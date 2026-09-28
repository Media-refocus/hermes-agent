// refocus-signed-gates.mjs — pure verification logic for the SIGNED Hermes
// Refocus canary lane. No subprocesses, no filesystem: every function takes
// what it needs so the local suite exercises the exact decisions the
// workflow's PowerShell gate makes on the runner.
//
// The signed lane's contract:
//   - the PFX secret must be present and its password known (never logged)
//   - the manifest Publisher must byte-match the PFX cert Subject
//     (HERMES_MSIX_PUBLISHER); the provisional 'CN=Refocus Development' is
//     never accepted on a signed build
//   - the signing cert must chain to the machine's trusted-root store
//     (self-signed root trusted ONLY on this one laptop) — a root with
//     untrusted status fails closed
//   - the package identity Name stays the stable Refocus.HermesRefocus and
//     the Version is the exact canaryPackageVersionAt quad of the job's
//     pinned HERMES_RELEASE_EPOCH

/** The provisional publisher is unsigned-candidate-only, by design. */
export const PROVISIONAL_PUBLISHER = 'CN=Refocus Development'
/** The stable MSIX package identity Name of the installed Refocus product. */
export const PACKAGE_NAME = 'Refocus.HermesRefocus'

/**
 * The build-time secret admission. Called by the sign step before any
 * signtool invocation.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, pfxPath: string, publisher: string } | { ok: false, reason: string }}
 */
export function secretAdmission(env) {
  const pfxPath = String(env.HERMES_MSIX_PFX_PATH || '').trim()
  const password = String(env.HERMES_MSIX_PFX_PASSWORD || '')
  const publisher = String(env.HERMES_MSIX_PUBLISHER || '').trim()
  if (!pfxPath) return { ok: false, reason: 'HERMES_MSIX_PFX_PATH is empty — the PFX was not staged to the runner (or the secret download failed); refusing to produce an unsigned "signed" artifact' }
  if (!password) return { ok: false, reason: 'HERMES_MSIX_PFX_PASSWORD is empty — refusing a passwordless PFX on the signed lane' }
  if (!publisher) return { ok: false, reason: 'HERMES_MSIX_PUBLISHER is empty — a signed build must carry the exact certificate Subject (product-identity.cjs refuses otherwise)' }
  if (!/^CN=../.test(publisher)) return { ok: false, reason: `HERMES_MSIX_PUBLISHER must be a distinguished name starting with CN=, got ${JSON.stringify(publisher)}` }
  if (/nous/i.test(publisher)) return { ok: false, reason: `HERMES_MSIX_PUBLISHER must be a Refocus identity, never a Nous one (got ${JSON.stringify(publisher)})` }
  if (publisher === PROVISIONAL_PUBLISHER) return { ok: false, reason: 'the provisional CN=Refocus Development is unsigned-lane-only; a signed build must carry the real certificate Subject' }
  if (/[<>&'"\r\n]/.test(publisher)) return { ok: false, reason: `HERMES_MSIX_PUBLISHER contains characters unsafe for the MSIX XML Publisher attribute: ${JSON.stringify(publisher)}` }
  return { ok: true, pfxPath, publisher }
}

/**
 * The manifest-vs-certificate identity gate.
 * @param {{ publisher: string, packageName: string, version: string }} manifest values read from AppxManifest.xml
 * @param {{ certSubject: string, expectedVersion: string }} expected
 * @returns {{ ok: boolean, reason: string }}
 */
export function manifestGate({ publisher, packageName, version }, { certSubject, expectedVersion }) {
  if (publisher !== certSubject) return { ok: false, reason: `manifest Publisher ${JSON.stringify(publisher)} does not byte-match the cert Subject ${JSON.stringify(certSubject)} (install would fail 0x8007000B)` }
  if (publisher === PROVISIONAL_PUBLISHER) return { ok: false, reason: `manifest carries the provisional ${PROVISIONAL_PUBLISHER}; a signed build must carry the real Subject` }
  if (packageName !== PACKAGE_NAME) return { ok: false, reason: `manifest identity Name is ${JSON.stringify(packageName)}, expected the stable ${PACKAGE_NAME}` }
  if (!/^[1-9]\d*\.\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: `manifest Version ${JSON.stringify(version)} is not four 16-bit numeric fields with a nonzero major` }
  if (version !== expectedVersion) return { ok: false, reason: `manifest Version ${version} is not the exact expected quad ${expectedVersion} (canaryPackageVersionAt of the pinned HERMES_RELEASE_EPOCH)` }
  return { ok: true, reason: `identity ${packageName} ${version} publisher=${publisher}` }
}

/**
 * The Authenticode signature-status gate. All leaf-cert fields arrive
 * explicitly (null when unknown) — the gate fails closed on an unknown
 * thumbprint/subject when an expectation was configured.
 * @param {{ status: string, thumbprint?: string | null, subject?: string | null }} signature Get-AuthenticodeSignature fields
 * @param {{ expectedThumbprint: string | null, expectedSubject: string | null }} expected
 * @returns {{ ok: boolean, reason: string }}
 */
export function signatureGate(signature, { expectedThumbprint, expectedSubject }) {
  if (!signature || typeof signature.status !== 'string') return { ok: false, reason: 'no Authenticode signature object — the package carries no signature the gate could read' }
  if (signature.status !== 'Valid') return { ok: false, reason: `signature status is ${signature.status}, expected Valid (a status of HashMismatch/NotTrusted/UnknownError fails closed)` }
  if (expectedThumbprint) {
    const thumbprint = String(signature.thumbprint || '').trim()
    if (thumbprint.toLowerCase() !== String(expectedThumbprint).trim().toLowerCase()) {
      return { ok: false, reason: `signing cert thumbprint ${thumbprint || '(none)'} does not match the expected ${expectedThumbprint}` }
    }
  }
  if (expectedSubject && signature.subject !== undefined && signature.subject !== null
    && signature.subject !== expectedSubject) {
    return { ok: false, reason: `signing cert Subject ${JSON.stringify(signature.subject)} does not match ${JSON.stringify(expectedSubject)}` }
  }
  return { ok: true, reason: 'Authenticode Valid' }
}

/**
 * Parsed output of the workflow's certificate-reader PowerShell snippet
 * (`Subject=...` / `Thumbprint=...` lines). Returns nulls on anything it
 * cannot fully parse — the caller fails closed on unknown values.
 * @param {string} output
 * @returns {{ subject: string | null, thumbprint: string | null }}
 */
export function parseCertInfo(output) {
  const subject = /^Subject=(.+)$/m.exec(String(output ?? ''))?.[1]?.trim() ?? null
  const thumbprint = /^Thumbprint=([0-9a-fA-F]{40})$/m.exec(String(output ?? ''))?.[1]?.trim() ?? null
  return { subject: subject || null, thumbprint: thumbprint || null }
}
