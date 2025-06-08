import { Options } from './options'
import { ReplyBody, ReplyHeaders } from './reply'
import { RequestBodyMatcher, RequestHeaderMatcher } from './request'

export interface Definition {
  scope: string | RegExp
  path: string | RegExp
  port?: number | string
  method?: string
  status?: number
  body?: RequestBodyMatcher
  reqheaders?: Record<string, RequestHeaderMatcher>
  response?: ReplyBody
  headers?: ReplyHeaders
  options?: Options
}
