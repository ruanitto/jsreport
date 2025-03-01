const EventEmitter = require('events')
const extend = require('node.extend.without.arrays')
const generateRequestId = require('../shared/generateRequestId')
const fs = require('fs/promises')

module.exports = (reporter) => {
  reporter.documentStore.registerEntityType('ProfileType', {
    templateShortid: { type: 'Edm.String', referenceTo: 'templates' },
    timestamp: { type: 'Edm.DateTimeOffset', schema: { type: 'null' } },
    finishedOn: { type: 'Edm.DateTimeOffset', schema: { type: 'null' } },
    state: { type: 'Edm.String' },
    error: { type: 'Edm.String' },
    mode: { type: 'Edm.String', schema: { enum: ['full', 'standard', 'disabled'] } },
    blobName: { type: 'Edm.String' }
  })

  reporter.documentStore.registerEntitySet('profiles', {
    entityType: 'jsreport.ProfileType',
    exportable: false
  })

  const profilersMap = new Map()

  const profilerOperationsChainsMap = new Map()
  function runInProfilerChain (fn, req) {
    if (req.context.profiling.mode === 'disabled') {
      return
    }

    profilerOperationsChainsMap.set(req.context.rootId, profilerOperationsChainsMap.get(req.context.rootId).then(async () => {
      if (req.context.profiling.chainFailed) {
        return
      }

      try {
        await fn()
      } catch (e) {
        reporter.logger.warn('Failed persist profile', e)
        req.context.profiling.chainFailed = true
      }
    }))
  }

  function createProfileMessage (m, req) {
    m.timestamp = new Date().getTime()
    m.id = generateRequestId()
    m.previousOperationId = m.previousOperationId || null
    if (m.type !== 'log') {
      m.operationId = m.operationId || generateRequestId()
      req.context.profiling.lastOperationId = m.operationId
      req.context.profiling.lastEventId = m.id
    }

    return m
  }

  function emitProfiles (events, req) {
    if (events.length === 0) {
      return
    }

    let lastOperation

    for (const m of events) {
      if (m.type === 'log') {
        reporter.logger[m.level](m.message, { ...req, ...m.meta, timestamp: m.timestamp })
      } else {
        lastOperation = m
      }

      if (profilersMap.has(req.context.rootId)) {
        profilersMap.get(req.context.rootId).emit('profile', m)
      }
    }

    if (lastOperation != null) {
      req.context.profiling.lastOperation = lastOperation
    }

    runInProfilerChain(() => {
      if (req.context.profiling.logFilePath) {
        return fs.appendFile(req.context.profiling.logFilePath, Buffer.from(events.map(m => JSON.stringify(m)).join('\n') + '\n'))
      }

      return reporter.blobStorage.append(
        req.context.profiling.entity.blobName,
        Buffer.from(events.map(m => JSON.stringify(m)).join('\n') + '\n'), req
      )
    }, req)
  }

  reporter.registerMainAction('profile', async (events, req) => {
    return emitProfiles(events, req)
  })

  reporter.attachProfiler = (req, profileMode) => {
    req.context = req.context || {}
    req.context.rootId = reporter.generateRequestId()
    req.context.profiling = {
      mode: profileMode == null ? 'full' : profileMode
    }
    const profiler = new EventEmitter()
    profilersMap.set(req.context.rootId, profiler)

    return profiler
  }

  reporter.beforeRenderWorkerAllocatedListeners.add('profiler', async (req) => {
    req.context.profiling = req.context.profiling || {}

    if (req.context.profiling.mode == null) {
      const profilerSettings = await reporter.settings.findValue('profiler', req)
      const defaultMode = reporter.options.profiler.defaultMode || 'standard'
      req.context.profiling.mode = (profilerSettings != null && profilerSettings.mode != null) ? profilerSettings.mode : defaultMode
    }

    profilerOperationsChainsMap.set(req.context.rootId, Promise.resolve())

    req.context.profiling.lastOperation = null

    const blobName = `profiles/${req.context.rootId}.log`

    const profile = {
      _id: reporter.documentStore.generateId(),
      timestamp: new Date(),
      state: 'queued',
      mode: req.context.profiling.mode,
      blobName
    }

    if (!reporter.blobStorage.supportsAppend) {
      const { pathToFile } = await reporter.writeTempFile((uuid) => `${uuid}.log`, '')
      req.context.profiling.logFilePath = pathToFile
    }

    runInProfilerChain(async () => {
      req.context.skipValidationFor = profile
      await reporter.documentStore.collection('profiles').insert(profile, req)
    }, req)

    req.context.profiling.entity = profile

    const profileStartOperation = createProfileMessage({
      type: 'operationStart',
      subtype: 'profile',
      data: profile,
      doDiffs: false
    }, req)

    req.context.profiling.profileStartOperationId = profileStartOperation.operationId

    emitProfiles([profileStartOperation], req)

    emitProfiles([createProfileMessage({
      type: 'log',
      level: 'info',
      message: `Render request ${req.context.reportCounter} queued for execution and waiting for availible worker`,
      previousOperationId: profileStartOperation.operationId
    }, req)], req)
  })

  reporter.beforeRenderListeners.add('profiler', async (req, res) => {
    const update = {
      state: 'running'
    }

    const template = await reporter.templates.resolveTemplate(req)
    if (template && template._id) {
      req.context.resolvedTemplate = extend(true, {}, template)
      const templatePath = await reporter.folders.resolveEntityPath(template, 'templates', req)
      const blobName = `profiles/${templatePath.substring(1)}/${req.context.rootId}.log`
      update.templateShortid = template.shortid

      const originalBlobName = req.context.profiling.entity.blobName
      // we want to store the profile into blobName path reflecting the template path so we need to copy the blob to new path now
      runInProfilerChain(async () => {
        if (req.context.profiling.logFilePath == null) {
          const content = await reporter.blobStorage.read(originalBlobName, req)
          await reporter.blobStorage.write(blobName, content, req)
          return reporter.blobStorage.remove(originalBlobName, req)
        }
      }, req)

      update.blobName = blobName
    }

    runInProfilerChain(() => {
      req.context.skipValidationFor = update
      return reporter.documentStore.collection('profiles').update({
        _id: req.context.profiling.entity._id
      }, {
        $set: update
      }, req)
    }, req)

    Object.assign(req.context.profiling.entity, update)
  })

  reporter.afterRenderListeners.add('profiler', async (req, res) => {
    emitProfiles([createProfileMessage({
      type: 'operationEnd',
      doDiffs: false,
      previousEventId: req.context.profiling.lastEventId,
      previousOperationId: req.context.profiling.lastOperationId,
      operationId: req.context.profiling.profileStartOperationId
    }, req)], req)

    res.meta.profileId = req.context.profiling?.entity?._id

    runInProfilerChain(async () => {
      if (req.context.profiling.logFilePath != null) {
        const content = await fs.readFile(req.context.profiling.logFilePath)
        await reporter.blobStorage.write(req.context.profiling.entity.blobName, content, req)
        await fs.unlink(req.context.profiling.logFilePath)
      }

      const update = {
        state: 'success',
        finishedOn: new Date()
      }
      req.context.skipValidationFor = update
      await reporter.documentStore.collection('profiles').update({
        _id: req.context.profiling.entity._id
      }, {
        $set: update
      }, req)
    }, req)

    // we don't remove from profiler requests map, because the renderErrorListeners are invoked if the afterRenderListener fails
  })

  reporter.renderErrorListeners.add('profiler', async (req, res, e) => {
    try {
      res.meta.profileId = req.context.profiling?.entity?._id

      if (req.context.profiling?.entity != null) {
        emitProfiles([{
          type: 'error',
          timestamp: new Date().getTime(),
          ...e,
          id: generateRequestId(),
          stack: e.stack,
          message: e.message
        }], req)
        runInProfilerChain(async () => {
          if (req.context.profiling.logFilePath != null) {
            const content = await fs.readFile(req.context.profiling.logFilePath, 'utf8')
            await reporter.blobStorage.write(req.context.profiling.entity.blobName, content, req)
            await fs.unlink(req.context.profiling.logFilePath)
          }

          const update = {
            state: 'error',
            finishedOn: new Date(),
            error: e.toString()
          }
          req.context.skipValidationFor = update
          await reporter.documentStore.collection('profiles').update({
            _id: req.context.profiling.entity._id
          }, {
            $set: update
          }, req)
        }, req)
      }
    } finally {
      profilersMap.delete(req.context.rootId)
      profilerOperationsChainsMap.delete(req.context.rootId)
    }
  })

  let profilesCleanupInterval
  reporter.initializeListeners.add('profiler', async () => {
    reporter.documentStore.collection('profiles').beforeRemoveListeners.add('profiles', async (query, req) => {
      const profiles = await reporter.documentStore.collection('profiles').find(query, req)

      for (const profile of profiles) {
        await reporter.blobStorage.remove(profile.blobName)
      }
    })

    profilesCleanupInterval = setInterval(profilesCleanup, reporter.options.profiler.cleanupInterval)
    profilesCleanupInterval.unref()
    await profilesCleanup()
  })

  reporter.closeListeners.add('profiler', async () => {
    if (profilesCleanupInterval) {
      clearInterval(profilesCleanupInterval)
    }

    for (const key of profilerOperationsChainsMap.keys()) {
      const profileAppendPromise = profilerOperationsChainsMap.get(key)
      if (profileAppendPromise) {
        await profileAppendPromise
      }
    }
  })

  let profilesCleanupRunning = false
  async function profilesCleanup () {
    if (profilesCleanupRunning) {
      return
    }
    profilesCleanupRunning = true
    let lastRemoveError
    try {
      const profiles = await reporter.documentStore.collection('profiles').find({}).sort({ timestamp: -1 })
      const profilesToRemove = profiles.slice(reporter.options.profiler.maxProfilesHistory)

      for (const profile of profilesToRemove) {
        if (reporter.closed || reporter.closing) {
          return
        }

        try {
          await reporter.documentStore.collection('profiles').remove({
            _id: profile._id
          })
        } catch (e) {
          lastRemoveError = e
        }
      }
    } catch (e) {
      reporter.logger.warn('Profile cleanup failed', e)
    } finally {
      profilesCleanupRunning = false
    }

    if (lastRemoveError) {
      reporter.logger.warn('Profile cleanup failed for some entities, last error:', lastRemoveError)
    }
  }
}
