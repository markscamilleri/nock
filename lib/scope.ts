/**
 * @module nock/scope
 */
import { scopeDebuglog } from './debug.js'
import { addInterceptor, isOn } from './intercept.js'
import common from './common.js'
import assert from 'node:assert'
import url, { URL, Url as LegacyUrl } from 'node:url'
import { EventEmitter } from 'node:events'
import Interceptor from './interceptor.js'
import fs from 'node:fs'
import { DebugLogger } from 'node:util'
import {
  isLegacyUrl,
  URI,
  Options,
  RequestBodyMatcher,
  Definition,
} from './types/index.js'

/**
 * Normalizes the passed url for consistent internal processing
 * @param u
 */
function normalizeUrl(u: Exclude<URI, RegExp>) {
  if (!(u instanceof URL)) {
    if (isLegacyUrl(u)) {
      return normalizeUrl(new URL(url.format(u)))
    }
    // If the url is invalid, let the URL library report it
    return normalizeUrl(new URL(u))
  }

  if (!/https?:/.test(u.protocol)) {
    throw new TypeError(
      `Protocol '${u.protocol}' not recognized. This commonly occurs when a hostname and port are included without a protocol, producing a URL that is valid but confusing, and probably not what you want.`,
    )
  }

  return {
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    username: u.username,
    password: u.password,
    host: u.host,
    hostname:
      // strip brackets from IPv6
      typeof u.hostname === 'string' && u.hostname.startsWith('[')
        ? u.hostname.slice(1, -1)
        : u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    pathname: u.pathname,
    search: u.search,
    searchParams: u.searchParams,
    hash: u.hash,
  }
}

/**
 * @param  {URI} basePath
 * @param  {Object}   options
 * @param  {boolean}  options.allowUnmocked
 * @param  {string[]} options.badheaders
 * @param  {function} options.conditionally
 * @param  {boolean}  options.encodedQueryParams
 * @param  {function} options.filteringScope
 * @param  {Object}   options.reqheaders
 * @constructor
 */
export class Scope extends EventEmitter {
  keyedInterceptors: Record<string, Interceptor[]> = {}
  interceptors: Interceptor[] = []
  transformPathFunction: ((path: string) => string) | null
  transformRequestBodyFunction: ((body: string) => string) | null
  matchHeaders: { name: string; value: string }[] = []
  scopeOptions: Options
  urlParts: any
  _persist: boolean
  contentLen: boolean
  date: Date | null
  basePath: URI
  basePathname: string
  port: string | number | null
  _defaultReplyHeaders: string[]
  logger: DebugLogger

  constructor(basePath: URI, options?: Options) {
    super()

    this.keyedInterceptors = {}
    this.interceptors = []
    this.transformPathFunction = null
    this.transformRequestBodyFunction = null
    this.matchHeaders = []
    this.scopeOptions = options || {}
    this.urlParts = {}
    this._persist = false
    this.contentLen = false
    this.date = null
    this.basePath = basePath
    this.basePathname = ''
    this.port = null
    this._defaultReplyHeaders = []

    let logNamespace = String(basePath)

    if (!((basePath as unknown) instanceof RegExp)) {
      this.urlParts = normalizeUrl(basePath)
      this.port = this.urlParts.port
      this.basePathname = this.urlParts.pathname.replace(/\/$/, '')
      this.basePath = `${this.urlParts.protocol}//${this.urlParts.hostname}:${this.port}`
      logNamespace = this.urlParts.host
    }

    this.logger = scopeDebuglog(logNamespace)
  }

  add(key: string, interceptor: Interceptor) {
    if (!(key in this.keyedInterceptors)) {
      this.keyedInterceptors[key] = []
    }
    this.keyedInterceptors[key].push(interceptor)
    addInterceptor(
      this.basePath,
      interceptor,
      this,
      this.scopeOptions,
      this.urlParts.hostname,
    )
  }

  remove(key: string, interceptor: Interceptor) {
    if (this._persist) {
      return
    }
    const arr = this.keyedInterceptors[key]
    if (arr) {
      arr.splice(arr.indexOf(interceptor), 1)
      if (arr.length === 0) {
        delete this.keyedInterceptors[key]
      }
    }
  }

  intercept(
    uri: URI,
    method: string,
    requestBody: RequestBodyMatcher,
    interceptorOptions: Options,
  ) {
    const ic = new Interceptor(
      this,
      uri,
      method,
      requestBody,
      interceptorOptions,
    )

    this.interceptors.push(ic)
    return ic
  }

