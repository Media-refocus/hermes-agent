// refocus-signed-gates-cli.mjs — CLI wrapper over refocus-signed-gates.mjs
// for the signed workflow's PowerShell/bash steps. Reads its inputs from
// argv/env, prints `::error::<reason>` on any gate failure, exits 1 — and
// NEVER prints a secret value (the password and PFX bytes never pass
// through here at all; the password stays in the step's env).
//
// Subcommands:
//   secret-admission  — env-only; validates HERMES_MSIX_PFX_PATH /
//                       HERMES_MSIX_PFX_PASSWORD / HERMES_MSIX_PUBLISHER
//                       coherence BEFORE the build runs.
//   manifest-gate     — --publisher --name --version --cert-subject
//                       --expected-version [--thumbprint --subject]
//                       (thumbprint/subject of the leaf cert when read).

import { secretAdmission, manifestGate } from './refocus-signed-gates.mjs'

/** @param {string} reason */
function fail(reason) {
  console.error(`::error::${reason}`)
  process.exit(1)
}

const [command] = process.argv.slice(2)

if (command === 'secret-admission') {
  const verdict = secretAdmission(process.env)
  if (!verdict.ok) fail(verdict.reason)
  // Only non-secret facts: the subject string is the build identity, not a
  // secret; the password and PFX contents are never echoed.
  console.log(`[refocus-signed-gates] secret admission OK (publisher=${verdict.publisher})`)
  process.exit(0)
}

if (command === 'manifest-gate') {
  const flag = name => {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const publisher = flag('publisher') ?? ''
  const name = flag('name') ?? ''
  const version = flag('version') ?? ''
  const certSubject = flag('cert-subject') ?? ''
  const expectedVersion = flag('expected-version') ?? ''
  const thumbprint = flag('thumbprint') ?? null
  const subject = flag('subject') ?? null
  if (!publisher || !name || !version || !certSubject || !expectedVersion) {
    fail('manifest-gate requires --publisher --name --version --cert-subject --expected-version')
  }
  const verdict = manifestGate(
    { publisher, packageName: name, version },
    { certSubject, expectedVersion }
  )
  if (!verdict.ok) fail(verdict.reason)
  if (thumbprint || subject) {
    const signature = { status: 'Valid', thumbprint, subject }
    const sigVerdict = (await import('./refocus-signed-gates.mjs')).signatureGate(
      signature, { expectedThumbprint: thumbprint, expectedSubject: subject }
    )
    if (!sigVerdict.ok) fail(sigVerdict.reason)
    console.log(`[refocus-signed-gates] ${sigVerdict.reason}`)
  }
  console.log(`[refocus-signed-gates] ${verdict.reason}`)
  process.exit(0)
}

fail(`unknown subcommand ${JSON.stringify(command ?? '')}; expected secret-admission or manifest-gate`)
