const { Worker } = require('worker_threads')
const path = require('path')
const ThreadWorker = require('./threadWorker')
const convertUint8ArrayToBuffer = require('./convertUint8ArrayToBuffer')
const pool = require('./pool')

module.exports = (userOptions, {
  workerModule,
  numberOfWorkers,
  resourceLimits,
  initTimeout
}) => {
  function createWorker () {
    const worker = new Worker(path.join(__dirname, 'workerHandler.js'), {
      workerData: {
        systemData: {
          workerModule
        },
        userData: userOptions
      },
      resourceLimits
    })

    return ThreadWorker({
      worker,
      initTimeout
    })
  }

  return {
    async init () {
      this.pool = pool({
        createWorker: () => createWorker(),
        numberOfWorkers,
        initTimeout
      })
      return this.pool.init()
    },

    async allocate () {
      return this.pool.allocate()
    },

    close () {
      if (this.closed) {
        return
      }

      this.closed = true
      return this.pool.close()
    },

    convertUint8ArrayToBuffer
  }
}
