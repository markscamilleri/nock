import { common as debug } from './debug.js'
import timers from 'node:timers'
import url from 'node:url'
import util from 'node:util'
import http, { ClientRequest } from 'node:http'
import {
  ReplyHeaders,
  ReplyHeaderValue,
  ReqOptions,
  RequestHeaderMatcher,
  RequestHeaders,
} from './types/index.js'
import { Readable } from 'node:stream'

/**
 * Normalizes the request options so that it always has `host` property.
 *
 * @param  {ReqOptions} options - a parsed options object of the request
 */
export function normalizeRequestOptions(options: ReqOptions) {
  options.proto = options.proto || 'http'
  options.port = options.port || (options.proto === 'http' ? 80 : 443)
  if (options.host) {
    debug('options.host:', options.host)
    if (!options.hostname) {
      if (options.host.split(':').length === 2) {
        options.hostname = options.host.split(':')[0]
      } else {
        options.hostname = options.host
      }
    }
  }
  debug('options.hostname in the end: %j', options.hostname)
  options.host = `${options.hostname || 'localhost'}:${options.port}`
  debug('options.host in the end: %j', options.host)

  /// lowercase host names
  ;(['hostname', 'host'] as const).forEach(function (attr) {
    if (options[attr]) {
      options[attr] = options[attr].toLowerCase()
    }
  })

  return options
}

/**
 * Returns true if the data contained in buffer can be reconstructed
 * from its utf8 representation.
 *
 * @param  {Buffer} buffer - a Buffer object
 * @returns {boolean}
 */
export function isUtf8Representable(buffer: Buffer): boolean {
  const utfEncodedBuffer = buffer.toString('utf8')
  const reconstructedBuffer = Buffer.from(utfEncodedBuffer, 'utf8')
  return reconstructedBuffer.equals(buffer)
}

/**
 * In WHATWG URL vernacular, this returns the origin portion of a URL.
 * However, the port is not included if it's standard and not already present on the host.
 */
export function normalizeOrigin(
  proto?: string,
  host?: string | null,
  port?: number | string | null,
): string {
  const hostHasPort = host?.includes(':')
  const portIsStandard =
    (proto === 'http' && (port === 80 || port === '80')) ||
    (proto === 'https' && (port === 443 || port === '443'))
  const portStr = hostHasPort || portIsStandard ? '' : `:${port}`

  return `${proto}://${host}${portStr}`
}

/**
 * Get high level information about request as string
 * @param  {ReqOptions} options
 * @param  {string} options.method
 * @param  {number|string} options.port
 * @param  {string} options.proto Set internally. always http or https
 * @param  {string} options.hostname
 * @param  {string} options.path
 * @param  {Object} options.headers
 * @param  {string} body
 * @return {string}
 */
export function stringifyRequest(options: ReqOptions, body: string): string {
  const { method = 'GET', path = '', port } = options
  const origin = normalizeOrigin(options.proto, options.hostname, port)

  type Log = {
    method: string
    url: string
    headers: ReqOptions['headers']
    body?: string
  }

  const log: Log = {
    method,
    url: `${origin}${path}`,
    headers: options.headers,
  }

  if (body) {
    log.body = body
  }

  return JSON.stringify(log, null, 2)
}

export function isContentEncoded(headers: ReplyHeaders): boolean {
  const contentEncoding =
    'content-encoding' in headers ? headers['content-encoding'] : undefined
  return typeof contentEncoding === 'string' && contentEncoding !== ''
}

export function contentEncoding(
  headers: RequestHeaders,
  encoder: string,
): boolean {
  const contentEncoding =
    headers && 'content-encoding' in headers
      ? headers['content-encoding']
      : undefined
  return contentEncoding !== undefined && contentEncoding.toString() === encoder
}

export function isJSONContent(headers: RequestHeaders): boolean {
  // https://tools.ietf.org/html/rfc8259
  const contentType = (headers && headers['content-type']) ?? ''
  return contentType.toString().toLowerCase().startsWith('application/json')
}

/**
 * Return a new object with all field names of the headers lower-cased.
 *
 * Duplicates throw an error.
 */
