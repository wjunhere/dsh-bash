import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { gitBashCandidates, resolveGitBash } from '../lib/git-bash.js'

/** A throwaway directory that stands in for a Git installation. */
function fakeGitRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bash-'))
  const bash = join(root, 'Git', 'bin', 'bash.exe')
  mkdirSync(join(root, 'Git', 'bin'), { recursive: true })
  writeFileSync(bash, '')
  return { root, bash }
}

const created = []
after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

describe('resolveGitBash', () => {
  it('honours an explicit config path', () => {
    const { bash } = fakeGitRoot()
    const resolved = resolveGitBash(bash, {})
    assert.equal(resolved.path, bash)
    assert.equal(resolved.origin, 'config.bashPath')
  })

  it('fails fast when the configured path is missing', () => {
    assert.throws(() => resolveGitBash('C:\\definitely\\not\\here\\bash.exe', {}), /bashPath does not exist/)
  })

  it('rejects an empty configured path', () => {
    assert.throws(() => resolveGitBash('  ', {}), /bashPath is empty/)
  })

  it('finds a Program Files installation', () => {
    const { root, bash } = fakeGitRoot()
    created.push(root)
    const resolved = resolveGitBash(undefined, { ProgramFiles: root })
    assert.equal(resolved.path, bash)
  })

  it('finds the installation named by a PATH git directory', () => {
    const { root, bash } = fakeGitRoot()
    created.push(root)
    const gitCmd = join(root, 'Git', 'cmd')
    mkdirSync(gitCmd, { recursive: true })
    writeFileSync(join(gitCmd, 'git.exe'), '')
    const resolved = resolveGitBash(undefined, { PATH: gitCmd, SystemRoot: 'C:\\Windows' })
    assert.equal(resolved.path, bash)
    assert.equal(resolved.origin, 'PATH git directory')
  })

  it('finds scoop installations', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bash-'))
    created.push(root)
    const bash = join(root, 'apps', 'git', 'current', 'bin', 'bash.exe')
    mkdirSync(join(root, 'apps', 'git', 'current', 'bin'), { recursive: true })
    writeFileSync(bash, '')
    const resolved = resolveGitBash(undefined, { SCOOP: root })
    assert.equal(resolved.path, bash)
  })

  it('never accepts the WSL launcher in System32', () => {
    const systemRoot = 'C:\\Windows'
    assert.throws(
      () => resolveGitBash(undefined, { PATH: join(systemRoot, 'System32'), SystemRoot: systemRoot }),
      /Git for Windows bash.exe not found/,
    )
  })

  it('reports every checked candidate when nothing is found', () => {
    assert.throws(() => resolveGitBash(undefined, { ProgramFiles: 'C:\\Program Files', PATH: '' }), (error) => {
      assert.match(error.message, /Git for Windows bash.exe not found/)
      assert.match(error.message, /Program Files/)
      return true
    })
  })
})

describe('gitBashCandidates', () => {
  it('deduplicates candidates case-insensitively', () => {
    const candidates = gitBashCandidates({ ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\PROGRAM FILES' })
    const keys = candidates.map((candidate) => candidate.path.toLowerCase())
    assert.equal(new Set(keys).size, keys.length)
  })

  it('lists Program Files before PATH entries', () => {
    const candidates = gitBashCandidates({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\tools' })
    assert.ok(candidates[0].path.startsWith('C:\\Program Files'))
  })
})
