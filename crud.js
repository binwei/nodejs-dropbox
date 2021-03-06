/**
 * Created by byang4 on 10/14/16.
 */

require('./helper')

const path = require('path')
const fs = require('fs').promise

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

async function ls(filePath) {
    let stat = await fs.stat(filePath)
    if (!stat.isDirectory()) return [filePath]

    let fileNames = []
    fileNames.push(filePath)

    for (let fileName of await fs.readdir(filePath)) {
        // Obtain the stat promise from fs.stat(filePath)
        var childPath = path.join(filePath, fileName)
        let result = await ls(childPath)
        fileNames.push(...result)
    }

    return fileNames
}

async function touch(filePath) {
    // Use 'await' in here
    let [fd, stat] = await Promise.all([
        fs.open(filePath, 'a+'),
        fs.stat(filePath)
    ])

    await fs.futimes(fd, stat.atime.getTime(), Date.now() / 1000)
}

module.exports = {mkdir, rm, ls, touch}
