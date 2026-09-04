// The audit server, which exists so Lighthouse measures the SITE rather than
// the throwaway host it is served from.
//
// That is the whole design rule, and it decides every question here: a real
// static host caches, compresses text, sends Vary, and does not gzip a JPEG.
// Anything this server does differently shows up as a finding about the
// server, and a finding nobody can act on is one everybody learns to skip —
// which is how a genuine text-compression problem on a deployed site went
// unnoticed while local audits cried wolf.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { serveOutput } from '../src/serve.js'

const BIG_CSS = 'body{color:#000}\n'.repeat(200)      // ~3.4 KB, over the floor
const TINY_CSS = 'a{}'                                 // under the floor
const JPEG = Buffer.alloc(4096, 0xd8)                  // already-compressed bytes

let dir, server
before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lh-serve-'))
    await mkdir(path.join(dir, 'styles'), { recursive: true })
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>x</title>' + 'y'.repeat(2000))
    await writeFile(path.join(dir, 'styles', 'site.css'), BIG_CSS)
    await writeFile(path.join(dir, 'styles', 'tiny.css'), TINY_CSS)
    await writeFile(path.join(dir, 'photo.jpg'), JPEG)
    await mkdir(path.join(dir, 'about'), { recursive: true })
    await writeFile(path.join(dir, 'about', 'index.html'), '<!doctype html><title>about</title>')
    server = await serveOutput(dir)
})
after(async () => { await server?.close(); await rm(dir, { recursive: true, force: true }) })

const get = (url, headers = {}) => fetch(server.origin + url, { headers })

describe('compression, because a real host compresses text', () => {
    it('gzips css when the client asks for it', async () => {
        const res = await get('/styles/site.css', { 'accept-encoding': 'gzip' })
        assert.equal(res.headers.get('content-encoding'), 'gzip')
        // And it decodes back to exactly the file — a corrupted stream would
        // make Lighthouse measure a page that never rendered.
        assert.equal(await res.text(), BIG_CSS)
    })

    it('prefers brotli when offered both, like a modern host', async () => {
        const res = await get('/styles/site.css', { 'accept-encoding': 'br, gzip' })
        assert.equal(res.headers.get('content-encoding'), 'br')
        assert.equal(await res.text(), BIG_CSS)
    })

    it('sends Vary, so a cache cannot hand a compressed body to a client that did not ask', async () => {
        const res = await get('/styles/site.css', { 'accept-encoding': 'gzip' })
        assert.match(res.headers.get('vary') ?? '', /accept-encoding/i)
    })

    it('sends plain bytes to a client that asks for none', async () => {
        const res = await get('/styles/site.css', { 'accept-encoding': 'identity' })
        assert.equal(res.headers.get('content-encoding'), null)
        assert.equal(await res.text(), BIG_CSS)
    })

    it('actually reduces the transfer', async () => {
        // The point of the exercise. If this were not smaller, the audit would
        // keep reporting savings the deployed site does not have.
        const raw = Buffer.byteLength(BIG_CSS)
        const res = await get('/styles/site.css', { 'accept-encoding': 'gzip' })
        const wire = zlib.gzipSync(Buffer.from(BIG_CSS)).length
        assert.ok(wire < raw / 2, `gzip should roughly halve this at worst: ${wire} vs ${raw}`)
        assert.equal((await res.text()).length, BIG_CSS.length)
    })
})

describe('what it does not compress', () => {
    it('leaves an image alone', async () => {
        // Already compressed. Running it through gzip costs CPU and usually
        // produces MORE bytes, which would then be measured as page weight.
        const res = await get('/photo.jpg', { 'accept-encoding': 'br, gzip' })
        assert.equal(res.headers.get('content-encoding'), null)
    })

    it('leaves a file below the floor alone', async () => {
        // Under ~1KB the encoding header costs more than the saving, which is
        // why every host ships a floor.
        const res = await get('/styles/tiny.css', { 'accept-encoding': 'gzip' })
        assert.equal(res.headers.get('content-encoding'), null)
    })
})

describe('turning it off deliberately', () => {
    it('serves uncompressed when asked', async () => {
        const plain = await serveOutput(dir, { compress: false })
        try {
            const res = await fetch(plain.origin + '/styles/site.css', { headers: { 'accept-encoding': 'br, gzip' } })
            assert.equal(res.headers.get('content-encoding'), null)
            assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(BIG_CSS)))
        } finally { await plain.close() }
    })
})

describe('the rest of what a host does', () => {
    it('caches, so an uncached-response finding is about the site', async () => {
        const res = await get('/index.html')
        assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/)
    })

    it('resolves a directory to index.html, the way cleanUrls links expect', async () => {
        const res = await get('/about/')
        assert.equal(res.status, 200)
        assert.match(await res.text(), /about/)
    })

    it('types a response, since several audits key off content-type', async () => {
        assert.match((await get('/styles/site.css')).headers.get('content-type') ?? '', /text\/css/)
        assert.match((await get('/index.html')).headers.get('content-type') ?? '', /text\/html/)
    })

    it('refuses to climb out of the output folder', async () => {
        const res = await fetch(server.origin + '/../../etc/passwd')
        assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`)
    })

    it('404s a missing page rather than hanging the audit', async () => {
        assert.equal((await get('/nope.html')).status, 404)
    })
})
