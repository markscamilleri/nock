import back, { BackMode, backModes } from './lib/back.js'
import emitter from './lib/global_emitter.js'
import {
  activate,
  isActive,
  isDone,
  isOn,
  pendingMocks,
  activeMocks,
  removeInterceptor,
  disableNetConnect,
  enableNetConnect,
  removeAll,
  abortPendingRequests,
} from './lib/intercept.js'
import recorder from './lib/recorder.js'
import { Scope, load, loadDefs, define } from './lib/scope.js'
import { Options } from './lib/types/options.js'

function nock(basePath: string, options?: Options) {
  return new Scope(basePath, options)
}

nock.activate = activate
nock.isActive = isActive
nock.isDone = isDone
nock.pendingMocks = pendingMocks
nock.activeMocks = activeMocks
nock.removeInterceptor = removeInterceptor
nock.disableNetConnect = disableNetConnect
nock.enableNetConnect = enableNetConnect
nock.cleanAll = removeAll
nock.abortPendingRequests = abortPendingRequests
nock.load = load
nock.loadDefs = loadDefs
nock.define = define
nock.emitter = emitter
nock.recorder = {
  rec: recorder.record,
  clear: recorder.clear,
  play: recorder.outputs,
}
nock.restore = recorder.restore
nock.back = back

export default nock

// We always activate Nock on import, overriding the globals.
// Setting the Back mode "activates" Nock by overriding the global entries in the `http/s` modules.
// If Nock Back is configured, we need to honor that setting for backward compatibility,
// otherwise we rely on Nock Back's default initializing side effect.
if (isOn()) {
  const isBackMode = (mode: string | undefined): mode is BackMode =>
    mode !== undefined && mode in backModes

  if (isBackMode(process.env.NOCK_BACK_MODE)) {
    back.setMode(process.env.NOCK_BACK_MODE)
  } else back.setMode('dryrun')
}
