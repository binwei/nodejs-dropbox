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

// record outstanding client sockets -- used for broadcasting each message
const jsonSockets = []

let {mkdir, rm, ls, touch} = require('./crud')

const chokidar = require('chokidar')
// temporarily block file/dir being updated/deleted via http request -- otherwise duplicate messages will be sent to clients
const unwatchedFiles = []

function getLocalFilePathFromRequest(request) {
    return path.join(ROOT_DIR, request.params.file || '')
}

// pre processing to get file/dir stat
const preStat = async function (request, reply) {
    const filePath = getLocalFilePathFromRequest(request)
    await fs.stat(filePath).then(stat => reply(stat), ()=> reply(null))
}

// pre processing to get mime type
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

    // no separate HEAD handler
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

// broadcast message to TCP clients
// action: 'delete' or 'update/write'
// path: relative path of file/dir
function sendJsonMessageOverTcp(action, path, isDir) {
    const message = {action: action, path: path, type: isDir ? 'dir' : 'file', updated: Date.now()}
    console.log('broadcasting message %j', message)
    for (let s of jsonSockets) {
        s.sendMessage(message)
    }
}

// curl -X PUT -H "Content-Type: text/html" -d @files/foo.txt http://127.0.0.1:8000/bar.txt
async function createHandler(request, reply) {
    const stat = request.pre.stat

    if (stat !== null) return reply(boom.methodNotAllowed(`${request.params.file} exists`))

    const filePath = getLocalFilePathFromRequest(request)

    let endsWithSlash = filePath.charAt(filePath.length - 1) === path.sep
    let hasExt = path.extname(filePath) !== ''

    unwatchedFiles.push(filePath)

    if (endsWithSlash || !hasExt) {
        console.log(`Making directory ${filePath}`)
        mkdir(filePath)

        sendJsonMessageOverTcp("write", request.params.file, true)
        reply(`Created directory ${filePath}`)
    } else {
        console.log(`Creating file ${filePath}`)
        const writable = require('fs').createWriteStream(filePath)

        const readable = request.payload
        readable.pipe(writable)

        writable.on('finish', () => {
            sendJsonMessageOverTcp("write", request.params.file, false)
            reply(`Created file ${request.params.file}`)
        })
    }
}

// curl -X POST --data-binary @/tmp/hello.txt http://127.0.0.1:8000/bar.txt
// curl -X POST -H "Content-Type: application/json" -d '{"key1":"value"}' http://127.0.0.1:8000/bar.txt
async function updateHandler(request, reply) {
    const stat = request.pre.stat

    if (stat === null) return reply(boom.notFound(`Invalid path ${request.params.file}`))
    if (stat.isDirectory()) return reply(boom.methodNotAllowed(`${request.params.file} is a directory`))

    const filePath = getLocalFilePathFromRequest(request)

    unwatchedFiles.push(filePath)

    console.log(`Updating ${filePath}`)
    const writable = require('fs').createWriteStream(filePath, {flag: 'w+'})

    const readable = request.payload
    readable.pipe(writable)

    writable.on('finish', () => {
        sendJsonMessageOverTcp("write", request.params.file, false)
        reply(`Updated file ${request.params.file}`)
    })
}

async function deleteHandler(request, reply) {
    const stat = request.pre.stat

    if (stat === null) return reply(boom.notFound(`Invalid path ${request.params.file}`))

    const filePath = getLocalFilePathFromRequest(request)
    console.log(`Deleting ${filePath}`)

    unwatchedFiles.push(filePath)

    if (stat.isDirectory()) await rimraf(filePath)
    else await rm(filePath)

    sendJsonMessageOverTcp("delete", request.params.file, stat.isDirectory())
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

    let watcher = chokidar.watch(ROOT_DIR, {ignored: /[\/\\]\./})
    watcher
        .on('add', watchFileChange)
        .on('change', watchFileChange)
        .on('unlink', watchFileDeletion)
        .on('addDir', watchDirChange)
        .on('unlinkDir', watchDirDeletion)
}

//
// ------- TCP connection handler -------
//
function handleTcpConnection(socket) {
    var remoteAddress = socket.remoteAddress + ':' + socket.remotePort;
    console.log('new client connection from %s', remoteAddress);

    socket = new JsonSocket(socket)
    jsonSockets.push(socket)

    socket.on('message', onJsonMessage);
    socket.on('close', onSocketClose);
    socket.on('error', onSocketError);

    async function onJsonMessage(message) {
        console.log('Received client request from %s: %j', remoteAddress, message)
        for (let s of jsonSockets) {
            s.sendMessage(message)
        }
        const filePath = path.join(ROOT_DIR, message.path || '')
        unwatchedFiles.push(filePath)
        if (message.action === 'delete') {
            console.log('Deleting on behalf of client %s %s', message.type, filePath)
            if (message.type === 'dir') await rimraf(filePath)
            else await rm(filePath)
        } else {
            console.log('Making %s %s on behalf of client', message.type, filePath)
            if (message.type === 'dir') await mkdir(filePath)
            else await touch(filePath)
        }
    }

    function onSocketClose() {
        let i = jsonSockets.indexOf(socket)
        if (i !== -1) jsonSockets.splice(i, 1)
        console.log('connection from %s closed', remoteAddress)
    }

    function onSocketError(err) {
        console.log('Connection %s error: %s', remoteAddress, err.message)
    }
}

//
// ------- FS watcher handlers -------
//
function removeUnwatchedFile(absolutePath) {
    let i = unwatchedFiles.indexOf(absolutePath)
    if (i !== -1) unwatchedFiles.splice(i, 1)
    return i === -1
}

function watchFileChange(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) sendJsonMessageOverTcp('update', path.relative(ROOT_DIR, absolutePath), false)
}

function watchFileDeletion(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) sendJsonMessageOverTcp('delete', path.relative(ROOT_DIR, absolutePath), false)
}

function watchDirChange(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) sendJsonMessageOverTcp('update', path.relative(ROOT_DIR, absolutePath), true)
}

function watchDirDeletion(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) sendJsonMessageOverTcp('delete', path.relative(ROOT_DIR, absolutePath), true)
}

// npm start -- --dir files
main()
