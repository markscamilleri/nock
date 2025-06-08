import assert from 'node:assert'
import recorder, { RecorderOptions } from './recorder.js'
import {
  activate,
  disableNetConnect,
  enableNetConnect,
  removeAll as cleanAll,
} from './intercept.js'
import { loadDefs, define, type Scope } from './scope.js'
import { back as debug } from './debug.js'
import { format } from 'node:util'
import path from 'node:path'
import type { NockedFn, Definition } from './types/index.js'
import fs from 'node:fs'
import type { InterceptorSurface } from './interceptor.js'

export const backModes = [
  'wild',
  'dryrun',
  'record',
  'update',
  'lockdown',
] as const

export type BackMode = (typeof backModes)[number]
type Mode = {
  setup: () => void
  start: (fixture: string, options?: BackOptions) => BackContext
  finish: (
    fixture: string,
    options?: BackOptions,
    context?: BackContext,
  ) => void
}

export interface BackOptions {
  before?: (def: Definition) => void
  after?: (scope: Scope) => void
  afterRecord?: (defs: Definition[]) => Definition[] | string
  recorder?: RecorderOptions
}

interface BackContext {
  isLoaded?: boolean
  scopes: Scope[]
  assertScopesFinished(): void
  query?: () => InterceptorSurface[]
  isRecording?: boolean
}

let _mode: Mode | null = null

/**
 * nock the current function with the fixture given
 *
 * @param {string}   fixtureName  - the name of the fixture, e.x. 'foo.json'
 * @param {object |}   optionsOrFn      - [optional] extra options for nock with, e.x. `{ assert: true }`
 * @param {function} nockedFn     - [optional] callback function to be executed with the given fixture being loaded;
 *                                  if defined the function will be called with context `{ scopes: loaded_nocks || [] }`
 *                                  set as `this` and `nockDone` callback function as first and only parameter;
 *                                  if not defined a promise resolving to `{nockDone, context}` where `context` is
 *                                  aforementioned `{ scopes: loaded_nocks || [] }`
 *
 * List of options:
 *
 * @param {function} before       - a preprocessing function, gets called before nock.define
 * @param {function} after        - a postprocessing function, gets called after nock.define
 * @param {function} afterRecord  - a postprocessing function, gets called after recording. Is passed the array
 *                                  of scopes recorded and should return the array scopes to save to the fixture
 * @param {function} recorder     - custom options to pass to the recorder
 *
 */
function Back(fixtureName: string, nockedFn: NockedFn): void
function Back(
  fixtureName: string,
  options: BackOptions,
  nockedFn: NockedFn,
): void
function Back(
  fixtureName: string,
  options?: BackOptions,
): Promise<{
  nockDone: () => void
  context: BackContext
}>
function Back(
  fixtureName: string,
  optionsOrFn?: BackOptions | NockedFn,
  nockedFn?: NockedFn,
) {
  if (!Back.fixtures) {
    throw new Error(
      'Back requires nock.back.fixtures to be set\n' +
        'Ex:\n' +
        "\trequire(nock).back.fixtures = '/path/to/fixtures/'",
    )
  }

  if (typeof fixtureName !== 'string') {
    throw new Error('Parameter fixtureName must be a string')
  }

  let options: BackOptions = {}

  if (arguments.length === 1) {
    options = {}
  } else if (arguments.length === 2) {
    // If 2nd parameter is a function then `options` has been omitted
    // otherwise `options` haven't been omitted but `nockedFn` was.
    if (typeof optionsOrFn === 'function') {
      nockedFn = optionsOrFn
      options = {}
    }
  } else {
    // arguments.length === 3
    // This is to ensure that `optionsOrFn` is an object
    // so that we can safely use it as options.
    if (typeof optionsOrFn !== 'object') {
      throw new Error(
        'Expected options to be an object, got: ' +
          typeof optionsOrFn +
          ' instead.',
      )
    }
    options = optionsOrFn
  }

  _mode?.setup()

  const fixture = path.join(Back.fixtures, fixtureName)
  const context = _mode?.start(fixture, options)

  const nockDone = function () {
    _mode?.finish(fixture, options, context)
  }

  debug('context:', context)
  // If nockedFn is a function then invoke it, otherwise return a promise resolving to nockDone.
  if (typeof nockedFn === 'function') {
    nockedFn.call(context, nockDone)
  } else {
    return Promise.resolve({ nockDone, context })
  }
}

Back.currentMode = null as unknown as BackMode
Back.fixtures = null as unknown as string
Back.setMode = function (mode: BackMode) {
  if (!(mode in Modes)) {
    throw new Error(`Unknown mode: ${mode}`)
  }

  Back.currentMode = mode
  debug('New nock back mode:', Back.currentMode)

  _mode = Modes[mode]
  _mode.setup()
}

export default Back

/***
 * ****************************************************************************
 *                                    Modes                                     *
 *******************************************************************************/

