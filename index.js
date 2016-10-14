#!/usr/bin/env babel-node

require('./helper')

const path = require('path')
const fs = require('fs').promise
const Hapi = require('hapi')
const asyncHandlerPlugin = require('hapi-async-handler')
const Boom = require('boom')
const mime = require('mime-types')
const archiver = require('archiver')

async function mkdir(filePath) {
    // Use 'await' in here
    var elements = filePath.split('/')
    var dir = elements[0] === '' ? '/' : ''
    for (let e of elements) {
        dir = path.join(dir, e)
        await fs.stat(dir).then(stat => {
            if (stat.isFile()) {
                console.log('Error: ' + dir + " is an existing file")
                return
            }
            if (!stat.isDirectory()) fs.mkdir(dir)
        }, err => {
            fs.mkdir(dir)
        })
    }
}

async function touch(filePath) {
    // Use 'await' in here
    let [fd, stat] = await Promise.all([
        fs.open(filePath, 'wx'),
        fs.stat(filePath)
    ])

    await fs.futimes(fd, stat.atime.getTime(), Date.now() / 1000)
}

async function rm(filePath) {
    // Use 'await' in here
    function onException(err) {
        console.log(err.message)
    }

    let stat = await fs.stat(filePath).catch(onException)
    if (stat === undefined) return
    if (!stat.isDirectory()) await fs.unlink(filePath).catch(onException)
    else await fs.rmdir(filePath).catch(onException)
}

function getLocalFilePathFromRequest(request) {
    return path.join(__dirname, 'files', request.params.file)
}

const preStat = async function (request, reply) {
    const filePath = getLocalFilePathFromRequest(request)
    await fs.stat(filePath).then(stat => reply(stat), ()=> reply(null))
}

const preMimeType = async function (request, reply) {
    const stat = request.pre.stat

    if (null === stat) reply(null)
    else if (stat.isDirectory()) {
        // curl  http://127.0.0.1:8000/dir1 -H "Accept: application/x-gtar" --head
        if (request.headers['accept'] === 'application/x-gtar') reply('application/zip')
        else reply('application/json')
    }
    else reply(mime.contentType(path.extname(request.params.file)))
}

async function readHandler(request, reply) {
    const filePath = getLocalFilePathFromRequest(request)
    const stat = request.pre.stat

    if (null === stat) return reply(Boom.notFound(`Invalid path ${request.params.file}`))

    const mimeType = request.pre.mimeType

    if (request.method == 'head') return reply().type(mimeType)

    if (stat.isDirectory()) {
        if (mimeType === 'application/zip') {
            let archive = archiver('zip')
            console.log(`Archiving directory ${filePath}`)
            archive
                .bulk([{
                    expand: true,
                    cwd: filePath,
                    src: ['**'],
                    dest: '.'
                }])
                .finalize()

            return reply(archive)
                .type(mimeType)
        }
        else {
            let files = await fs.readdir(filePath)
            console.log(`Reading directory ${filePath}`)
            const payload = JSON.stringify(files)
            return reply(payload)
                .type(mimeType)
                .header('Content-Length', payload.length)
        }
    }

    console.log(`Reading file ${filePath}`)
    const data = await fs.readFile(filePath, 'utf8')
    return reply(data)
        .type(mimeType)
        .header('Content-Length', data.length)
}

async function createHandler(request, reply) {
    const stat = request.pre.stat

    if (stat !== null) return reply(Boom.methodNotAllowed(`${request.params.file} exists`))

    const filePath = getLocalFilePathFromRequest(request)

    let endsWithSlash = filePath.charAt(filePath.length - 1) === path.sep
    let hasExt = path.extname(filePath) !== ''

    if (endsWithSlash || !hasExt) {
        console.log(`Making directory ${filePath}`)
        mkdir(filePath)

        reply(`Created directory ${filePath}`)
    } else {
        console.log(`Creating file ${filePath}`)
        const writable = require('fs').createWriteStream(filePath)

        const readable = request.payload
        readable.pipe(writable)

        writable.on('finish', () => {
            reply(`Created file ${request.params.file}`)
        })
    }
}

async function updateHandler(request, reply) {
    const filePath = getLocalFilePathFromRequest(request)

    console.log(`Updating ${filePath}`)
    await fs.writeFile(filePath, request.payload)
    reply()
}

async function deleteHandler(request, reply) {
    const filePath = getLocalFilePathFromRequest(request)

    console.log(`Deleting ${filePath}`)
    await rm(filePath)
    reply()
}

async function main() {
    const port = 8000
    const server = new Hapi.Server({
        debug: {
            request: ['errors']
        }
    })
    server.register(asyncHandlerPlugin)
    server.connection({port})

    server.route([
        // READ
        {
            method: 'GET',
            path: '/{file*}',
            config: {
                pre: [
                    {method: preStat, assign: 'stat'},
                    {method: preMimeType, assign: 'mimeType'}
                ]
            },
            handler: {
                async: readHandler
            }
        },
        // CREATE
        {
            method: 'PUT',
            path: '/{file*}',
            config: {
                pre: [
                    {method: preStat, assign: 'stat'}
                ],
                payload: {
                    output: 'stream',
                    parse: false
                }
            },
            handler: {
                async: createHandler
            }
        },
        // UPDATE
        {
            method: 'POST',
            path: '/{file*}',
            handler: {
                async: updateHandler
            }
        },
        // DELETE
        {
            method: 'DELETE',
            path: '/{file*}',
            handler: {
                async: deleteHandler
            }
        }
    ])

    await server.start()
    console.log(`LISTENING @ http://127.0.0.1:${port}`)
}

main()
