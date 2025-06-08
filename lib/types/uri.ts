import { URL, Url as LegacyUrl } from 'node:url'

export type URI = string | RegExp | URL | LegacyUrl

export function isLegacyUrl(u: URI): u is LegacyUrl {
  return (
    !(u instanceof URL) &&
    typeof u === 'object' &&
    'auth' in u &&
    'hash' in u &&
    'host' in u &&
    'hostname' in u &&
    'href' in u &&
    'path' in u &&
    'pathname' in u &&
    'protocol' in u &&
    'search' in u &&
    'slashes' in u &&
    'port' in u &&
    'query' in u
  )
}
