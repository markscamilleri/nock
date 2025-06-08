import { DataMatcherArray, DataMatcherMap } from './matchers'

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
