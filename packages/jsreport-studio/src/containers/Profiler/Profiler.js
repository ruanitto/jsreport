import React, { Component } from 'react'
import { connect } from 'react-redux'
import api from '../../helpers/api'
import resolveUrl from '../../helpers/resolveUrl'
import openProfileFromStreamReader from '../../helpers/openProfileFromStreamReader'
import storeMethods from '../../redux/methods'
import { actions as settingsActions } from '../../redux/settings'
import moment from 'moment'
import * as configuration from '../../lib/configuration'
import EntityRefSelect from '../../components/common/EntityRefSelect'

class Profiler extends Component {
  constructor (props) {
    super()
    this.state = { profiles: [], fullProfilingEnabled: false, filterState: props.tab.filterState, filterTemplatesShortids: [] }
  }

  /* static getDerivedStateFromProps (props, state) {
    if (props.tab.filterState !== state.filterState) {
      return {
        filterState: props.tab.filterState
      }
    }
    return null
  } */

  componentDidMount () {
    this.loadProfiles()
    this._interval = setInterval(() => this.loadProfiles(), 5000)

    const profilerSettings = storeMethods.getSettingsByKey('profiler', false)

    this.setState({
      profilerMode: (profilerSettings != null && profilerSettings.mode != null) ? profilerSettings.mode : (configuration.extensions.studio.options.profiler.defaultMode || 'standard')
    })
  }

  async loadProfiles () {
    if (this.profilesLoading) {
      return
    }

    this.profilesLoading = true
    try {
      const url = '/odata/profiles?$top=500&$orderby=timestamp desc'
      let filter = ''
      if (this.state.filterState) {
        filter += `&$filter=state eq '${this.state.filterState}'`
      }
      if (this.state.filterTemplatesShortids.length > 0) {
        const templatesFilter = this.state.filterTemplatesShortids.map(s => `templateShortid eq '${s}'`).join(' or ')
        filter += filter ? ` and (${templatesFilter})` : `&$filter=${templatesFilter}`
      }
      const response = await api.get(url + filter)
      this.setState({
        profiles: response.value.map(p => {
          let template = storeMethods.getEntityByShortid(p.templateShortid, false)

          if (!template) {
            template = { name: 'anonymous', path: 'anonymous' }
          } else {
            template = { ...template, path: storeMethods.resolveEntityPath(template) }
          }

          return {
            ...p,
            template
          }
        })
      })
    } finally {
      this.profilesLoading = false
    }
  }

  componentWillUnmount () {
    clearInterval(this._interval)
  }

  componentDidUpdate () {
    this.loadProfiles()
  }

  stateStyle (state) {
    const style = {
      fontSize: '0.8rem',
      padding: '0.3rem',
      display: 'inline-block',
      textAlign: 'center',
      minWidth: '4rem',
      color: 'white'
    }

    if (state === 'success') {
      style.backgroundColor = '#4CAF50'
    }

    if (state === 'error') {
      style.backgroundColor = '#da532c'
    }

    if (state === 'running') {
      style.backgroundColor = '#007acc'
    }

    if (state === 'queued') {
      style.backgroundColor = '#007acc'
    }

    return style
  }