export function headersFieldNamesToLowerCase(
  headers: Record<string, RequestHeaderMatcher>,
  throwOnDuplicate: boolean,
) {
  if (!isPlainObject(headers)) {
    throw Error('Headers must be provided as an object')
  }

  const lowerCaseHeaders: Record<string, RequestHeaderMatcher> = {}
  Object.entries(headers).forEach(([fieldName, fieldValue]) => {
    const key = fieldName.toLowerCase()
    if (lowerCaseHeaders[key] !== undefined) {
      if (throwOnDuplicate) {
        throw Error(
          `Failed to convert header keys to lower case due to field name conflict: ${key}`,
        )
      } else {
        debug(
          `Duplicate header provided in request: ${key}. Only the last value can be matched.`,
        )
      }
    }
    lowerCaseHeaders[key] = fieldValue
  })

  return lowerCaseHeaders
}

export const headersFieldsArrayToLowerCase = (headers: string[]): string[] => [
  ...new Set(headers.map(fieldName => fieldName.toLowerCase())),
]

/**
 * Converts the various accepted formats of headers into a flat array representing "raw headers".
 *
 * Nock allows headers to be provided as a raw array, a plain object, or a Map.
 *
 * While all the header names are expected to be strings, the values are left intact as they can
 * be functions, strings, or arrays of strings.
 *
 *  https://nodejs.org/api/http.html#http_message_rawheaders
 */
export function headersInputToRawArray(
  headers?: ReplyHeaders,
): ReplyHeaderValue[] {
  if (headers === undefined) {
    return []
  }

  if (Array.isArray(headers)) {
    // If the input is an array, assume it's already in the raw format and simply return a copy
    // but throw an error if there aren't an even number of items in the array
    if (headers.length % 2) {
      throw new Error(
        `Raw headers must be provided as an array with an even number of items. [fieldName, value, ...]`,
      )
    }
    return [...headers]
  }

  // [].concat(...) is used instead of Array.flat until v11 is the minimum Node version
  if (util.types.isMap(headers)) {
    return new Array<ReplyHeaderValue>().concat(
      ...Array.from(headers, ([k, v]) => [k.toString(), v]),
    )
  }

  if (isPlainObject(headers)) {
    return new Array<ReplyHeaderValue>().concat(...Object.entries(headers))
  }

  throw new Error(
    `Headers must be provided as an array of raw values, a Map, or a plain Object. ${headers}`,
  )
}

/**
 * Converts an array of raw headers to an object, using the same rules as Nodes `http.IncomingMessage.headers`.
 *
 * Header names/keys are lower-cased.
 */
export function headersArrayToObject(
  rawHeaders: string[],
): Record<string, ReplyHeaderValue> {
  if (!Array.isArray(rawHeaders)) {
    throw Error('Expected a header array')
  }

  const accumulator: Record<string, string | string[]> = {}

  forEachHeader(rawHeaders, (value: ReplyHeaderValue, fieldName: string) => {
    addHeaderLine(accumulator, fieldName, value)
  })

  return accumulator
}

const noDuplicatesHeaders = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'user-agent',
])

/**
 * Set key/value data in accordance with Node's logic for folding duplicate headers.
 *
 * The `value` param should be a function, string, or array of strings.
 *
 * Node's docs and source:
 * https://nodejs.org/api/http.html#http_message_headers
 * https://github.com/nodejs/node/blob/908292cf1f551c614a733d858528ffb13fb3a524/lib/_http_incoming.js#L245
 *
 * Header names are lower-cased.
 * Duplicates in raw headers are handled in the following ways, depending on the header name:
 * - Duplicates of field names listed in `noDuplicatesHeaders` (above) are discarded.
 * - `set-cookie` is always an array. Duplicates are added to the array.
 * - For duplicate `cookie` headers, the values are joined together with '; '.
 * - For all other headers, the values are joined together with ', '.
 *
 * Node's implementation is larger because it highly optimizes for not having to call `toLowerCase()`.
 * We've opted to always call `toLowerCase` in exchange for a more concise function.
 *
 * While Node has the luxury of knowing `value` is always a string, we do an extra step of coercion at the top.
 */
