module.exports = {
  name: 'scheduling',
  main: 'lib/main.js',
  optionsSchema: {
    extensions: {
      scheduling: {
        type: 'object',
        properties: {
          autoStart: { type: 'boolean' },
          interval: {
            type: ['string', 'number'],
            '$jsreport-acceptsDuration': true
          },
          minScheduleInterval: {
            type: ['string', 'number'],
            '$jsreport-acceptsDuration': true
          },
          misfireThreshold: {
            type: ['string', 'number'],
            '$jsreport-acceptsDuration': true
          },
          maxParallelJobs: { type: 'number' },
          taskPingTimeout: {
            type: ['string', 'number'],
            '$jsreport-acceptsDuration': true
          },
          cleanScheduleHistoryInterval: {
            type: ['string', 'number'],
            '$jsreport-acceptsDuration': true
          },
          maxHistoryPerSchedule: { type: 'number' }
        }
      }
    }
  },
  dependencies: ['reports'],
  requires: {
    core: '3.x.x',
    studio: '3.x.x',
    reports: '3.x.x'
  },
  skipInExeRender: true
}