const Modes: Record<BackMode, Mode> = {
  // all requests go out to the internet, dont replay anything, doesnt record anything
  wild: {
    setup: function () {
      cleanAll()
      recorder.restore()
      activate()
      enableNetConnect()
    },

    start: function () {
      return load() // don't load anything but get correct context
    },

    finish: function () {
      // nothing to do
    },
  },
  // use recorded nocks, allow http calls, doesnt record anything, useful for writing new tests (default)
  dryrun: {
    setup: function () {
      recorder.restore()
      cleanAll()
      activate()
      //  We have to explicitly enable net connectivity as by default it's off.
      enableNetConnect()
    },

    start: function (fixture, options) {
      const contexts = load(fixture, options)

      enableNetConnect()
      return contexts
    },

    finish: function () {
      // nothing to do
    },
  },
  // use recorded nocks, record new nocks
  record: {
    setup: function () {
      recorder.restore()
      recorder.clear()
      cleanAll()
      activate()
      disableNetConnect()
    },

    start: function (fixture, options) {
      if (!fs) {
        throw new Error('no fs')
      }
      const context = load(fixture, options)

      if (!context.isLoaded) {
        recorder.record({
          dont_print: true,
          output_objects: true,
          ...options?.recorder,
        })

        context.isRecording = true
      }

      return context
    },

    finish: function (fixture, options, context) {
      if (context?.isRecording) {
        const definitions = recorder.outputs()
        let outputs: Definition[] | string = definitions

        if (typeof options?.afterRecord === 'function') {
          outputs = options?.afterRecord(definitions)
        }

        outputs =
          typeof outputs === 'string'
            ? outputs
            : JSON.stringify(outputs, null, 4)
        debug('recorder outputs:', outputs)

        fs.mkdirSync(path.dirname(fixture), { recursive: true })
        fs.writeFileSync(fixture, outputs)
      }
    },
  },
  // allow http calls, record all nocks, don't use recorded nocks
  update: {
    setup: function () {
      recorder.restore()
      recorder.clear()
      cleanAll()
      activate()
      disableNetConnect()
    },

    start: function (fixture, options) {
      if (!fs) {
        throw new Error('no fs')
      }
      const context: BackContext = removeFixture(fixture)
      recorder.record({
        dont_print: true,
        output_objects: true,
        ...options?.recorder,
      })

      context.isRecording = true

      return context
    },

    finish: function (fixture, options, context) {
      const outputs = recorder.outputs()

      let transformedOutputs =
        typeof options?.afterRecord === 'function'
          ? options.afterRecord(outputs)
          : outputs

      transformedOutputs =
        typeof transformedOutputs === 'string'
          ? transformedOutputs
          : JSON.stringify(outputs, null, 4)
      debug('recorder outputs:', transformedOutputs)

      fs.mkdirSync(path.dirname(fixture), { recursive: true })
      fs.writeFileSync(fixture, transformedOutputs)
    },
  },
  // use recorded nocks, disables all http calls even when not nocked, doesnt record
  lockdown: {
    setup: function () {
      recorder.restore()
      recorder.clear()
      cleanAll()
      activate()
      disableNetConnect()
    },

    start: function (fixture, options) {
      return load(fixture, options)
    },

    finish: function () {
      // nothing to do
    },
  },
}

function load(fixture?: fs.PathLike, options?: BackOptions) {
  const context: BackContext = {
    scopes: [],
    assertScopesFinished: function () {
      assertScopes(this.scopes, fixture)
    },
    query: function () {
      const nested: InterceptorSurface[][] = this.scopes.map(scope =>
        scope.interceptors.map(interceptor => ({
          method: interceptor.method,
          uri: interceptor.uri,
          basePath: interceptor.basePath,
          path: interceptor.path,
          queries: interceptor.queries,
          counter: interceptor.counter,
          body: interceptor.body,
          statusCode: interceptor.statusCode,
          optional: interceptor.optional,
        })),
      )

      return new Array().concat.apply([], nested)
    },
  }

  if (fixture && fixtureExists(fixture)) {
    const defintiions: Definition[] = loadDefs(fixture)
    applyHook(defintiions, options?.before)

    const scopes = define(defintiions)
    applyHook(scopes, options?.after)

    context.scopes = scopes
    context.isLoaded = true
  }

  return context
}

function removeFixture(fixture: fs.PathLike): BackContext {
  if (fixture && fixtureExists(fixture)) {
    /* istanbul ignore next - fs.unlinkSync is for node 10 support */
    fs.rmSync ? fs.rmSync(fixture) : fs.unlinkSync(fixture)
  }

  const context: BackContext = {
    scopes: [],
    assertScopesFinished: function () {},
    isLoaded: false,
  }

  return context
}

function applyHook<HookType extends Scope | Definition>(
  scopes: HookType[],
  fn?: (scope: HookType) => void,
) {
  if (!fn) {
    return
  }

  if (typeof fn !== 'function') {
    throw new Error('processing hooks must be a function')
  }

  scopes.forEach(fn)
}

function fixtureExists(fixture: fs.PathLike) {
  if (!fs) {
    throw new Error('no fs')
  }

  return fs.existsSync(fixture)
}

function assertScopes(scopes: Scope[], fixture?: fs.PathLike) {
  const pending = scopes
    .filter(scope => !scope.isDone())
    .map(scope => scope.pendingMocks())

  if (pending.length) {
    assert.fail(
      format(
        '%j was not used, consider removing %s to rerecord fixture',
        new Array<string>().concat(...pending),
        fixture,
      ),
    )
  }
}
