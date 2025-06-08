import type Interceptor from '../interceptor.js'
import type { ReadStream } from 'node:fs'
import { ClientRequest, IncomingMessage } from 'node:http'

export type Body = string | Record<string, any> // a string or decoded JSON
export type ReplyBody = Body | Buffer | ReadStream

export type ReplyHeaderFunction = (
  req: ClientRequest,
  res: IncomingMessage,
  body: string | Buffer,
) => string | string[]
export type ReplyHeaderValue = string | string[] | ReplyHeaderFunction
export type ReplyHeaders =
  | Record<string, ReplyHeaderValue>
  | Map<string, ReplyHeaderValue>
  | ReplyHeaderValue[]

export type StatusCode = number
export type ReplyFnResult =
  | readonly [StatusCode]
  | readonly [StatusCode, ReplyBody]
  | readonly [StatusCode, ReplyBody, ReplyHeaders]

export interface ReplyFnContext extends Interceptor {
  req: ClientRequest & {
    headers: Record<string, string>
  }
}
