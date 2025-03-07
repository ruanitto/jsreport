/*!
 * Copyright(c) 2018 Jan Blaha
 *
 * Reporter main class including all methods jsreport-core exposes.
 */
const path = require('path')
const { Readable } = require('stream')
const Reaper = require('reap2')
const optionsLoad = require('./optionsLoad')
const { createLogger, configureLogger, silentLogs } = require('./logger')
const checkEntityName = require('./validateEntityName')
const DocumentStore = require('./store/documentStore')
const BlobStorage = require('./blobStorage/blobStorage')
const ExtensionsManager = require('./extensions/extensionsManager')
const Settings = require('./settings')
const SchemaValidator = require('./schemaValidator')
const { getRootSchemaOptions, extendRootSchemaOptions } = require('./optionsSchema')
const Templates = require('./templates')
const Folders = require('./folders')
const WorkersManager = require('@jsreport/advanced-workers')
const { validateDuplicatedName } = require('./folders/validateDuplicatedName')
const { validateReservedName } = require('./folders/validateReservedName')
const setupValidateId = require('./store/setupValidateId')
const setupValidateShortid = require('./store/setupValidateShortid')
const documentStoreActions = require('./store/mainActions')
const blobStorageActions = require('./blobStorage/mainActions')
const Reporter = require('../shared/reporter')
const Request = require('./request')
const generateRequestId = require('../shared/generateRequestId')
const Profiler = require('./profiler')
const migrateXlsxTemplatesToAssets = require('./migration/xlsxTemplatesToAssets')
const migrateResourcesToAssets = require('./migration/resourcesToAssets')
const semver = require('semver')
let reportCounter = 0

class MainReporter extends Reporter {
  constructor (options, defaults) {
    super(options)

    if (!semver.satisfies(process.versions.node, '>=16.11.0')) {
      throw this.createError('jsreport needs at least node 16.11.0 to run.')
    }

    this.defaults = defaults || {}
    this._fnAfterConfigLoaded = () => {}
    this._reaperTimerRef = null
    this._extraPathsToCleanupCollection = new Set()

    this._initialized = false
    this._initializing = false

    this._initExecution = {}

    this._initExecution.promise = new Promise((resolve, reject) => {
      this._initExecution.resolve = resolve
      this._initExecution.reject = resolve
    })

    this._mainActions = new Map()

    this.settings = new Settings()
    this.extensionsManager = ExtensionsManager(this)

    this.optionsValidator = new SchemaValidator({
      rootSchema: getRootSchemaOptions()
    })

    this.entityTypeValidator = new SchemaValidator()

    this.logger = createLogger()
    this.beforeMainActionListeners = this.createListenerCollection('beforeMainAction')
    this.beforeRenderWorkerAllocatedListeners = this.createListenerCollection('beforeRenderWorkerAllocated')
  }

  discover () {
    this.options.discover = true
    return this
  }

  /**
   * Manual registration of the extension. Once calling `use` the auto discovery of extensions is turned off if not explicitly
   * turned on.
   * jsreport.use(require('@jsreport/jsreport-jsrender')())
   * @param {Object || Function} extensions
   * @return {Reporter} for chaining
   * @public
   */
  use (extension) {
    this.extensionsManager.use(extension)
    return this
  }

  async extensionsLoad (opts) {
    const appliedConfigFile = await optionsLoad({
      defaults: this.defaults,
      options: this.options,
      validator: this.optionsValidator,
      onConfigLoaded: async () => {
        await this._fnAfterConfigLoaded(this)
      }
    })

    configureLogger(this.logger, this.options.logger)

    if (this.options.logger && this.options.logger.silent === true) {
      silentLogs(this.logger)
    }

    this.logger.info(`Initializing jsreport (version: ${this.version}, configuration file: ${appliedConfigFile || 'none'}, nodejs: ${process.versions.node})`)

    await this.extensionsManager.load(opts)

    const newRootSchema = extendRootSchemaOptions(
      getRootSchemaOptions(),
      this.extensionsManager.availableExtensions.map(ex => ({
        name: ex.name,
        schema: ex.optionsSchema
      }))
    )

    this.optionsValidator.setRootSchema(newRootSchema)

    const rootOptionsValidation = this.optionsValidator.validateRoot(this.options, {
      rootPrefix: 'rootOptions',
      // extensions was validated already in extensions load
      ignore: ['properties.extensions']
    })

    if (!rootOptionsValidation.valid) {
      throw new Error(`options contain values that does not match the defined full root schema. ${rootOptionsValidation.fullErrorMessage}`)
    }

    return this
  }

