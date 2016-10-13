#!/usr/bin/env babel-node

require('./helper')

const path = require('path')
const fs = require('fs').promise
const Hapi = require('hapi')
const asyncHandlerPlugin = require('hapi-async-handler')
const Boom = require('boom')
const mime = require('mime-types')

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

async function getLocalFilePathFromRequest(request) {
    const filePath = path.join(__dirname, 'files', request.params.file)
    await fs.stat(filePath).then(stat => request.stat = stat, ()=> request.stat = null)
    return filePath
}

async function readHandler(request, reply) {
    const filePath = await getLocalFilePathFromRequest(request)

    if (null === request.stat) {
        return reply(Boom.notFound(`Invalid path ${request.params.file}`))
    }

    if (request.stat.isDirectory()) {
        let files = await fs.readdir(filePath)
        console.log(`Reading directory ${filePath}`)
        const payload = JSON.stringify(files)
        return reply(payload)
            .type('application/json')
            .header('Content-Length', payload.length)
    }

    console.log(`Reading file ${filePath}`)
    const data = await fs.readFile(filePath, 'utf8')
    return reply(data)
        .type(mime.contentType(path.extname(filePath)))
        .header('Content-Length', data.length)
}

async function createHandler(request, reply) {
    /* eslint no-unused-expressions: 0 */
    const filePath = getLocalFilePathFromRequest(request)

    console.log(`Creating ${filePath}`)

    const stat = await fs.stat(filePath)
    await stat.isDirectory() ? mkdir(filePath) : touch(filePath)
    reply()
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
            handler: {
                async: readHandler
            }
        },
        // CREATE
        {
            method: 'PUT',
            path: '/{file*}',
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
