#!/usr/bin/env babel-node

require('./helper')

const path = require('path')
const fs = require('fs').promise
const Hapi = require('hapi')
const asyncHandlerPlugin = require('hapi-async-handler')
const boom = require('boom')
const mime = require('mime-types')
const archiver = require('archiver')
const rimraf = require('rimraf').promise
const argv = require('yargs')
    .default('dir', process.cwd())
    .argv

const ROOT_DIR = path.resolve(argv.dir)

const net = require('net')
const JsonSocket = require('json-socket')

const jsonSockets = []

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
    return path.join(ROOT_DIR, request.params.file || '')
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

    if (null === stat) return reply(boom.notFound(`Invalid path ${request.params.file}`))

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

function appendMessage(action, path, isDir) {
    const message = {action: action, path: path, type: isDir ? 'dir' : 'file', updated: Date.now()}
    for (let s of jsonSockets) {
        s.sendMessage(message)
    }
}

async function createHandler(request, reply) {
    const stat = request.pre.stat

    if (stat !== null) return reply(boom.methodNotAllowed(`${request.params.file} exists`))

    const filePath = getLocalFilePathFromRequest(request)

    let endsWithSlash = filePath.charAt(filePath.length - 1) === path.sep
    let hasExt = path.extname(filePath) !== ''

    if (endsWithSlash || !hasExt) {
        console.log(`Making directory ${filePath}`)
        mkdir(filePath)

        appendMessage("write", request.params.file, true)
        reply(`Created directory ${filePath}`)
    } else {
        console.log(`Creating file ${filePath}`)
        const writable = require('fs').createWriteStream(filePath)

        const readable = request.payload
        readable.pipe(writable)

        writable.on('finish', () => {
            appendMessage("write", request.params.file, false)
            reply(`Created file ${request.params.file}`)
        })
    }
}

// curl -X POST -H "Content-Type: application/json" -d '{"key1":"value"}' http://127.0.0.1:8000/bar.txt
// curl -X PUT -H "Content-Type: text/html" -d @files/foo.txt http://127.0.0.1:8000/bar.txt
async function updateHandler(request, reply) {
    const stat = request.pre.stat

    if (stat === null) return reply(boom.notFound(`Invalid path ${request.params.file}`))
    if (stat.isDirectory()) return reply(boom.methodNotAllowed(`${request.params.file} is a directory`))

    const filePath = getLocalFilePathFromRequest(request)

    console.log(`Updating ${filePath}`)
    const writable = require('fs').createWriteStream(filePath)

    const readable = request.payload
    readable.pipe(writable)

    writable.on('finish', () => {
        appendMessage("write", request.params.file, false)
        reply(`Updated file ${request.params.file}`)
    })
}

async function deleteHandler(request, reply) {
    const stat = request.pre.stat

    if (stat === null) return reply(boom.notFound(`Invalid path ${request.params.file}`))

    const filePath = getLocalFilePathFromRequest(request)
    console.log(`Deleting ${filePath}`)

    if (stat.isDirectory()) await rimraf(filePath)
    else await rm(filePath)

    appendMessage("delete", request.params.file, stat.isDirectory())
    reply(`Deleted ${request.params.file}`)
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
                async: updateHandler
            }
        },
        // DELETE
        {
            method: 'DELETE',
            path: '/{file*}',
            config: {
                pre: [
                    {method: preStat, assign: 'stat'}
                ]
            },
            handler: {
                async: deleteHandler
            }
        }
    ])

    await server.start()
    console.log(`LISTENING @ http://127.0.0.1:${port}`)

    const tcpPort = 8001
    const tcpServer = net.createServer()
    tcpServer.listen(tcpPort, function () {
        console.log(`TCP Server @ http://127.0.0.1:${tcpPort}`)
    })

    tcpServer.on('connection', handleTcpConnection)
}

function handleTcpConnection(socket) {
    var remoteAddress = socket.remoteAddress + ':' + socket.remotePort;
    console.log('new client connection from %s', remoteAddress);

    socket = new JsonSocket(socket)
    jsonSockets.push(socket)

    socket.on('message', onJsonMessage);
    socket.on('close', onSocketClose);
    socket.on('error', onSocketError);

    function onJsonMessage(message) {
        console.log('connection data from %s: %j', remoteAddress, message);
        socket.sendMessage(message);
    }

    function onSocketClose() {
        jsonSockets.remove(socket)
        console.log('connection from %s closed', remoteAddress);
    }

    function onSocketError(err) {
        console.log('Connection %s error: %s', remoteAddress, err.message);
    }
}

main()