  get(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'GET', requestBody, options)
  }

  post(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'POST', requestBody, options)
  }

  put(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'PUT', requestBody, options)
  }

  head(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'HEAD', requestBody, options)
  }

  patch(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'PATCH', requestBody, options)
  }

  merge(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'MERGE', requestBody, options)
  }

  delete(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'DELETE', requestBody, options)
  }

  options(uri: URI, requestBody: RequestBodyMatcher, options: Options) {
    return this.intercept(uri, 'OPTIONS', requestBody, options)
  }

  // Returns the list of keys for non-optional Interceptors that haven't been completed yet.
  // TODO: This assumes that completed mocks are removed from the keyedInterceptors list
  // (when persistence is off). We should change that (and this) in future.
  pendingMocks() {
    return this.activeMocks().filter(key =>
      this.keyedInterceptors[key].some(({ interceptionCounter, optional }) => {
        const persistedAndUsed = this._persist && interceptionCounter > 0
        return !persistedAndUsed && !optional
      }),
    )
  }

  // Returns all keyedInterceptors that are active.
  // This includes incomplete interceptors, persisted but complete interceptors, and
  // optional interceptors, but not non-persisted and completed interceptors.
  activeMocks() {
    return Object.keys(this.keyedInterceptors)
  }

  isDone() {
    if (!isOn()) {
      return true
    }

    return this.pendingMocks().length === 0
  }

  done() {
    assert.ok(
      this.isDone(),
      `Mocks not yet satisfied:\n${this.pendingMocks().join('\n')}`,
    )
  }

  buildFilter() {
    const filteringArguments = arguments

    if (arguments[0] instanceof RegExp) {
      return function (candidate) {
        /* istanbul ignore if */
        if (typeof candidate !== 'string') {
          // Given the way nock is written, it seems like `candidate` will always
          // be a string, regardless of what options might be passed to it.
          // However the code used to contain a truthiness test of `candidate`.
          // The check is being preserved for now.
          throw Error(
            `Nock internal assertion failed: typeof candidate is ${typeof candidate}. If you encounter this error, please report it as a bug.`,
          )
        }
        return candidate.replace(filteringArguments[0], filteringArguments[1])
      }
    } else if (typeof arguments[0] === 'function') {
      return arguments[0]
    }
  }

  filteringPath() {
    this.transformPathFunction = this.buildFilter.apply(this, arguments)
    if (!this.transformPathFunction) {
      throw new Error(
        'Invalid arguments: filtering path should be a function or a regular expression',
      )
    }
    return this
  }

  filteringRequestBody() {
    this.transformRequestBodyFunction = this.buildFilter.apply(this, arguments)
    if (!this.transformRequestBodyFunction) {
      throw new Error(
        'Invalid arguments: filtering request body should be a function or a regular expression',
      )
    }
    return this
  }

  matchHeader(name, value) {
    //  We use lower-case header field names throughout Nock.
    this.matchHeaders.push({ name: name.toLowerCase(), value })
    return this
  }

  defaultReplyHeaders(headers) {
    this._defaultReplyHeaders = common.headersInputToRawArray(headers)
    return this
  }

  persist(flag = true) {
    if (typeof flag !== 'boolean') {
      throw new Error('Invalid arguments: argument should be a boolean')
    }
    this._persist = flag
    return this
  }

  /**
   * @private
   * @returns {boolean}
   */
  shouldPersist() {
    return this._persist
  }

  replyContentLength() {
    this.contentLen = true
    return this
  }

  replyDate(d: Date) {
    this.date = d || new Date()
    return this
  }

  clone() {
    return new Scope(this.basePath, this.scopeOptions)
  }
}

export function loadDefs(path: fs.PathLike): Definition[] {
  if (!fs) {
    throw new Error('No fs')
  }

  const contents = fs.readFileSync(path)
  return JSON.parse(contents.toString())
}

export function load(path: fs.PathLike): Scope[] {
  return define(loadDefs(path))
}

function getStatusFromDefinition(nockDef: Definition): number {
  // Backward compatibility for when `status` was encoded as string in `reply`.
  if (nockDef.reply !== undefined) {
    const parsedReply = parseInt(nockDef.reply, 10)
    if (isNaN(parsedReply)) {
      throw Error('`reply`, when present, must be a numeric string')
    }

    return parsedReply
  }

  const DEFAULT_STATUS_OK = 200
  return nockDef.status || DEFAULT_STATUS_OK
}

function getScopeFromDefinition(nockDef) {
  //  Backward compatibility for when `port` was part of definition.
  if (nockDef.port !== undefined) {
    //  Include `port` into scope if it doesn't exist.
    const options = url.parse(nockDef.scope)
    if (options.port === null) {
      return `${nockDef.scope}:${nockDef.port}`
    } else {
      if (parseInt(options.port) !== parseInt(nockDef.port)) {
        throw new Error(
          'Mismatched port numbers in scope and port properties of nock definition.',
        )
      }
    }
  }

  return nockDef.scope
}

function tryJsonParse(string: string) {
  try {
    return JSON.parse(string)
  } catch (err) {
    return string
  }
}

export function define(nockDefs: Definition[]): Scope[] {
  const scopes: Scope[] = []

  nockDefs.forEach(function (nockDef) {
    const nscope = getScopeFromDefinition(nockDef)
    const npath = nockDef.path
    if (!nockDef.method) {
      throw Error('Method is required')
    }
    const method = nockDef.method.toLowerCase()
    const status = getStatusFromDefinition(nockDef)
    const rawHeaders = nockDef.rawHeaders || []
    const reqheaders = nockDef.reqheaders || {}
    const badheaders = nockDef.badheaders || []
    const options = { ...nockDef.options }

    //  We use request headers for both filtering (see below) and mocking.
    //  Here we are setting up mocked request headers but we don't want to
    //  be changing the user's options object so we clone it first.
    options.reqheaders = reqheaders
    options.badheaders = badheaders

    // Response is not always JSON as it could be a string or binary data or
    // even an array of binary buffers (e.g. when content is encoded).
    let response
    if (!nockDef.response) {
      response = ''
      // TODO: Rename `responseIsBinary` to `responseIsUtf8Representable`.
    } else if (nockDef.responseIsBinary) {
      response = Buffer.from(nockDef.response, 'hex')
    } else {
      response =
        typeof nockDef.response === 'string'
          ? tryJsonParse(nockDef.response)
          : nockDef.response
    }

    const scope = new Scope(nscope, options)

    // If request headers were specified filter by them.
    Object.entries(reqheaders).forEach(([fieldName, value]) => {
      scope.matchHeader(fieldName, value)
    })

    const acceptableFilters = ['filteringRequestBody', 'filteringPath']
    acceptableFilters.forEach(filter => {
      if (nockDef[filter]) {
        scope[filter](nockDef[filter])
      }
    })

    scope
      .intercept(npath, method, nockDef.body)
      .reply(status, response, rawHeaders)

    scopes.push(scope)
  })

  return scopes
}
