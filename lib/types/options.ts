import type { RequestHeaderMatcher } from './request'

export type Options = {
  allowUnmocked?: boolean
  reqheaders?: Record<string, RequestHeaderMatcher>
  badheaders?: string[]
  filteringScope?: { (scope: string): boolean }
  encodedQueryParams?: boolean
}
