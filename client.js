/**
 * Created by binwei on 10/14/16.
 */

require('./helper')

const net = require('net')
const JsonSocket = require('json-socket')
const request = require('request')
const unzip = require('unzip2')
const fs = require('fs')
const path = require('path')
const rimraf = require('rimraf').promise

const argv = require('yargs')
    .default('dir', process.cwd())
    .argv

let {mkdir, rm, ls, touch} = require('./crud')

const chokidar = require('chokidar')
const fileUpdateMap = {}

function main() {
    const tcpPort = 8001
    const host = '127.0.0.1'
    const httpServerUrl = `http://${host}:8000/`

    const ROOT_DIR = path.resolve(argv.dir)
    const watcher = chokidar.watch(ROOT_DIR, {ignored: /[\/\\]\./})

    function getLocalFilePath(filePath) {
        return path.join(ROOT_DIR, filePath)
    }

    var socket = new JsonSocket(new net.Socket())
    socket.connect(tcpPort, host)

    socket.on('connect', function () {
        console.log('client connection established')

        //
        // ------- Initial file system sync -------
        //
        let options = {
            url: httpServerUrl,
            headers: {'Accept': 'application/x-gtar'}
        }

        console.log(`download all files from ${httpServerUrl} and unzip to ${ROOT_DIR}`)
        let readStream = request(options, httpServerUrl)
        readStream.pipe(unzip.Extract({path: ROOT_DIR}), {end: false})
        readStream.on('end', async() => {
            // start to watch files but ignore the side effect of the file changes due to initial sync
            const currentFiles = await ls(ROOT_DIR)
            for (let file of currentFiles) {
                let stat = await fs.promise.stat(file)
                fileUpdateMap[file] = stat.mtime.getTime()
            }

            watcher
                .on('add', watchFileAdd)
                .on('change', watchFileChange)
                .on('unlink', watchFileDeletion)
                .on('addDir', watchDirChange)
                .on('unlinkDir', watchDirDeletion)
        })

        //
        // ------- JSON message handlers -------
        //
        socket.on('message', async function (message) {
            console.log('received message from server: %j', message)
            // if this is triggered by local update followed by server broadcast -- we need to stop the message chain here
            if (shouldIgnoreMessage(message)) {
                return
            }

            let localFilePath = getLocalFilePath(message.path)
            if (message.action === 'delete') {
                if (message.type === 'file') await rm(localFilePath)
                else await rimraf(localFilePath)
                console.log('Deleted ' + localFilePath)

                // this is triggered by remote server broadcast -- no need to trigger another request to server again
                watcher.unwatch(localFilePath)
            } else { // "update"
                if (message.type == 'dir') await mkdir(localFilePath)
                else request({url: httpServerUrl + message.path}, httpServerUrl).pipe(fs.createWriteStream(localFilePath, 'utf-8'))
                console.log('Created/updated ' + localFilePath)

                // this is triggered by remote server broadcast -- no need to trigger another request to server again
                let stat = await fs.promise.stat(localFilePath)
                fileUpdateMap[localFilePath] = stat.mtime.getTime()
            }
        })
    })

    //
    // ------- FS watcher handlers -------
    //
    // send message to TCP server
    // action: 'delete' or 'update/write'
    // path: relative path of file/dir
    async function sendJsonMessageOverTcp(action, path, isDir) {
        let absolutePath = getLocalFilePath(path || '')
        const message = {action: action, path: path, type: isDir ? 'dir' : 'file', updated: Date.now()}
        await fs.promise.stat(absolutePath).then(stat => {
                // file/dir is updated locally -- overwrite the updated time with the mtime -- the server will relay the same updated time
                message.updated = stat.mtime.getTime()
            },
            err => {
                // file/dir is deleted locally -- use the current time
                console.log('%s %s already deleted', message.type, absolutePath)
            }
        )
        fileUpdateMap[absolutePath] = message.updated
        socket.sendMessage(message)
        console.log('sending server message %j', message)
    }

    function shouldIgnoreMessage(message) {
        let absolutePath = getLocalFilePath(message.path || '')
        if (absolutePath in fileUpdateMap) return fileUpdateMap[absolutePath] >= message.updated
        else return false
    }

    async function shouldWatchFile(absolutePath) {
        let stat = await fs.promise.stat(absolutePath)
        if (absolutePath in fileUpdateMap) return fileUpdateMap[absolutePath] < stat.mtime.getTime()
        else return true
    }

    async function watchFileAdd(absolutePath) {
        const fileChanged = await shouldWatchFile(absolutePath)
        if (fileChanged) sendJsonMessageOverTcp('update', path.relative(ROOT_DIR, absolutePath), false)
    }

    async function watchFileChange(absolutePath) {
        const fileChanged = await shouldWatchFile(absolutePath)
        if (fileChanged) {
            let relativePath = path.relative(ROOT_DIR, absolutePath)
            let postUrl = httpServerUrl + relativePath
            console.log(`post file change for ${absolutePath} to ${postUrl}`)
            let readStream = fs.createReadStream(absolutePath)
            readStream.pipe(request.post(postUrl), {end: false})
            // this is to avoid the echo message from the server
            readStream.on('end', () => {
                fileUpdateMap[absolutePath] = Date.now()
            })
        }
    }

    async function watchFileDeletion(absolutePath) {
        sendJsonMessageOverTcp('delete', path.relative(ROOT_DIR, absolutePath), false)
    }

    async function watchDirChange(absolutePath) {
        const fileChanged = await shouldWatchFile(absolutePath)
        if (fileChanged) sendJsonMessageOverTcp('update', path.relative(ROOT_DIR, absolutePath), true)
    }

    async function watchDirDeletion(absolutePath) {
        sendJsonMessageOverTcp('delete', path.relative(ROOT_DIR, absolutePath), true)
    }
}

// npm run client -- --dir /tmp/client-test/
main()