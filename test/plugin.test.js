// The plugin's three decisions, each of which is about COST rather than about
// correctness — which is why they need testing at all: a check that is too
// expensive to run gets deleted, and a check that crashes the build gets
// deleted faster.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SIBLINGS = path.resolve(ROOT, '..')

function build(workdir, args = [], timeout = 120_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
            ['--no-warnings', path.join(SIBLINGS, 'mikser-io', 'app.js'),
                '--working-folder', workdir, ...args],
            { cwd: path.join(SIBLINGS, 'mikser-io'), stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, NO_COLOR: '1' } })
        let out = ''
        child.stdout.on('data', d => out += d)
        child.stderr.on('data', d => out += d)
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
        child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
        child.on('error', reject)
    })
}

const PAGE = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Home</title>',
    '</head><body><h1>Home</h1><p>A page.</p></body></html>',
].join('\n')

async function fixture(pluginArgs = '') {
    const workdir = await mkdtemp(path.join(tmpdir(), 'mio-lh-'))
    await mkdir(path.join(workdir, 'node_modules'), { recursive: true })
    for (const pkg of ['mikser-io', 'mikser-io-layouts', 'mikser-io-lighthouse']) {
        const target = pkg === 'mikser-io-lighthouse' ? ROOT : path.join(SIBLINGS, pkg)
        await symlink(target, path.join(workdir, 'node_modules', pkg), 'dir').catch(() => {})
    }
    const files = {
        'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { lighthouse } from 'mikser-io-lighthouse'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), lighthouse(${pluginArgs})] }
`,
        'layouts/page.html.hbs': PAGE,
        'documents/index.html': '---\nlayout: page\n---\n',
    }
    for (const [file, content] of Object.entries(files)) {
        const full = path.join(workdir, file)
        await mkdir(path.dirname(full), { recursive: true })
        await writeFile(full, content)
    }
    return workdir
}

describe('a chrome that cannot be started', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('is a fault, not a crash and not silence', async () => {
        // chrome-launcher SPAWNS the binary, and a spawn failure arrives as an
        // unhandled 'error' event on a child process this code does not own —
        // outside any promise, so no try/catch reaches it and the whole build
        // died with a Node stack dump. A pinned Chrome that moved is the
        // ordinary way to get there.
        workdir = await fixture("{ chromePath: '/nonexistent/chrome' }")
        const { code, out } = await build(workdir)
        assert.equal(code, 0, `a missing browser must not fail the build\n${out}`)
        assert.match(out, /\[lighthouse-unavailable\]/, out)
        assert.doesNotMatch(out, /Unhandled 'error' event/, `it used to crash here\n${out}`)
        assert.match(out, /Mikser completed/, out)
    })
})

describe('the dev loop', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('is not audited, because six seconds a save is not a trade anyone takes', async () => {
        // The documented dev model is a watcher always up. A plugin that makes
        // that loop unusable gets deleted rather than configured.
        workdir = await fixture()
        const child = spawn(process.execPath,
            ['--no-warnings', path.join(SIBLINGS, 'mikser-io', 'app.js'),
                '--working-folder', workdir, '--watch'],
            { cwd: path.join(SIBLINGS, 'mikser-io'), stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, NO_COLOR: '1' } })
        let out = ''
        child.stdout.on('data', d => out += d)
        child.stderr.on('data', d => out += d)
        await new Promise(r => setTimeout(r, 12_000))
        child.kill()
        assert.match(out, /Mikser completed/, `the watcher must have built\n${out}`)
        assert.doesNotMatch(out, /\[lighthouse-/, `no audit in watch mode\n${out}`)
    })
})

describe('a one-shot build', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('is audited, and says the scores even when they pass', async () => {
        // "No output" and "not run" look identical otherwise, and this plugin
        // is skipped often enough that the difference matters.
        workdir = await fixture()
        const { code, out } = await build(workdir, [], 180_000)
        assert.equal(code, 0, out)
        assert.match(out, /\[lighthouse-scores\]/, `a passing audit is worth saying\n${out}`)
        assert.match(out, /performance \d+/, out)
        assert.match(out, /accessibility \d+/, out)
    })

    it('reaches the report, not only the console', async () => {
        // Every finding goes through logger.warn with a code, which is the one
        // channel — so the document and the console cannot disagree.
        const { stdout } = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath,
                ['--no-warnings', path.join(SIBLINGS, 'mikser-io', 'app.js'),
                    '--working-folder', workdir, '--force', '--json'],
                { cwd: path.join(SIBLINGS, 'mikser-io'), stdio: ['ignore', 'pipe', 'pipe'],
                  env: { ...process.env, NO_COLOR: '1' } })
            let stdout = ''
            child.stdout.on('data', d => stdout += d)
            const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
            child.on('close', () => { clearTimeout(timer); resolve({ stdout }) })
            child.on('error', reject)
        })
        const report = JSON.parse(stdout)
        const codes = (report.warnings ?? []).map(w => w.code)
        assert.ok(codes.some(c => c.startsWith('lighthouse-')),
            `lighthouse findings must be in the document\n${codes.join(', ')}`)
    })
})