  /**
   * Hook to alter configuration after it was loaded and merged
   * jsreport.afterConfigLoaded(function(reporter) { .. do your stuff ..})
   *
   *
   * @public
   */
  afterConfigLoaded (fn) {
    this._fnAfterConfigLoaded = fn
    return this
  }

  async waitForInit () {
    await this._initExecution.promise
  }

  /**
   * Required async method to be called before rendering.
   *
   * @return {Promise} initialization is done, promise value is Reporter instance for chaining
   * @public
   */
  async init () {
    this.closing = this.closed = false
    if (this._initialized || this._initializing) {
      throw new Error('jsreport already initialized or just initializing. Make sure init is called only once')
    }

    super.init()

    this._initializing = true

    if (this.compilation) {
      this.compilation.resource('vm2-events.js', require.resolve('vm2/lib/events.js'))
      this.compilation.resource('vm2-resolver-compat.js', require.resolve('vm2/lib/resolver-compat.js'))
      this.compilation.resource('vm2-resolver.js', require.resolve('vm2/lib/resolver.js'))
      this.compilation.resource('vm2-setup-node-sandbox.js', require.resolve('vm2/lib/setup-node-sandbox.js'))
      this.compilation.resource('vm2-setup-sandbox.js', require.resolve('vm2/lib/setup-sandbox.js'))
    }

    try {
      this._registerLogMainAction()
      await this.extensionsLoad()

      this.documentStore = DocumentStore(Object.assign({}, this.options, { logger: this.logger }), this.entityTypeValidator, this.encryption)
      documentStoreActions(this)
      this.blobStorage = BlobStorage(this, this.options)
      blobStorageActions(this)
      Templates(this)
      Profiler(this)

      this.folders = Object.assign(this.folders, Folders(this))

      this.settings.registerEntity(this.documentStore)

      this.options.blobStorage = this.options.blobStorage || {}

      if (this.options.blobStorage.provider == null) {
        this.options.blobStorage.provider = this.options.store.provider
      }

      if (this.options.blobStorage.provider === 'memory') {
        this.blobStorage.registerProvider(require('./blobStorage/inMemoryProvider.js')(this.options))
      }

      await this.extensionsManager.init()

      this.logger.info(`Using general timeout for rendering (reportTimeout: ${this.options.reportTimeout})`)

      if (this.options.store.provider === 'memory') {
        this.logger.info(`Using ${this.options.store.provider} provider for template store. The saved templates will be lost after restart`)
      } else {
        this.logger.info(`Using ${this.options.store.provider} provider for template store.`)
      }

      await this.documentStore.init()
      await this.blobStorage.init()
      await this.settings.init(this.documentStore, this.authorization)

      const extensionsForWorkers = this.extensionsManager.extensions.filter(e => e.worker)

      const workersManagerOptions = {
        ...this.options.sandbox,
        options: { ...this.options },
        // we do map and copy to unproxy the value
        extensionsDefs: extensionsForWorkers.map(e => Object.assign({}, e)),
        documentStore: {
          // we do copy to unproxy the value of entityTypes
          model: {
            ...this.documentStore.model,
            entityTypes: { ...this.documentStore.model.entityTypes }
          },
          collections: Object.keys(this.documentStore.collections)
        }
      }

      const workersManagerSystemOptions = {
        initTimeout: this.options.workers.initTimeout,
        numberOfWorkers: this.options.workers.numberOfWorkers,
        workerModule: path.join(__dirname, '../worker', 'workerHandler.js'),
        resourceLimits: this.options.workers.resourceLimits
      }

      // adding the validation of shortid after extensions has been loaded
      setupValidateId(this)
      setupValidateShortid(this)

      this.initializeListeners.insert(0, 'core-resources-migration', () => migrateResourcesToAssets(this))
      this.initializeListeners.insert(0, 'core-xlsxTemplates-migration', () => migrateXlsxTemplatesToAssets(this))

      await this.initializeListeners.fire()

      this._workersManager = this._workersManagerFactory
        ? this._workersManagerFactory(workersManagerOptions, workersManagerSystemOptions)
        : WorkersManager(workersManagerOptions, workersManagerSystemOptions, this.logger)

      const workersStart = new Date().getTime()

      this.logger.info('Initializing worker threads')

      this.logger.debug(`Extensions in workers: ${extensionsForWorkers.map((e) => e.name).join(', ')}`)

      await this._workersManager.init(workersManagerOptions)

      this.logger.info(`${this.options.workers.numberOfWorkers} worker threads initialized in ${new Date().getTime() - workersStart}ms`)

      this._startReaper(this.getPathsToWatchForAutoCleanup())

      this.extensionsManager.recipes.push({
        name: 'html'
      })

      this.extensionsManager.engines.push({
        name: 'none'
      })

      this.logger.info('reporter initialized')
      this._initialized = true
      this._initExecution.resolve()
      return this
    } catch (e) {
      this.logger.error(`Error occurred during reporter init: ${e.stack}`)
      this._initExecution.reject(new Error(`Reporter initialization failed. ${e.message}`))
      throw e
    }
  }