const addHeaderLine = (
  headers: Record<string, string[] | string>,
  name: string,
  value: ReplyHeaderValue,
) => {
  let values: string[] // code below expects `values` to be an array of strings
  if (typeof value === 'function') {
    // Function values are evaluated towards the end of the response, before that we use a placeholder
    // string just to designate that the header exists. Useful when `Content-Type` is set with a function.
    values = [value.name]
  } else if (Array.isArray(value)) {
    values = value.map(String)
  } else {
    values = [String(value)]
  }

  const key = name.toLowerCase()
  if (key === 'set-cookie') {
    // Array header -- only Set-Cookie at the moment
    if (headers['set-cookie'] === undefined) {
      headers['set-cookie'] = values
    } else {
      Array.isArray(headers['set-cookie'])
        ? headers['set-cookie'].push(...values)
        : (headers['set-cookie'] = [...values])
    }
  } else if (noDuplicatesHeaders.has(key)) {
    if (headers[key] === undefined) {
      // Drop duplicates
      headers[key] = values[0]
    }
  } else {
    if (headers[key] !== undefined) {
      values = Array.isArray(headers[key])
        ? [...headers[key], ...values]
        : [headers[key], ...values]
    }

    const separator = key === 'cookie' ? '; ' : ', '
    headers[key] = values.join(separator)
  }
}

/**
 * Deletes the given `fieldName` property from `headers` object by performing
 * case-insensitive search through keys.
 *
 * @headers   {Object} headers - object of header field names and values
 * @fieldName {String} field name - string with the case-insensitive field name
 */
export function deleteHeadersField(
  headers: RequestHeaders,
  fieldNameToDelete: string,
): void {
  if (!isPlainObject(headers)) {
    throw Error('headers must be an object')
  }

  if (typeof fieldNameToDelete !== 'string') {
    throw Error('field name must be a string')
  }

  const lowerCaseFieldNameToDelete = fieldNameToDelete.toLowerCase()

  // Search through the headers and delete all values whose field name matches the given field name.
  Object.keys(headers ?? {})
    .filter(fieldName => fieldName.toLowerCase() === lowerCaseFieldNameToDelete)
    .forEach(fieldName => delete headers?.[fieldName])
}

/**
 * Utility for iterating over a raw headers array.
 *
 * The callback is called with:
 *  - The header value. string, array of strings, or a function
 *  - The header field name. string
 *  - Index of the header field in the raw header array.
 */
export function forEachHeader(
  rawHeaders: string[],
  callback: (value: ReplyHeaderValue, name: string, index: number) => void,
): void {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    callback(rawHeaders[i + 1], rawHeaders[i], i)
  }
}

export function percentDecode(str: string): string {
  try {
    return decodeURIComponent(str.replace(/\+/g, ' '))
  } catch (e) {
    return str
  }
}

/**
 * URI encode the provided string, stringently adhering to RFC 3986.
 *
 * RFC 3986 reserves !, ', (, ), and * but encodeURIComponent does not encode them so we do it manually.
 *
 * https://tools.ietf.org/html/rfc3986
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
 */
export function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

export function matchStringOrRegexp(
  target: string | undefined | null,
  pattern: RegExp | string,
): boolean {
  const targetStr =
    target === undefined || target === null ? '' : String(target)

  if (pattern instanceof RegExp) {
    // if the regexp happens to have a global flag, we want to ensure we test the entire target
    pattern.lastIndex = 0
    return pattern.test(targetStr)
  }
  return targetStr === String(pattern)
}

type Keys = string | number
type stringOrRegex = string | RegExp
type OutputTypes =
  | stringOrRegex
  | OutputTypes[]
  | { [key: string]: OutputTypes }

type InputValue = stringOrRegex | number | boolean | null | undefined
type InputValues = InputValue | InputValue[] | Record<string, InputValue>

type FormatFunction = <FormatType extends Keys>(str: FormatType) => FormatType

/**
 * Formats a query parameter.
 *
 * @param key                The key of the query parameter to format.
 * @param value              The value of the query parameter to format.
 * @param stringFormattingFn The function used to format string values. Can
 *                           be used to encode or decode the query value.
 *
 * @returns *[] the formatted [key, value] pair.
 */
export function formatQueryValue<
  KeyType extends Keys,
  ValueType extends InputValues,
