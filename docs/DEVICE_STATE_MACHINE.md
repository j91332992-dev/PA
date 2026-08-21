# Device state machine

`EMPTY -> PRESENT` only after configured UID confirmations. `PRESENT -> EMPTY` after the configured no-tag timeout. Unknown UID is `UNKNOWN_TAG`; alternating reads are `UNSTABLE`; a UID simultaneously PRESENT on multiple hangers is `CONFLICT`. Gateway changes stale hangers to `OFFLINE`. Event transitions and heartbeats are separate from NFC polling.
