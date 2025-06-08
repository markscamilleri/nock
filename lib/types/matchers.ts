// Essentially valid, decoded JSON with the addition of possible RegExp. TS doesn't currently have
// a great way to represent JSON type data, this data matcher design is based off this comment.
// https://github.com/microsoft/TypeScript/issues/1897#issuecomment-338650717
export type DataMatcher =
  | boolean
  | number
  | string
  | null
  | undefined
  | RegExp
  | DataMatcherArray
  | DataMatcherMap
export interface DataMatcherArray extends ReadonlyArray<DataMatcher> {}
export interface DataMatcherMap {
  [key: string]: DataMatcher
}