>(
  key: KeyType,
  value: ValueType,
  stringFormattingFn?: FormatFunction,
): [KeyType, OutputTypes] {
  // TODO: Probably refactor code to replace `switch(true)` with `if`/`else`.
  let strValue: stringOrRegex | undefined = undefined
  let arrValue: OutputTypes[] | undefined = undefined
  let objValue: Record<string, OutputTypes> | undefined = undefined
  switch (true) {
    case typeof value === 'number': // fall-through
    case typeof value === 'boolean':
      strValue = value.toString()
      break
    case value === null:
    case value === undefined:
      strValue = ''
      break
    case typeof value === 'string':
      if (stringFormattingFn) {
        strValue = stringFormattingFn(value)
      }
      break
    case value instanceof RegExp:
      strValue = value
      break
    case Array.isArray(value): {
      arrValue = value.map(function (val, idx) {
        return formatQueryValue(idx, val, stringFormattingFn)[1]
      })
      break
    }
    case typeof value === 'object': {
      objValue = Object.entries(value).reduce(function (
        acc: Record<string, OutputTypes>,
        [subKey, subVal],
      ) {
        const subPair = formatQueryValue(subKey, subVal, stringFormattingFn)
        acc[subPair[0]] = subPair[1]

        return acc
      }, {})
      break
    }
  }

  if (stringFormattingFn) key = stringFormattingFn(key)
  return [key, strValue ?? arrValue ?? objValue ?? '']
}

export function isStream(obj: unknown): obj is Readable {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === 'object' &&
    typeof obj !== 'string' &&
    !Buffer.isBuffer(obj) &&
    'setEncoding' in obj &&
    typeof obj.setEncoding === 'function'
  )
}

type NormalizedArgs = {
  options: ReqOptions
  callback: Function | undefined
}

/**
 * Converts the arguments from the various signatures of http[s].request into a standard
 * options object and an optional callback function.
 *
 * https://nodejs.org/api/http.html#http_http_request_url_options_callback
 *
 * Taken from the beginning of the native `ClientRequest`.
 * https://github.com/nodejs/node/blob/908292cf1f551c614a733d858528ffb13fb3a524/lib/_http_client.js#L68
 */
export function normalizeClientRequestArgs(
  input: string | url.URL,
  options: ReqOptions,
  callback?: Function,
): NormalizedArgs
export function normalizeClientRequestArgs(
  options: ReqOptions,
  callback: Function,
): NormalizedArgs
export function normalizeClientRequestArgs(
  inputOrOptions: string | url.URL | ReqOptions,
  optionsOrCallback: ReqOptions | Function,
  cb?: Function,
): NormalizedArgs {
  let input: ReqOptions | null = null
  let options: ReqOptions
  let callback: Function | undefined = undefined

  if (typeof inputOrOptions === 'string') {
    input = urlToOptions(new url.URL(inputOrOptions))
  } else if (inputOrOptions instanceof url.URL) {
    input = urlToOptions(inputOrOptions)
  } else {
    options = inputOrOptions
    input = null
  }

  if (typeof optionsOrCallback === 'function') {
    callback = optionsOrCallback
    options = input || {}
  } else {
    options = Object.assign(input || {}, optionsOrCallback)
  }

  return { options, callback }
}

/**
 * Utility function that converts a URL object into an ordinary
 * options object as expected by the http.request and https.request APIs.
 *
 * This was copied from Node's source
 * https://github.com/nodejs/node/blob/908292cf1f551c614a733d858528ffb13fb3a524/lib/internal/url.js#L1257
 */