  renderProfiles (profiles) {
    const { openTab } = this.props

    return (
      <div>
        <div>
          <table className='table' style={{ marginTop: '1rem' }}>
            <thead>
              <tr>
                <th>template</th>
                <th>started</th>
                <th>state</th>
              </tr>
            </thead>
            <tbody>
              {(profiles).map((p, k) => (
                <tr key={k} onClick={() => this.openProfile(p)}>
                  <td className='selection'>
                    <a style={{ textDecoration: 'underline' }} onClick={() => p.template._id ? openTab({ _id: p.template._id }) : null}>
                      {p.template.path}
                    </a>
                  </td>
                  <td>{
                    (new Date().getTime() - new Date(p.timestamp).getTime()) > (1000 * 60 * 60 * 24)
                      ? new Date(p.timestamp).toLocaleString()
                      : moment.duration(moment(new Date()).diff(moment(new Date(p.timestamp)))).humanize() + ' ago'
                      }
                  </td>
                  <td><span style={this.stateStyle(p.state)}>{p.state}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  async openProfile (p) {
    try {
      await openProfileFromStreamReader(async () => {
        const getBlobUrl = resolveUrl(`/api/profile/${p._id}/events`)

        const response = await window.fetch(getBlobUrl, {
          method: 'GET',
          cache: 'no-cache'
        })

        if (response.status !== 200) {
          throw new Error(`Got not ok response, status: ${response.status}`)
        }

        return response.body.getReader()
      }, {
        name: p.template.name,
        shortid: p.template.shortid
      })
    } catch (e) {
      const newError = new Error(`Open profile "${p._id}" failed. ${e.message}`)

      newError.stack = e.stack
      Object.assign(newError, e)

      throw newError
    }
  }

  startFullRequestProfiling () {
    this.props.update('profiler', { mode: 'full' })
    this.setState({
      profilerMode: 'full'
    })
  }

  stopFullRequestProfiling () {
    this.props.update('profiler', { mode: 'standard' })
    this.setState({
      profilerMode: 'standard'
    })
  }

  disableProfiling () {
    this.props.update('profiler', { mode: 'disabled' })
    this.setState({
      profilerMode: 'disabled'
    })
  }

  filterStateChanged (ev) {
    this.setState({
      filterState: ev.target.value === '__blank' ? null : ev.target.value
    })
  }

  filterTemplatesChanged (selected) {
    console.log('chaning', selected)
    this.setState({
      filterTemplatesShortids: selected.map((t) => t.shortid)
    })
  }

  render () {
    return (
      <div className='block custom-editor' style={{ overflow: 'auto', minHeight: 0, height: 'auto' }}>
        <div>
          <h2><i className='fa fa-spinner fa-spin fa-fw' /> profiling</h2>
          <small>
            Profiler now automatically pops up running requests. You can select "Full profiling" to collect additional information like input data and the output report. Note this slightly degrades the request performance and should not be enabled in production permanently.
            The last option is to disable persisting profiles. This means you won't see any requests here. This can be only useful in rare situations when you need to render many simple html reports and every single millisecond matters.
          </small>
          <div style={{ paddingTop: '0.8rem' }}>
            <label>
              <input
                type='radio'
                checked={this.state.profilerMode === 'standard'}
                onChange={(ev) => {
                  ev.target.checked && this.stopFullRequestProfiling()
                }}
              />
              <span>Standard profiling</span>
            </label>
            <label style={{ paddingLeft: '1rem' }}>
              <input
                type='radio'
                checked={this.state.profilerMode === 'full'}
                onChange={(ev) => {
                  ev.target.checked && this.startFullRequestProfiling()
                }}
              />
              <span>Full profiling</span>
            </label>
            <label style={{ paddingLeft: '1rem' }}>
              <input
                type='radio'
                checked={this.state.profilerMode === 'disabled'}
                onChange={(ev) => {
                  ev.target.checked && this.disableProfiling()
                }}
              />
              <span>Disabled profiling</span>
            </label>
          </div>
          <div>
            <hr />
          </div>
          <div style={{ marginTop: '1rem' }}>
            <table>
              <thead>
                <tr>
                  <th>state</th>
                  <th>templates</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ width: '7rem' }}>
                    <select style={{ marginLeft: '0.5rem' }} defaultValue={this.state.filterState} onChange={(ev) => this.filterStateChanged(ev)}>
                      <option value='__blank'> </option>
                      <option>success</option>
                      <option>error</option>
                      <option>running</option>
                      <option>queued</option>
                    </select>
                  </td>
                  <td style={{ minWidth: '15rem' }}>
                    <EntityRefSelect
                      headingLabel='Select template'
                      filter={(references) => ({ templates: references.templates })}
                      value={this.state.filterTemplatesShortids}
                      onChange={(selected) => this.filterTemplatesChanged(selected)}
                      multiple
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        {this.renderProfiles(this.state.profiles)}
      </div>
    )
  }
}

export default connect(
  undefined,
  { ...settingsActions },
  undefined,
  { forwardRef: true }
)(Profiler)
