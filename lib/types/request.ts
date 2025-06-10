import { DataMatcherArray, DataMatcherMap } from './matchers'
import { RequestOptions } from 'node:http'

export type RequestBodyMatcher =
  | string
  | Buffer
  | RegExp
  | DataMatcherArray
  | DataMatcherMap
  | { (body: any): boolean }

export type RequestHeaderMatcher =
  | string
  | RegExp
  | { (fieldValue: string): boolean }

export type ReqOptions = RequestOptions & {
  proto?: string
  hash?: string
  search?: string
  pathname?: string
  href?: string
}

export type RequestHeaders = RequestOptions['headers']
