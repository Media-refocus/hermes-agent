// hermes-refocus-win-x64-signed-candidate.yml — the SIGNED lane's declared
// contract, pinned statically like refocus-candidate-workflow.test.mjs:
// two jobs, the secret exists ONLY behind the protected environment in the
// build job, admission runs WITHOUT secrets and refuses anything but real
// ancestry of the mis-perfiles branch, the PFX is staged to runner temp and
// deleted in an always() step, gates demand Authenticode Valid + exact
// identity, and nothing publishes.
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

import { canaryPackageVersionAt } from '../scripts/msix-shared.mjs'

const workflow = load(readFileSync(new URL('../.github/workflows/hermes-refocus-win-x64-signed-candidate.yml', import.meta.url), 'utf8'))
const admissionJob = workflow.jobs['signed-canary-admission']
const buildJob = workflow.jobs['signed-canary-build']
const stepByName = (job, name) => job.steps.find(step => step.name === name)
const scriptOf = (job, name) => stepByName(job, name).run
const allSteps = [...admissionJob.steps, ...buildJob.steps]

it('has exactly two jobs: admission (secret-free) and build (protected environment)', () => {
  expect(Object.keys(workflow.jobs).sort()).toEqual(['signed-canary-admission', 'signed-canary-build'])
  expect(admissionJob.environment).toBeUndefined()
  expect(buildJob.environment).toBe('refocus-signed-canary')
  expect(buildJob.needs).toContain('signed-canary-admission')
})

it('top-level permissions are contents:read only, in both jobs', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(admissionJob.permissions).toEqual({ contents: 'read' })
  expect(buildJob.permissions).toEqual({ contents: 'read' })
})

it('admission checks out the branch, admits ancestry, and sees NO secret anywhere', () => {
  const checkout = admissionJob.steps.find(step => String(step.uses ?? '').startsWith('actions/checkout'))
  expect(checkout.with.ref).toBe('refocus/mis-perfiles')
  expect(checkout.with['persist-credentials']).toBe(false)
  const run = scriptOf(admissionJob, 'Admit the exact commit (branch ancestry, fail closed)')
  expect(run).toContain('refocus-signed-admission.mjs')
  expect(run).toContain('origin/refocus/mis-perfiles')
  // No secret reference anywhere in the admission job.
  const jobText = JSON.stringify(admissionJob)
  expect(jobText).not.toContain('secrets.')
})

it('the build job checks out the ADMITTED SHA, never a mutable ref', () => {
  const checkout = buildJob.steps.find(step => String(step.uses ?? '').startsWith('actions/checkout'))
  expect(checkout.with.ref).toBe("${{ needs.signed-canary-admission.outputs.sha }}")
  expect(checkout.with['persist-credentials']).toBe(false)
  expect(scriptOf(buildJob, 'Confirm the checkout is exactly the admitted commit')).toMatch(/not the admitted/)
})

it('the PFX is staged to runner temp (never workspace), path only, never echoed', () => {
  const stage = stepByName(buildJob, 'Stage the PFX secret to the runner (never logged)')
  expect(stage).toBeTruthy()
  expect(stage.env.HERMES_MSIX_PFX_B64).toBe('${{ secrets.HERMES_MSIX_PFX_B64 }}')
  expect(stage.run).toContain('$env:RUNNER_TEMP')
  expect(stage.run).not.toMatch(/Write-(Output|Host).*PASSWORD/i)
  expect(stage.run).toContain('HERMES_MSIX_PFX_B64))')
  // The staged path lands in GITHUB_ENV, not in a log line.
  expect(stage.run).toMatch(/Add-Content \$env:GITHUB_ENV/)
})

it('the staged PFX is deleted in a step that runs on failure too', () => {
  const shred = stepByName(buildJob, 'Shred the staged PFX (runs even on gate failure)')
  expect(shred).toBeTruthy()
  expect(shred['if']).toBe('always()')
  expect(shred.run).toContain('Remove-Item')
})

