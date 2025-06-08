import { EventEmitter } from 'node:events'

type PropagatedEventsResult = {
  end: () => void
}

export function propagate(
  source: EventEmitter,
  dest: EventEmitter,
): PropagatedEventsResult

export function propagate(
  events: string[],
  source: EventEmitter,
  dest: EventEmitter,
): PropagatedEventsResult
