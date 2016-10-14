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

let {mkdir, rm} = require('./fileUtils')

function main() {
    const tcpPort = 8001
    const host = '127.0.0.1'
    const httpServerUrl = `http://${host}:8000/`

    const ROOT_DIR = path.resolve(argv.dir)
    function getLocalFilePath(filePath) {
        return path.join(ROOT_DIR, filePath)
    }

    var socket = new JsonSocket(new net.Socket())
    socket.connect(tcpPort, host)

    socket.on('connect', function () {
        console.log('client connection established')

        let options = {
            url: httpServerUrl,
            headers: {'Accept': 'application/x-gtar'}
        }

        console.log(`download all files from ${httpServerUrl} and unzip to ${ROOT_DIR}`)
        request(options, httpServerUrl).pipe(unzip.Extract({path: ROOT_DIR}))

        socket.on('message', async function (message) {
            console.log('Server message: ' + message.action + ' ' + message.path + ' ' + message.type + ' ' + message.updated)

            let localFilePath = getLocalFilePath(message.path);
            if (message.action === 'delete') {
                if (message.type === 'file') await rm(localFilePath)
                else await rimraf(localFilePath)
                console.log('Deleted ' + localFilePath)
            } else { // "update"
                if (message.type == 'dir') await mkdir(localFilePath)
                else request({url: httpServerUrl + message.path}, httpServerUrl).pipe(fs.createWriteStream(localFilePath, 'utf-8'))
                console.log('Created/updated ' + localFilePath)
            }
        })
    })
}

// npm run client -- --dir /tmp/client-test/
main()