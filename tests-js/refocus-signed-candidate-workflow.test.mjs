// Structural contract tests for the signed workflow. YAML shape is static;
// the PowerShell/GitHub-hosted Windows execution is not exercised locally.
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const workflow = load(readFileSync(new URL('../.github/workflows/hermes-refocus-win-x64-signed-candidate.yml', import.meta.url), 'utf8'))
const build = workflow.jobs['build-candidate']
const sign = workflow.jobs['sign-candidate']
const step = (job, name) => job.steps.find(item => item.name === name)
const run = (job, name) => step(job, name)?.run ?? ''

it('has exactly two trust-separated jobs and read-only permissions', () => {
  expect(Object.keys(workflow.jobs).sort()).toEqual(['build-candidate', 'sign-candidate'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(build.permissions).toEqual({ contents: 'read' })
  expect(sign.permissions).toEqual({ actions: 'read', contents: 'read' })
  expect(sign.needs).toBe('build-candidate')
  expect(build.environment).toBeUndefined()
  expect(sign.environment).toBe('refocus-signed-canary')
})

it('both jobs require workflow_dispatch from the exact protected default-branch ref', () => {
  expect(workflow.on.workflow_dispatch).toBeTruthy()
  for (const job of [build, sign]) {
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain("github.workflow_ref == format(")
    expect(job.if).toContain('@refs/heads/main')
  }
  expect(sign.if).toContain('vars.REFOCUS_SIGNING_ENABLED')
  expect(sign.if).toContain('I_VERIFIED_ENVIRONMENT_AND_BRANCH_PROTECTION')
})

it('candidate checkout and all candidate execution remain in the no-secrets build job', () => {
  expect(build.steps.some(item => String(item.uses).startsWith('actions/checkout@'))).toBe(true)
  expect(JSON.stringify(build)).not.toContain('secrets.')
  expect(build.steps.some(item => /desktop\.py/.test(item.run ?? ''))).toBe(true)
  expect(JSON.stringify(sign)).not.toContain('actions/checkout')
  expect(JSON.stringify(sign)).not.toContain('desktop.py')
  expect(JSON.stringify(sign)).not.toContain('node ')
  expect(JSON.stringify(sign)).not.toContain('npm ')
})

it('transfers only the same-run artifact, then validates package data before signing', () => {
  const upload = step(build, 'Upload unsigned package as data only')
  const download = step(sign, 'Download this run\'s exact build artifact')
  expect(upload.uses).toContain('actions/upload-artifact@')
  expect(download.uses).toContain('actions/download-artifact@')
  expect(download.with.name).toContain('${{ inputs.ref }}')
  expect(download.with.path).toContain('${{ runner.temp }}')
  const validate = run(sign, 'Validate unsigned package data (no code execution)')
  expect(validate).toContain("$sig.Status -ne 'NotSigned'")
  expect(validate).toContain('Refocus.HermesRefocus')
  expect(validate).toContain('PINNED_SUBJECT')
  expect(validate).toContain("identity.Version -notmatch")
  expect(step(sign, 'Validate unsigned package data (no code execution)').env.BUILD_EPOCH)
    .toBe('${{ needs.build-candidate.outputs.epoch }}')
  expect(validate).toContain('does not match trusted build epoch')
  expect(sign.steps.findIndex(item => item.name === 'Validate unsigned package data (no code execution)'))
    .toBeLessThan(sign.steps.findIndex(item => item.name === 'Sign with the protected PFX (signtool)'))
})

it('keeps PFX references inside the signing step and uses real signtool signing plus independent verification', () => {
  const signing = step(sign, 'Sign with the protected PFX (signtool)')
  expect(signing.env.HERMES_MSIX_PFX_B64).toBe('${{ secrets.HERMES_MSIX_PFX_B64 }}')
  expect(signing.env.HERMES_MSIX_PFX_PASSWORD).toBe('${{ secrets.HERMES_MSIX_PFX_PASSWORD }}')
  expect(JSON.stringify(build)).not.toContain('HERMES_MSIX_PFX')
  expect(JSON.stringify(sign.steps.filter(item => item !== signing))).not.toContain('secrets.')
  expect(signing.run).toContain('signtool.FullName sign')
  expect(signing.run).toContain('signtool.FullName verify /pa /all /v')
  expect(signing.run).toContain("$result.Status -ne 'Valid'")
  expect(signing.run).toContain('SignerCertificate.Thumbprint -cne $env:PINNED_THUMBPRINT')
  expect(signing.run).toContain('SignerCertificate.Subject -cne $env:PINNED_SUBJECT')
  expect(signing.run).toContain('Remove-Item -LiteralPath $pfx')
})

it('cannot sign until external environment verification and independent certificate pins are supplied', () => {
  const gate = step(sign, 'Refuse unpinned certificate configuration before secret use')
  expect(gate.env.PINNED_THUMBPRINT).toBe('SET_FIXED_40_HEX_CERT_THUMBPRINT_BEFORE_ENABLE')
  expect(gate.env.PINNED_SUBJECT).toBe('SET_FIXED_EXACT_CERT_SUBJECT_BEFORE_ENABLE')
  expect(gate.run).toContain('Fixed signer thumbprint/subject pins are unset')
  expect(readFileSync(new URL('../.github/workflows/hermes-refocus-win-x64-signed-candidate.yml', import.meta.url), 'utf8'))
    .toMatch(/GitHub Actions cannot prove a named environment has required reviewers from\s+# YAML alone/)
})

it('publishes only a short-lived public run artifact, never a feed or release', () => {
  expect(sign.steps.some(item => String(item.uses).startsWith('actions/upload-artifact@'))).toBe(true)
  const text = JSON.stringify(workflow)
  expect(text).not.toMatch(/gh release|softprops|appinstaller/i)
})
