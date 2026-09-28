// hermes-refocus-win-x64-candidate.yml — the workflow builds on a real
// Windows runner, which local tests must not fake. What CAN be pinned here
// is the workflow's declared contract: the build clock is pinned once and
// threaded everywhere, the MSIX version gate demands an exact quad derived
// from that same pinned epoch with the same helper the build uses, and no
// step ever presents the public fork's run artifact as private.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

import { canaryPackageVersionAt } from '../scripts/msix-shared.mjs'

const workflow = load(readFileSync(new URL('../.github/workflows/hermes-refocus-win-x64-candidate.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['windows-x64-candidate']
const stepByName = name => job.steps.find(step => step.name === name)
const scriptOf = name => stepByName(name).run

// 2026-09-22T00:14:03Z, the same epoch native-quad.test.mjs works by hand:
// yy=26, mmdd=922, hh=0, mmss=1403.
const EPOCH = Date.parse('2026-09-22T00:14:03Z') / 1000

// Runs the EXACT node -e snippet the pwsh gate uses (win32/Pwsh not needed:
// the snippet is plain node argv), so the test breaks if the gate's
// derivation drifts from scripts/msix-shared.mjs.
const gateDerivation = epoch => execFileSync(
  process.execPath,
  ['-e', "import('./scripts/msix-shared.mjs').then(m => console.log(m.canaryPackageVersionAt(Number(process.argv[1]))))", String(epoch)],
  { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }
).trim()

it('pins one build clock and threads it to prepare, build and the gates', () => {
  const pin = stepByName('Pin the release epoch (one build clock for the job)')
  expect(pin).toBeTruthy()
  expect(pin.run).toContain('HERMES_RELEASE_EPOCH')
  expect(pin.run).toMatch(/>> "\$GITHUB_ENV"/)
  for (const name of ['Prepare the desktop build (refocus variant, commit identity)',
    'Build and package the candidate MSIX (no upload, no signing)']) {
    expect(stepByName(name).env['HERMES_RELEASE_EPOCH']).toBe('${{ env.HERMES_RELEASE_EPOCH }}')
  }
})

it('the MSIX gate demands the exact quad of the pinned epoch, not merely a non-zero version', () => {
  const pwsh = scriptOf('Verify the unsigned MSIX, its identity and rising version')
  expect(pwsh).toContain('0.0.0.0') // kept as a fast pre-check
  // Same helper, same input, exact string comparison, fail closed when the
  // expectation cannot even be computed.
  expect(pwsh).toContain('canaryPackageVersionAt')
  expect(pwsh).toContain('$env:HERMES_RELEASE_EPOCH')
  expect(pwsh).toMatch(/-cne \$expected/)
  expect(pwsh).toMatch(/could not recompute the expected package quad/)
})

it('the gate derivation and msix-shared agree, and every field stays 16-bit', () => {
  expect(gateDerivation(EPOCH)).toBe(canaryPackageVersionAt(EPOCH))
  expect(gateDerivation(EPOCH)).toBe('26.922.0.1403')
  const parts = canaryPackageVersionAt(EPOCH).split('.').map(Number)
  expect(parts.every(value => value >= 0 && value <= 65535)).toBe(true)
})

it('never presents the public fork run artifact as private', () => {
  expect(workflow.name).not.toMatch(/private/i)
  for (const step of job.steps) {
    if (step.uses) continue
    // The audited phrasings, and any bare "private ..." claim; the ONLY
    // allowed mentions are explicit negations ("not a private artifact",
    // 'be read as "private"').
    expect(`${step.name ?? ''}\n${step.run ?? ''}`).not.toMatch(/private run artifact/i)
    expect(step.run ?? '').not.toMatch(/this private fork/i)
    for (const sentence of (step.run ?? '').split('\n')) {
      const match = /private/.exec(sentence)
      if (match) expect(/not a private|as "private"|never be read/i.test(sentence), sentence.trim()).toBe(true)
    }
  }
  // The summary says the opposite, in plain words.
  expect(scriptOf('Job summary — what this is and what it is not')).toMatch(/artifact visibility \| \*\*PUBLIC\*\*/)
})
