import assert from 'node:assert/strict'
import test from 'node:test'
import { planTimeoutMs, resolveSmartTimeoutConfig } from '../lib/smart-timeout.js'

/** Compile a config over the built-in defaults. */
const cfg = (overrides = {}) => resolveSmartTimeoutConfig(overrides)

/** Plan one command with the default configuration. */
const plan = (command, requestedMs) => planTimeoutMs(command, requestedMs, cfg())

test('ordinary commands get the default bucket', () => {
  assert.deepEqual(plan('git status'), { timeoutMs: 120000, reason: 'default' })
  assert.deepEqual(plan('ls -la'), { timeoutMs: 120000, reason: 'default' })
  assert.deepEqual(plan('grep -rn "make sure" src/'), { timeoutMs: 120000, reason: 'default' })
  assert.deepEqual(plan('echo "npm install"'), { timeoutMs: 120000, reason: 'default' })
  assert.deepEqual(plan('rg -n "timeout 5" docs/'), { timeoutMs: 120000, reason: 'default' })
  assert.deepEqual(plan('kill $(pgrep node)'), { timeoutMs: 120000, reason: 'default' })
})

test('builds, installs, tests and other known-slow commands get the long bucket', () => {
  for (const command of [
    'npm install',
    'npm run build',
    'pnpm add lodash',
    'yarn test',
    'pip install -r requirements.txt',
    'uv sync',
    'npx playwright test',
    'cargo build --release',
    'go test ./...',
    'make',
    'cmake -S . -B build',
    'docker compose up -d',
    'git clone https://example.com/x.git',
    'git fetch',
    'pytest -q',
    'vitest run',
    'tail -f app.log',
    'watch -n 1 date',
    'for i in 1 2 3; do sleep 1; done',
    'sleep 30',
    './gradlew build',
    'ffmpeg -i in.mp4 out.mkv',
    'python -m http.server 8000',
    'jupyter nbconvert --to html a.ipynb',
  ]) {
    assert.deepEqual(plan(command), { timeoutMs: 1800000, reason: 'long-running' }, command)
  }
})

test('quoted text cannot trip the long-running heuristics', () => {
  assert.equal(plan('grep -n \'cargo build\' scripts/run.sh').reason, 'default')
  assert.equal(plan('echo "make sure it works"').reason, 'default')
  assert.equal(plan('sed -n "s/npm install/x/p" README.md').reason, 'default')
  // A real command word outside the quotes still counts.
  assert.equal(plan('sh -c "echo hi" && npm install').reason, 'long-running')
})

test('a bounded poll loop is long-running but an unconditioned while-true is not', () => {
  assert.equal(plan('until ping -c1 host; do sleep 10; done').reason, 'long-running')
  assert.equal(plan('while true; do sleep 1; done').reason, 'default')
})

test('an inner timeout guard wins and gets grace headroom', () => {
  assert.deepEqual(plan('timeout 30 npm test'), { timeoutMs: 60000, reason: 'inner-guard' })
  assert.deepEqual(plan('timeout -s KILL 90 db-job'), { timeoutMs: 120000, reason: 'inner-guard' })
  assert.deepEqual(plan('timeout -k 5 2m db-job'), { timeoutMs: 150000, reason: 'inner-guard' })
  assert.deepEqual(plan('/usr/bin/timeout 45 db-job'), { timeoutMs: 75000, reason: 'inner-guard' })
  assert.deepEqual(plan('timeout 1h backup.sh'), { timeoutMs: 3600000, reason: 'inner-guard' })
  assert.deepEqual(plan('timeout 0.5 db-job'), { timeoutMs: 31000, reason: 'inner-guard' })
  // Quote state resets per command segment.
  assert.deepEqual(plan('sh -c \'echo "a"; timeout 7 db-job\''), { timeoutMs: 37000, reason: 'inner-guard' })
})

