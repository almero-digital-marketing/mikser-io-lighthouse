// The plugin's three decisions, each of which is about COST rather than about
// correctness — which is why they need testing at all: a check that is too
// expensive to run gets deleted, and a check that crashes the build gets
// deleted faster.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
    // The img is deliberate: it fails `unsized-images`, which is the only
    // way to exercise the exclusion path without a page that trips a
    // server-shaped audit — a trivial local page trips none of those.
    '</head><body><h1>Home</h1><p>A page.</p><img src="/a.png" alt="a"></body></html>',
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
        const { code, out } = await build(workdir, ['--lighthouse'])
        assert.equal(code, 0, `a missing browser must not fail the build\n${out}`)
        assert.match(out, /\[lighthouse-unavailable\]/, out)
        assert.doesNotMatch(out, /Unhandled 'error' event/, `it used to crash here\n${out}`)
        assert.match(out, /Mikser completed/, out)
    })
})

describe('the dev loop', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('is not audited without the flag, whatever mode the build is in', async () => {
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
        const { code, out } = await build(workdir, ['--lighthouse'], 180_000)
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
                    '--working-folder', workdir, '--force', '--lighthouse', '--json'],
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

// "The dev loop" is not "watch mode", and conflating the two made this plugin
// never run at all on the projects it was written for.
//
// An instance is ALWAYS in watch or server mode, and a build a person types
// while one is running is FORWARDED to it — so a skip keyed on `watch` skipped
// every build on a project whose documented model is a watcher always up. The
// audit never ran, on either side, and said nothing. Core answers the real
// question with `runtime.options.requested`: true for a build a client asked
// for, false for a cycle the watcher triggered itself.

describe('a build typed while a watcher is running', () => {
    let workdir, instance
    after(async () => {
        instance?.kill()
        await rm(workdir, { recursive: true, force: true })
    })

    it('is audited when the flag is passed, and not otherwise', async () => {
        workdir = await fixture()
        await build(workdir, [], 180_000)

        instance = spawn(process.execPath,
            ['--no-warnings', path.join(SIBLINGS, 'mikser-io', 'app.js'),
                '--working-folder', workdir, '--watch'],
            { cwd: path.join(SIBLINGS, 'mikser-io'), stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, NO_COLOR: '1' } })
        let instanceOut = ''
        instance.stdout.on('data', d => instanceOut += d)
        instance.stderr.on('data', d => instanceOut += d)

        const endpoint = path.join(SIBLINGS, 'mikser-io')
        for (let i = 0; i < 200 && !instanceOut.includes('Instance socket'); i++) {
            await new Promise(r => setTimeout(r, 100))
        }
        assert.ok(instanceOut.includes('Instance socket'), `the instance must be listening\n${instanceOut}`)

        // A plain forwarded build must not audit — an upgrade script runs
        // nine of these per release check, and each one auditing added three
        // minutes to a two-minute check.
        const plain = await build(workdir, ['--force'], 180_000)
        assert.doesNotMatch(plain.out, /\[lighthouse-scores\]/,
            `only an explicit ask audits\n${plain.out}`)

        // And the flag has to survive forwarding: the instance parsed its own
        // argv and never saw the client's, so a plugin option that does not
        // travel works with nothing listening and silently does nothing with a
        // watcher up.
        const { out } = await build(workdir, ['--force', '--lighthouse'], 180_000)
        assert.match(out, /\[lighthouse-scores\]/,
            `--lighthouse must reach the instance answering the build\n${out}`)

        // And the watcher's own cycle is not. Counted from the instance's own
        // output: one audit happened (the forwarded one, replayed there too),
        // and editing a document adds none.
        const before = (instanceOut.match(/\[lighthouse-scores\]/g) ?? []).length
        await writeFile(path.join(workdir, 'documents/index.html'),
            '---\nlayout: page\ntitle: edited\n---\n')
        await new Promise(r => setTimeout(r, 9000))
        const after = (instanceOut.match(/\[lighthouse-scores\]/g) ?? []).length
        assert.equal(after, before,
            `an edit must not cost six seconds a save\n${instanceOut.slice(-800)}`)
    })
})

// A cycle that moved nothing produced the bytes the last one did, so the audit
// would reprint the last audit — for six seconds a page. Measured downstream
// at 19 SECONDS for a no-op build, which is what a settled tree costs on every
// verification run.
//
// And the stand-down is LOUD. The flag was passed, so someone is waiting for
// scores and getting none; "audited and fine" and "did not run" are
// indistinguishable otherwise. That is the argument this plugin already makes
// one level down about printing scores even when they pass, applied to the
// skip itself.

describe('a build that moved nothing', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('is not audited, and says so rather than costing six seconds a page', async () => {
        workdir = await fixture()
        // First build renders; second moves nothing.
        await build(workdir, ['--lighthouse'], 180_000)

        const started = Date.now()
        const { code, out } = await build(workdir, ['--lighthouse'], 180_000)
        const elapsed = Date.now() - started

        assert.equal(code, 0, out)
        assert.match(out, /\[lighthouse-not-run\]/,
            `a stand-down someone asked for has to say why\n${out}`)
        assert.match(out, /nothing rendered and nothing changed/, out)
        assert.doesNotMatch(out, /\[lighthouse-scores\]/, 'and must not have audited')
        assert.ok(elapsed < 8000,
            `a no-op must not pay for an audit; took ${elapsed}ms`)
    })

    it('audits again under --force, which is the way back', async () => {
        const { out } = await build(workdir, ['--lighthouse', '--force'], 180_000)
        assert.match(out, /\[lighthouse-scores\]/, out)
    })
})

describe('audits that measure the audit server', () => {
    let workdir
    after(() => rm(workdir, { recursive: true, force: true }))

    it('are excluded, because they are unactionable by construction', async () => {
        // The output is served from an ephemeral loopback process, so cache
        // lifetimes, compression and response time are facts about that
        // throwaway server — in production they are nginx's. A finding nobody
        // can act on trains a reader to skim the ones they can.
        //
        // Exercised through `excludeAudits` with an audit this page really
        // does fail, since a trivial local page does not trip the
        // server-shaped ones on its own.
        workdir = await fixture("{ excludeAudits: ['unsized-images'] }")
        const { out } = await build(workdir, ['--lighthouse'], 180_000)
        assert.match(out, /Not reported — excluded by config: unsized-images/, out)
        assert.doesNotMatch(out, /\[lighthouse-unsized-images\]/,
            `an excluded audit must not also be reported\n${out}`)
        assert.match(out, /\[lighthouse-summary\]/, out)
    })
})