it('the workflow refuses to run unsigned: pre-flight gate + no-fallback check', () => {
  expect(scriptOf(buildJob, 'Fail closed unless the signing secrets are coherent (pre-flight)'))
    .toContain('secret-admission')
  expect(scriptOf(buildJob, 'Verify the candidate identity and package version (fail closed)'))
    .toMatch(/no staged PFX/)
})

it('the signature gate demands Authenticode Valid and the exact identity via the pure gates', () => {
  const pwsh = scriptOf(buildJob, 'Verify the SIGNED MSIX (signature, identity, exact version)')
  expect(pwsh).toMatch(/Status -ne 'Valid'/)
  expect(pwsh).toContain('refocus-signed-gates-cli.mjs manifest-gate')
  expect(pwsh).toContain('canaryPackageVersionAt')
  expect(pwsh).toContain('$env:HERMES_RELEASE_EPOCH')
  expect(pwsh).toMatch(/could not recompute the expected package quad/)
})

it('the unsigned lane tripwire is INVERTED here: signing vars must be absent, not present', () => {
  const run = scriptOf(buildJob, 'Fail closed if Trusted Signing credentials leak into this lane')
  expect(run).toMatch(/Unset them and re-run/)
})

it('the version expectation equals canaryPackageVersionAt of the pinned epoch', () => {
  const EPOCH = Date.parse('2026-09-22T00:14:03Z') / 1000
  expect(canaryPackageVersionAt(EPOCH)).toBe('26.922.0.1403')
  const pwsh = scriptOf(buildJob, 'Verify the SIGNED MSIX (signature, identity, exact version)')
  expect(pwsh).toContain("import('./scripts/msix-shared.mjs')")
})

it('publishes nothing: no release, no feed, no App Installer — artifact only, named PUBLIC', () => {
  expect(scriptOf(buildJob, 'Job summary — what this is and what it is not'))
    .toMatch(/artifact visibility \| \*\*PUBLIC\*\*/)
  const uses = allSteps.map(step => String(step.uses ?? '')).filter(Boolean)
  expect(uses.every(used => used.startsWith('actions/checkout') || used.startsWith('actions/setup-python') || used.startsWith('actions/upload-artifact'))).toBe(true)
  expect(uses.some(used => used.startsWith('actions/upload-artifact'))).toBe(true)
  const jobText = JSON.stringify(workflow)
  expect(jobText).not.toMatch(/gh release|softprops|appinstaller|App Installer feed/i)
})

// Static `${{ }}` context validation (HTTP 422 regression guard — same
// shape as refocus-candidate-workflow.test.mjs).
const EXPR = /\$\{\{(.*?)\}\}/g
const contextsOf = expression => [...expression.matchAll(/[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][\w-]*|\*|\[.*?\]))*/g)]
  .map(match => match[0].split('.')[0])
  .filter(name => !['and', 'or', 'not', 'null', 'true', 'false', 'contains', 'startsWith', 'endsWith', 'format', 'join', 'toJSON', 'fromJSON', 'hashFiles'].includes(name))
const contextsIn = value => [...String(value).matchAll(EXPR)].flatMap(match => contextsOf(match[1]))

it('every expression only names contexts available where it appears (HTTP 422 regression guard)', () => {
  for (const [key, value] of Object.entries(workflow.concurrency ?? {})) {
    for (const context of contextsIn(value)) {
      expect(['github', 'inputs'], `concurrency.${key}`).toContain(context)
    }
  }
  for (const [key, value] of Object.entries(buildJob.env ?? {})) {
    for (const context of contextsIn(value)) {
      expect(['github', 'inputs', 'vars', 'secrets', 'needs'], `build.env.${key} uses '${context}'`).toContain(context)
    }
  }
  for (const job of [admissionJob, buildJob]) {
    for (const [index, step] of job.steps.entries()) {
      for (const [key, value] of Object.entries(step.env ?? {})) {
        for (const context of contextsIn(value)) {
          expect(['github', 'inputs', 'vars', 'secrets', 'needs', 'runner', 'env', 'steps', 'job', 'matrix', 'strategy'],
            `steps[${index}].env.${key} uses context '${context}'`).toContain(context)
        }
      }
    }
  }
})