  /**
   * @public
   */
  addPathToWatchForAutoCleanup (customPath) {
    this._extraPathsToCleanupCollection.add(customPath)
  }

  /**
   * @public
   */
  getPathsToWatchForAutoCleanup () {
    return [this.options.tempAutoCleanupDirectory].concat(Array.from(this._extraPathsToCleanupCollection.values()))
  }

  async checkValidEntityName (c, doc, req) {
    if (!this.documentStore.model.entitySets[c].entityTypeDef.name) {
      return
    }

    checkEntityName(doc.name)

    await validateDuplicatedName(this, c, doc, undefined, req)

    await validateReservedName(this, c, doc)
  }

  async _handleRenderError (req, res, err) {
    if (err.code === 'WORKER_TIMEOUT') {
      err.message = 'Report timeout'
      if (req.context.profiling?.lastOperation != null && req.context.profiling?.entity != null) {
        err.message += `. Last profiler operation: (${req.context.profiling.lastOperation.subtype}) ${req.context.profiling.lastOperation.name}`
      }

      if (req.context.http != null) {
        const profileUrl = `${req.context.http.baseUrl}/studio/profiles/${req.context.profiling.entity._id}`
        err.message += `. You can inspect and find more details here: ${profileUrl}`
      }

      err.weak = true
    }

    if (err.code === 'WORKER_ABORTED') {
      err.message = 'Report cancelled'
      err.weak = true
    }

    if (!err.logged) {
      const logFn = err.weak ? this.logger.warn : this.logger.error
      logFn(`Report render failed: ${err.message}${err.stack != null ? ' ' + err.stack : ''}`, req)
    }
    await this.renderErrorListeners.fire(req, res, err)
    throw err
  }

  /**
   * Main method for invoking rendering
   * render({ template: { content: 'foo', engine: 'none', recipe: 'html' }, data: { foo: 'hello' } })
   *
   * @request {Object}
   * @return {Promise} response.content is output buffer, response.stream is output stream, response.headers contains http applicable headers
   *
   * @public
   */
  async render (req, options = {}) {
    if (!this._initialized) {
      throw new Error('Not initialized, you need to call jsreport.init().then before rendering')
    }

    req = Object.assign({}, req)
    req.context = Object.assign({}, req.context)
    req.context.rootId = req.context.rootId || generateRequestId()
    req.context.id = req.context.rootId
    req.context.reportCounter = ++reportCounter

    let worker
    let workerAborted
    let dontCloseProcessing
    const res = { meta: {} }
    try {
      await this.beforeRenderWorkerAllocatedListeners.fire(req)

      worker = await this._workersManager.allocate(req, {
        timeout: this.getReportTimeout()
      })

      if (options.abortEmitter) {
        options.abortEmitter.once('abort', () => {
          if (workerAborted) {
            return
          }
          workerAborted = true
          worker.release(req).catch((e) => this.logger.error('Failed to release worker ' + e))
        })
      }

      if (workerAborted) {
        throw this.createError('Request aborted by client')
      }

      if (req.rawContent) {
        const result = await worker.execute({
          actionName: 'parse',
          req,
          data: {}
        }, {
          timeout: this.getReportTimeout()
        })
        req = result
      }

      req = Request(req)

      // TODO: we will probably validate in the thread
      if (this.entityTypeValidator.getSchema('TemplateType') != null) {
        const templateValidationResult = this.entityTypeValidator.validate('TemplateType', req.template, { rootPrefix: 'template' })

        if (!templateValidationResult.valid) {
          throw this.createError(`template input in request contain values that does not match the defined schema. ${templateValidationResult.fullErrorMessage}`, {
            statusCode: 400
          })
        }
      }

      const reportTimeout = this.getReportTimeout(req)

      await this.beforeRenderListeners.fire(req, res, { worker })

      if (workerAborted) {
        throw this.createError('Request aborted by client')
      }

      if (req.context.clientNotification) {
        process.nextTick(async () => {
          try {
            const responseResult = await this.executeWorkerAction('render', {}, {
              timeout: reportTimeout + this.options.reportTimeoutMargin,
              worker
            }, req)

            Object.assign(res, responseResult)
            await this.afterRenderListeners.fire(req, res)
          } catch (err) {
            await this._handleRenderError(req, res, err).catch((e) => {})
          } finally {
            if (!workerAborted) {
              await worker.release(req)
            }
          }
        })

        dontCloseProcessing = true
        const r = {
          ...req.context.clientNotification,
          stream: Readable.from(req.context.clientNotification.content)
        }
        delete req.context.clientNotification
        return r
      }

      if (workerAborted) {
        throw this.createError('Request aborted by client')
      }

      const responseResult = await this.executeWorkerAction('render', {}, {
        timeout: reportTimeout + this.options.reportTimeoutMargin,
        worker
      }, req)

      Object.assign(res, responseResult)
      await this.afterRenderListeners.fire(req, res)
      res.stream = Readable.from(res.content)
      return res
    } catch (err) {
      await this._handleRenderError(req, res, err)
      throw err
    } finally {
      if (worker && !workerAborted && !dontCloseProcessing) {
        await worker.release(req)
      }
    }
  }

