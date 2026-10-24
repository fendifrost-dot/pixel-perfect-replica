import Foundation

/// AVAudioEngine pad player. Compiled only where AVFoundation exists (iOS and macOS).
/// Session category `.playback` ignores the hardware silent switch. A phone-call interruption
/// stops the engine until the next explicit `resume()` from a tap — it does not resume by itself.
/// Live triggers are monophonic per pad (a new hit replaces the one still sounding). Pattern
/// playback renders the mix with `renderProject` and plays that buffer, so tempo matches export.

#if canImport(AVFoundation)
import AVFoundation

public final class AVAudioPadEngine: PadPlaying {
    public var library = AudioLibrary()
    private let engine = AVAudioEngine()
    private var players: [String: AVAudioPlayerNode] = [:]
    private let mixPlayer = AVAudioPlayerNode()
    private var started = false
    private let format: AVAudioFormat

    public init(sampleRate: Double = 48000) {
        format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        engine.attach(mixPlayer)
        engine.connect(mixPlayer, to: engine.mainMixerNode, format: format)
        // Fixed graph before the first tap. Editing the graph on a hit would add latency.
        for bank in banks {
            for index in 0..<16 {
                let id = "\(bank.rawValue)\(index + 1)"
                let player = AVAudioPlayerNode()
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: format)
                players[id] = player
            }
        }
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began { self.stopAll() }
        }
        #endif
    }

    public func resume() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)
        #endif
        if !engine.isRunning {
            try engine.start()
        }
        started = true
    }

    public func triggerPad(_ pad: Pad, slice: Slice?, velocity: Int, bpm: Double, when: Double? = nil) -> Bool {
        guard let slice, let source = library.buffers[slice.sourceId],
              let hit = renderPadHit(pad: pad, slice: slice, source: source, velocity: velocity, bpm: bpm),
              let buffer = Self.pcmBuffer(hit, format: format) else { return false }
        if !started { try? resume() }
        let player = player(for: pad.id)
        player.stop()
        if let when {
            let sampleTime = AVAudioFramePosition((when * format.sampleRate).rounded())
            let time = AVAudioTime(sampleTime: sampleTime, atRate: format.sampleRate)
            player.scheduleBuffer(buffer, at: time, options: [], completionHandler: nil)
        } else {
            player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        }
        if !player.isPlaying { player.play() }
        return true
    }

    public func releasePad(_ padId: String) {
        players[padId]?.stop()
    }

    public func stopAll() {
        mixPlayer.stop()
        for player in players.values { player.stop() }
        engine.pause()
        started = false
    }

    public func playBuffer(_ buffer: PCMBuffer) throws {
        guard let pcm = Self.pcmBuffer(buffer, format: format) else { return }
        try resume()
        mixPlayer.stop()
        mixPlayer.scheduleBuffer(pcm, at: nil, options: [], completionHandler: nil)
        mixPlayer.play()
    }

    private func player(for padId: String) -> AVAudioPlayerNode {
        if let existing = players[padId] { return existing }
        // A pad id outside A1–D16 still gets a node, but the stock grid is connected in init.
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        players[padId] = player
        return player
    }

    private static func pcmBuffer(_ source: PCMBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(source.frameCount)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let data = buffer.floatChannelData else { return nil }
        buffer.frameLength = frames
        let rate = source.sampleRate > 0 ? Double(source.sampleRate) : format.sampleRate
        let outRate = format.sampleRate
        for i in 0..<Int(frames) {
            let pos = Double(i) * rate / outRate
            data[0][i] = Float(sampleAt(source, channel: 0, pos))
            let right = source.channels.count > 1 ? sampleAt(source, channel: 1, pos) : sampleAt(source, channel: 0, pos)
            data[1][i] = Float(right)
        }
        return buffer
    }
}
#endif
