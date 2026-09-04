// A server for the output, for as long as the audit takes.
//
// Lighthouse measures a page as a browser receives it, so it needs an origin —
// `file://` is not one: no protocol-relative urls, no service worker, no
// caching headers, and several audits silently score differently. So the
// output is served rather than opened.
//
// Ephemeral port, bound to loopback. Not the project's own `--server`: that
// one may not be running, may be serving a different folder, and taking a
// dependency on it would make the audit's result depend on how the developer
// happened to start their day.

import http from 'node:http'
import zlib from 'node:zlib'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml', '.pdf': 'application/pdf',
}

// What a real host compresses. Images, video and woff2 are already
// compressed — running them through gzip costs CPU and produces bytes that
// are usually LARGER, which would then be measured as the page's weight.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript)|image\/svg\+xml)/

// Below this the encoding header costs more than the saving, which is why
// every host ships a floor. Matching the usual nginx default keeps a local
// audit and a deployed one talking about the same set of files.
const COMPRESS_MIN_BYTES = 1024

// Pick an encoding the client asked for, preferring what a modern host would
// choose. Returns null when the client asked for nothing we can do.
function negotiate(acceptEncoding = '') {
    const accepted = String(acceptEncoding).toLowerCase()
    if (/\bbr\b/.test(accepted)) return 'br'
    if (/\bgzip\b/.test(accepted)) return 'gzip'
    return null
}

/**
 * Serve `root` the way a correctly configured static host would.
 *
 * `compress: false` audits the bytes uncompressed, which is worth doing
 * deliberately — but it is not the default, because the default should be a
 * page measured against a host that is set up properly. Whether the REAL host
 * compresses is a question about that host, and answering it here would mean
 * every audit reported a finding the deployed site may not have.
 */
export async function serveOutput(root, { compress = true } = {}) {
    const server = http.createServer(async (request, response) => {
        try {
            const url = decodeURIComponent((request.url ?? '/').split('?')[0])
            // Contained: a request cannot climb out of the output folder, even
            // though this only ever listens on loopback for a few seconds.
            let file = path.resolve(root, `.${url}`)
            if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) {
                response.writeHead(403); response.end(); return
            }
            let info = await stat(file).catch(() => null)
            // cleanUrls puts a page at <name>/index.html, which is what the
            // links point at — so a directory has to resolve the way a real
            // server resolves it or every audit lands on a 404.
            if (info?.isDirectory()) {
                file = path.join(file, 'index.html')
                info = await stat(file).catch(() => null)
            }
            if (!info?.isFile()) { response.writeHead(404); response.end('not found'); return }

            const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
            const encoding = compress && COMPRESSIBLE.test(type) && info.size >= COMPRESS_MIN_BYTES
                ? negotiate(request.headers['accept-encoding'])
                : null

            const headers = {
                'content-type': type,
                // Lighthouse reports an uncached response as a finding, and on
                // a static host it would be cached. Saying so keeps the audit
                // about the SITE rather than about this throwaway server.
                'cache-control': 'public, max-age=3600',
            }
            if (encoding) {
                headers['content-encoding'] = encoding
                // A cache in front must not hand a compressed body to a client
                // that did not ask. Real hosts send it; so does this, so the
                // response is the same shape a browser will meet in production.
                headers.vary = 'Accept-Encoding'
                // No content-length: the compressed size is not known until it
                // has been produced, and streaming it chunked is what a host
                // does too. Lighthouse measures the bytes that arrive.
            } else {
                headers['content-length'] = info.size
            }
            response.writeHead(200, headers)

            const source = createReadStream(file)
            if (!encoding) { source.pipe(response); return }
            const codec = encoding === 'br'
                // Quality 5 rather than the default 11: a host serving
                // dynamically picks a middling level too, and 11 would spend
                // seconds per file for bytes the audit does not care about.
                ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
                : zlib.createGzip({ level: 6 })
            source.pipe(codec).pipe(response)
        } catch {
            response.writeHead(500); response.end()
        }
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    return {
        origin: `http://127.0.0.1:${port}`,
        async close() { await new Promise(resolve => server.close(resolve)) },
    }
}
