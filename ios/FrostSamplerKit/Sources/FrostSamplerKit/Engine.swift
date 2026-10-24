import Foundation

/// Pad playback contract. The SwiftUI shell talks to audio only through this protocol,
/// the same rule as `src/lib/frost/services.ts` on the web.
/// `SoftwarePadEngine` records triggers and is what unit tests run. `AVAudioPadEngine`
/// (Apple platforms) schedules the same rendered hit on `AVAudioEngine`.

public struct TriggerLog: Equatable {
    public var padId: String
    public var velocity: Int
    public var bpm: Double
    public var when: Double?
}

public protocol PadPlaying: AnyObject {
    func resume() throws
    func triggerPad(_ pad: Pad, slice: Slice?, velocity: Int, bpm: Double, when: Double?) -> Bool
    func releasePad(_ padId: String)
    func stopAll()
    func playBuffer(_ buffer: PCMBuffer) throws
}

public final class SoftwarePadEngine: PadPlaying {
    public var library = AudioLibrary()
    public private(set) var triggers: [TriggerLog] = []
    public private(set) var released: [String] = []
    public private(set) var stopped = 0
    public private(set) var playedFrames = 0
    public private(set) var ready = false

    public init() {}

    public func resume() throws { ready = true }

    public func triggerPad(_ pad: Pad, slice: Slice?, velocity: Int, bpm: Double, when: Double? = nil) -> Bool {
        guard let slice, library.buffers[slice.sourceId] != nil else { return false }
        triggers.append(TriggerLog(padId: pad.id, velocity: velocity, bpm: bpm, when: when))
        return true
    }

    public func releasePad(_ padId: String) { released.append(padId) }

    public func stopAll() { stopped += 1 }

    public func playBuffer(_ buffer: PCMBuffer) throws {
        ready = true
        playedFrames = buffer.frameCount
    }
}
