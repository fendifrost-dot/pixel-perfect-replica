import Foundation

/// Offline 24-bit WAV export. Mix and per-pad stems share one frame count and start at 00:00:00.
/// Port of `src/lib/frost/render.ts` using the sample mixer in `Voice.swift` instead of OfflineAudioContext.

public struct RenderedFile: Equatable {
    public var name: String
    public var bytes: Data
    public var frames: Int
    public var peak: Double
    public var clipped: Int
    public var kind: Kind

    public enum Kind: String, Equatable { case mix, stem }
}

public struct RenderResult {
    public var files: [RenderedFile]
    public var mix: PCMBuffer
    public var frames: Int
    public var sampleRate: Int
}

public struct RenderError: Error, Equatable, CustomStringConvertible, LocalizedError {
    public let message: String
    public var description: String { message }
    public var errorDescription: String? { message }
}

private func safeName(_ s: String) -> String {
    let filtered = s.unicodeScalars.map { scalar -> Character in
        let v = scalar.value
        let ok = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95 || v == 45 || v == 32
        return ok ? Character(scalar) : " "
    }
    let trimmed = String(filtered).trimmingCharacters(in: .whitespacesAndNewlines)
    let collapsed = trimmed.split(whereSeparator: \.isWhitespace).joined(separator: "_")
    return collapsed.isEmpty ? "untitled" : collapsed
}

public func renderProject(
    _ p: Project, library: AudioLibrary, onProgress: ((String) -> Void)? = nil
) throws -> RenderResult {
    let sampleRate = p.export.sampleRate
    if sampleRate != 44100 && sampleRate != 48000 {
        throw RenderError(message: "sampleRate is 44100 or 48000.")
    }
    let sections = exportSections(p)
    let planned = planHits(p, sections: sections)
    if planned.hits.isEmpty {
        throw RenderError(message: "Nothing to export — the pattern/song has no hits on assigned pads.")
    }
    let tail = p.export.includeTails ? max(0, p.export.tailSec) : 0
    let frames = max(1, jsRound((planned.musicSec + tail) * Double(sampleRate)))
    let base = "\(safeName(p.name))_\(jsNumber(p.bpm))bpm"
    var files: [RenderedFile] = []
    func add(name: String, channels: [[Float]], kind: RenderedFile.Kind) {
        let enc = encodeWav24(channels: channels, sampleRate: sampleRate)
        files.append(RenderedFile(
            name: name, bytes: enc.bytes, frames: frames, peak: enc.peak, clipped: enc.clipped, kind: kind
        ))
    }
    onProgress?("Rendering stereo mix…")
    let mix = renderHits(p, hits: planned.hits, frames: frames, sampleRate: sampleRate, library: library)
    add(name: "\(base)_Mix.wav", channels: mix, kind: .mix)
    if p.export.mode == .stems {
        let padIds = Array(Set(planned.hits.map(\.padId))).sorted()
        for (i, id) in padIds.enumerated() {
            let pad = p.pads.first { $0.id == id }
            let slice = p.slices.first { $0.id == pad?.sliceId }
            onProgress?("Rendering track \(i + 1)/\(padIds.count) (\(id))…")
            let stem = renderHits(
                p, hits: planned.hits.filter { $0.padId == id }, frames: frames, sampleRate: sampleRate, library: library
            )
            let index = String(format: "%02d", i + 1)
            add(
                name: "\(base)_\(index)_\(id)_\(safeName(slice?.name ?? "pad")).wav",
                channels: stem,
                kind: .stem
            )
        }
    }
    return RenderResult(files: files, mix: PCMBuffer(sampleRate: sampleRate, channels: mix), frames: frames, sampleRate: sampleRate)
}

/// Short buffer for one live pad tap. Retrigger is monophonic; the export mixer is polyphonic.
public func renderPadHit(pad: Pad, slice: Slice, source: PCMBuffer, velocity: Int, bpm: Double) -> PCMBuffer? {
    var cache: [String: PCMBuffer] = [:]
    guard let voice = resolveVoice(pad: pad, slice: slice, source: source, bpm: bpm, cache: &cache) else { return nil }
    let seconds = (voice.playDuration.isFinite ? voice.playDuration : 1) + max(minRelease, pad.release) + 0.01
    let frames = max(1, jsRound(seconds * Double(source.sampleRate)))
    var channels = [
        [Float](repeating: 0, count: frames),
        [Float](repeating: 0, count: frames),
    ]
    mixVoice(
        into: &channels, sampleRate: source.sampleRate, voice: voice, pad: pad, velocity: velocity,
        startTime: 0, stopAt: nil, stopFade: nil
    )
    return PCMBuffer(sampleRate: source.sampleRate, channels: channels)
}