test('inner guards that are not guards fall through', () => {
  // coreutils: `timeout 0` means no limit.
  assert.deepEqual(plan('timeout 0 npm install'), { timeoutMs: 1800000, reason: 'long-running' })
  // Quoted text is not a guard.
  assert.deepEqual(plan('echo "timeout 5"'), { timeoutMs: 120000, reason: 'default' })
  // A huge inner guard is still clamped to the ceiling.
  assert.deepEqual(plan('timeout 99999 cat'), { timeoutMs: 3600000, reason: 'inner-guard' })
})

test('an explicit timeoutMs wins and is clamped to the ceiling', () => {
  assert.deepEqual(plan('git status', 5000), { timeoutMs: 5000, reason: 'explicit' })
  assert.deepEqual(plan('npm install', 7200000), { timeoutMs: 3600000, reason: 'explicit-clamped' })
  assert.deepEqual(plan('git status', 600000), { timeoutMs: 600000, reason: 'explicit' })
  assert.throws(() => plan('ls', 0), /request\.timeoutMs must be a positive finite number/)
  assert.throws(() => plan('ls', Number.NaN), /request\.timeoutMs must be a positive finite number/)
  assert.throws(() => plan('ls', -1), /request\.timeoutMs must be a positive finite number/)
})

test('configuration knobs change the buckets', () => {
  const tight = cfg({ defaultSeconds: 10, longSeconds: 60 })
  assert.deepEqual(planTimeoutMs('git status', undefined, tight), { timeoutMs: 10000, reason: 'default' })
  assert.deepEqual(planTimeoutMs('npm install', undefined, tight), { timeoutMs: 60000, reason: 'long-running' })

  const lowCeiling = cfg({ defaultSeconds: 10, longSeconds: 60, maxSeconds: 30 })
  assert.deepEqual(planTimeoutMs('npm install', undefined, lowCeiling), { timeoutMs: 30000, reason: 'long-running' })
  assert.deepEqual(planTimeoutMs('git status', 60000, lowCeiling), { timeoutMs: 30000, reason: 'explicit-clamped' })

  const noGrace = cfg({ graceSeconds: 0 })
  assert.deepEqual(planTimeoutMs('timeout 30 x', undefined, noGrace), { timeoutMs: 30000, reason: 'inner-guard' })

  const custom = cfg({ longPatterns: ['scripts/nightly\\.sh'] })
  assert.deepEqual(planTimeoutMs('bash scripts/nightly.sh', undefined, custom), { timeoutMs: 1800000, reason: 'long-running' })
  assert.deepEqual(planTimeoutMs('echo "scripts/nightly.sh"', undefined, custom), { timeoutMs: 1800000, reason: 'long-running' })
})

test('invalid configuration fails fast at mount time', () => {
  assert.throws(() => resolveSmartTimeoutConfig({ defaultSeconds: 0 }), /defaultSeconds must be a positive finite number/)
  assert.throws(() => resolveSmartTimeoutConfig({ defaultSeconds: 60, longSeconds: 30 }), /longSeconds \(30\) must be >= defaultSeconds \(60\)/)
  assert.throws(() => resolveSmartTimeoutConfig({ defaultSeconds: 60, maxSeconds: 30 }), /maxSeconds \(30\) must be >= defaultSeconds \(60\)/)
  assert.throws(() => resolveSmartTimeoutConfig({ graceSeconds: -1 }), /graceSeconds must be a non-negative finite number/)
  assert.throws(() => resolveSmartTimeoutConfig({ longPatterns: ['('] }), /invalid regex/)
})

test('an empty configuration resolves to the documented defaults', () => {
  const defaults = resolveSmartTimeoutConfig({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.defaultSeconds, 120)
  assert.equal(defaults.longSeconds, 1800)
  assert.equal(defaults.maxSeconds, 3600)
  assert.equal(defaults.graceSeconds, 30)
  assert.deepEqual(defaults.longPatterns, [])
})