function urlToOptions(url: url.URL): ReqOptions {
  const options: ReqOptions = {
    protocol: url.protocol,
    hostname:
      typeof url.hostname === 'string' && url.hostname.startsWith('[')
        ? url.hostname.slice(1, -1)
        : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname}${url.search || ''}`,
    href: url.href,
  }
  if (url.port !== '') {
    options.port = Number(url.port)
  }
  if (url.username || url.password) {
    options.auth = `${url.username}:${url.password}`
  }
  return options
}

/**
 * Determines if request data matches the expected schema.
 *
 * Used for comparing decoded search parameters, request body JSON objects,
 * and URL decoded request form bodies.
 *
 * Performs a general recursive strict comparison with two caveats:
 *  - The expected data can use regexp to compare values
 *  - JSON path notation and nested objects are considered equal
 */
export const dataEqual = (expected: unknown, actual: unknown): boolean => {
  if (isPlainObject(expected)) {
    expected = expand(expected)
  }
  if (isPlainObject(actual)) {
    actual = expand(actual)
  }
  return deepEqual(expected, actual)
}

type DeepEqualFunction =
  | (<ExpectedType extends RegExp>(
      expected: ExpectedType,
      actual: string,
    ) => boolean)
  | (<ExpectedType>(expected: ExpectedType, actual: ExpectedType) => boolean)

/**
 * Performs a recursive strict comparison between two values.
 *
 * Expected values or leaf nodes of expected object values that are RegExp use test() for comparison.
 */
function deepEqual<ExpectedType>(
  expected: ExpectedType,
  actual: ExpectedType,
): boolean
function deepEqual(expected: RegExp, actual: string): boolean
function deepEqual<ExpectedType>(
  expected: ExpectedType | RegExp,
  actual: ExpectedType | string,
): boolean {
  debug('deepEqual comparing', typeof expected, expected, typeof actual, actual)
  if (expected instanceof RegExp) {
    // If the expected value is a RegExp, we expect the actual value to be a string
    if (typeof actual !== 'string') {
      return false
    }
    return expected.test(actual)
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return false
    }

    return expected.every((expVal, idx) => deepEqual(expVal, actual[idx]))
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const allKeys = Array.from(
      new Set(Object.keys(expected).concat(Object.keys(actual))),
    )

    return allKeys.every(key => deepEqual(expected[key], actual[key]))
  }

  return expected === actual
}

const timeouts = new Set<NodeJS.Timeout>()
const immediates = new Set<NodeJS.Immediate>()

type Timers = NodeJS.Timeout | NodeJS.Immediate

type TimerCallback<TimerType extends Timers> = <
  CallbackFunctionType extends (...args: any) => any,
>(
  callback: CallbackFunctionType,
  ...timerArgs: Parameters<CallbackFunctionType>
) => TimerType

type TimerWrapper = <TimerType extends Timers>(
  timer: (...args: any[]) => TimerType,
  ids: Set<TimerType>,
) => TimerCallback<TimerType>

const wrapTimer: TimerWrapper =
  (timer, ids) =>
  <CallbackFunctionType extends (...args: any) => any>(
    callback: CallbackFunctionType,
    ...timerArgs: Parameters<CallbackFunctionType>
  ) => {
    const cb = (...callbackArgs: Parameters<CallbackFunctionType>) => {
      try {
        callback(...callbackArgs)
      } finally {
        ids.delete(id)
      }
    }
    const id = timer(cb, ...timerArgs)
    ids.add(id)
    return id
  }

export const setTimeout = wrapTimer(timers.setTimeout, timeouts)
export const setImmediate = wrapTimer(timers.setImmediate, immediates)

function clearTimer<TimerType>(
  clear: (id: TimerType) => void,
  ids: Set<TimerType>,
) {
  ids.forEach(clear)
  ids.clear()
}

export function removeAllTimers() {
  debug('remove all timers')
  clearTimer(clearTimeout, timeouts)
  clearTimer(clearImmediate, immediates)
}

/**
 * Check if the Client Request has been cancelled.
 *
 * Until Node 14 is the minimum, we need to look at both flags to see if the request has been cancelled.
 * The two flags have the same purpose, but the Node maintainers are migrating from `abort(ed)` to
 * `destroy(ed)` terminology, to be more consistent with `stream.Writable`.
 * In Node 14.x+, Calling `abort()` will set both `aborted` and `destroyed` to true, however,
 * calling `destroy()` will only set `destroyed` to true.
 * Falling back on checking if the socket is destroyed to cover the case of Node <14.x where
 * `destroy()` is called, but `destroyed` is undefined.
 *
 * Node Client Request history:
 * - `request.abort()`: Added in: v0.3.8, Deprecated since: v14.1.0, v13.14.0
 * - `request.aborted`: Added in: v0.11.14, Became a boolean instead of a timestamp: v11.0.0, Not deprecated (yet)
 * - `request.destroy()`: Added in: v0.3.0
 * - `request.destroyed`: Added in: v14.1.0, v13.14.0
 *
 * @param {ClientRequest} req
 * @returns {boolean}
 */
export function isRequestDestroyed(req: ClientRequest) {
  return !!(
    req.destroyed === true ||
    req.aborted ||
    (req.socket && req.socket.destroyed)
  )
}

/**
 * @param {Request} request
 */
export function convertFetchRequestToClientRequest(request: Request) {
  const url = new URL(request.url)
  const options = {
    ...urlToOptions(url),
    method: request.method,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    proto: url.protocol.slice(0, -1),
    headers: Object.fromEntries(request.headers.entries()),
  }

  // By default, Node adds a host header, but for maximum backward compatibility, we are now removing it.
  // However, we need to consider leaving the header and fixing the tests.
  if (options.headers.host === options.host) {
    const { host, ...restHeaders } = options.headers
    options.headers = restHeaders
  }

  return new http.ClientRequest(options)
}

/**
 * Returns true if the given value is a plain object and not an Array.
 * @param {*} value
 * @returns {boolean}
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false

  if (Object.prototype.toString.call(value) !== '[object Object]') return false

  const proto = Object.getPrototypeOf(value)
  if (proto === null) return true

  const Ctor =
    Object.prototype.hasOwnProperty.call(proto, 'constructor') &&
    proto.constructor
  return (
    typeof Ctor === 'function' &&
    Ctor instanceof Ctor &&
    Function.prototype.call(Ctor) === Function.prototype.call(value)
  )
}

const prototypePollutionBlockList = ['__proto__', 'prototype', 'constructor']
const blocklistFilter = function (part: string) {
  return prototypePollutionBlockList.indexOf(part) === -1
}

/**
 * Converts flat objects whose keys use JSON path notation to nested objects.
 *
 * The input object is not mutated.
 *
 * @example
 * { 'foo[bar][0]': 'baz' } -> { foo: { bar: [ 'baz' ] } }
 */
export const expand = (
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (input === undefined || input === null) {
    return input
  }

  const keys = Object.keys(input)

  const result: Record<string, unknown> = {}
  // TypeScript: resultPtr is used as both object and array depending on the path.
  // Using 'any' here is intentional to avoid complex type gymnastics and runtime changes.
  let resultPtr: any = result
  for (let path of keys) {
    const originalPath = path
    if (path.indexOf('[') >= 0) {
      path = path.replace(/\[/g, '.').replace(/]/g, '')
    }

    const parts = path.split('.')

    const check = parts.filter(blocklistFilter)

    if (check.length !== parts.length) {
      return undefined
    }
    resultPtr = result
    const lastIndex = parts.length - 1

    for (let i = 0; i < parts.length; ++i) {
      const part = parts[i]
      if (i === lastIndex) {
        if (Array.isArray(resultPtr)) {
          resultPtr[+part] = input[originalPath]
        } else {
          resultPtr[part] = input[originalPath]
        }
      } else {
        if (resultPtr[part] === undefined || resultPtr[part] === null) {
          const nextPart = parts[i + 1]
          if (/^\d+$/.test(nextPart)) {
            resultPtr[part] = []
          } else {
            resultPtr[part] = {}
          }
        }
        resultPtr = resultPtr[part]
      }
    }
  }
  return result
}

export default {
  contentEncoding,
  dataEqual,
  deleteHeadersField,
  expand,
  forEachHeader,
  formatQueryValue,
  headersArrayToObject,
  headersFieldNamesToLowerCase,
  headersFieldsArrayToLowerCase,
  headersInputToRawArray,
  isContentEncoded,
  isJSONContent,
  isPlainObject,
  isRequestDestroyed,
  isStream,
  isUtf8Representable,
  matchStringOrRegexp,
  normalizeClientRequestArgs,
  normalizeOrigin,
  normalizeRequestOptions,
  percentDecode,
  percentEncode,
  removeAllTimers,
  setImmediate,
  setTimeout,
  stringifyRequest,
  convertFetchRequestToClientRequest,
}
