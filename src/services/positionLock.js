/**
 * Shared lock: one position at a time.
 * Buy only when no open position; must sell before next buy.
 * @module services/positionLock
 */

let hasOpenPosition = false;

export function hasPosition() {
  return hasOpenPosition;
}

export function setPositionOpen() {
  hasOpenPosition = true;
}

export function setPositionClosed() {
  hasOpenPosition = false;
}