  registerWorkersManagerFactory (workersManagerFactory) {
    this._workersManagerFactory = workersManagerFactory
  }

  /**
   *
   * @public
   */
  async close () {
    this.closing = true
    this.logger.info('Closing jsreport instance')

    if (this.monitoring) {
      await this.monitoring.close()
    }

    if (this._reaperTimerRef) {
      clearInterval(this._reaperTimerRef)
    }

    await this.closeListeners.fire()

    if (this._workersManager) {
      await this._workersManager.close()
    }

    if (this.documentStore) {
      await this.documentStore.close()
    }

    this.logger.info('jsreport instance has been closed')
    this.closed = true

    return this
  }

  registerMainAction (actionName, fn) {
    this._mainActions.set(actionName, fn)
  }

  async _invokeMainAction (data, req) {
    await this.beforeMainActionListeners.fire(data.actionName, data.data, req)
    if (!this._mainActions.has(data.actionName)) {
      throw this.createError(`Main process action ${data.actionName} wasn't registered`)
    }
    return this._mainActions.get(data.actionName)(data.data, req)
  }

  _registerLogMainAction () {
    this.registerMainAction('log', (log, req) => {
      this.logger[log.level](log.message, { ...req, ...log.meta, timestamp: log.timestamp })
    })
  }

  async executeWorkerAction (actionName, data, options = {}, req) {
    req.context.rootId = req.context.rootId || generateRequestId()
    const timeout = options.timeout || 60000

    const worker = options.worker
      ? options.worker
      : await this._workersManager.allocate(req, {
        timeout
      })

    try {
      const result = await worker.execute({
        actionName,
        data,
        // we set just known props, to avoid cloning failures on express req properties
        req: {
          context: req.context,
          template: req.template,
          data: req.data,
          options: req.options
        }
      }, {
        timeout,
        timeoutErrorMessage: options.timeoutErrorMessage || ('Timeout during worker action ' + actionName),
        executeMain: async (data) => {
          return this._invokeMainAction(data, req)
        }
      })
      this._workersManager.convertUint8ArrayToBuffer(result)
      return result
    } finally {
      if (!options.worker) {
        await worker.release(req)
      }
    }
  }

  /**
   * Periodical cleaning of folders where recipes are storing files like source html for pdf rendering
   *
   * @private
   */
  _startReaper (dir) {
    const dirsToWatch = !Array.isArray(dir) ? [dir] : dir

    if (this.options.autoTempCleanup === false) {
      return
    }

    const reportTimeout = this.getReportTimeout()

    const threshold = reportTimeout > 180000 ? reportTimeout : 180000

    this.logger.info(`Starting temp files cleanup with ${threshold}ms threshold`)

    const reaper = new Reaper({ threshold })

    dirsToWatch.forEach(d => reaper.watch(d))

    reaper.start((err, files) => {
      if (err) {
        this.logger.error(`Failed to start auto cleanup: ${err.stack}`)
      }
    })

    this._reaperTimerRef = setInterval(() => {
      try {
        reaper.start((err, files) => {
          if (err) {
            // NOT logging the error anymore because it was confusing users that something bad was happening
            // this.logger.error('Failed to delete temp file: ' + err)
          }
        })
      } catch (e) {
        // NOT logging the error anymore because it was confusing users that something bad was happening
        // catch error in case the reaper can not read directory
        // this.logger.error('Failed to run reaper: ' + e)
      }
    }, 30000 /* check every 30s for old files */)

    this._reaperTimerRef.unref()
  }
}

module.exports = MainReporter
