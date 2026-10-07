// A note and the rule that merges two statements of it: the later compose time wins.
// In the app: the far side (a server, a store) applies every incoming write through `acceptWrite`.
// Used by: UseCases (the type), the tests (the model server merges with it).
// Uses: Config (the skew tolerance).
//
// Why compose time and not arrival time: a write queued offline arrives late, and must not
// overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
// so a device an hour fast would otherwise win every comparison for the next hour. Time is whole
// milliseconds since 1970, so this layer needs no Foundation.

import Config

/// One note as a device stated it.
public struct Note: Equatable, Sendable {
    public let id: String
    public let text: String
    public let composedAtMs: Int

    public init(id: String, text: String, composedAtMs: Int) {
        self.id = id
        self.text = text
        self.composedAtMs = composedAtMs
    }
}

/// The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming one.
public func merge(stored: Note?, incoming: Note) -> Note {
    guard let stored, stored.composedAtMs > incoming.composedAtMs else { return incoming }
    return stored
}

/// A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
public func clampComposedAt(_ composedAtMs: Int, serverNowMs: Int, maxAheadMs: Int) -> Int {
    composedAtMs > serverNowMs + maxAheadMs ? serverNowMs : composedAtMs
}

/// One incoming write on the far side: clamp its stamp, then merge.
public func acceptWrite(stored: Note?, incoming: Note, serverNowMs: Int) -> Note {
    let clamped = clampComposedAt(incoming.composedAtMs, serverNowMs: serverNowMs, maxAheadMs: maxComposeSkewAhead.wholeMilliseconds)
    return merge(stored: stored, incoming: Note(id: incoming.id, text: incoming.text, composedAtMs: clamped))
}
