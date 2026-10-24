import Foundation

/// One pad hit mixed into a float buffer. Export and the on-device player share this path
/// so a stem and the mix place the same samples. Port of the schedule in `voice.ts` / `render.ts`.
/// The live Web Audio graph stays in the web app.

public let minAttack = 0.002
public let minRelease = 0.004
public let chokeFade = 0.008

public struct PCMBuffer: Equatable {
    public var sampleRate: Int
    public var channels: [[Float]]

    public init(sampleRate: Int, channels: [[Float]]) {
        self.sampleRate = sampleRate
        let n = channels.map(\.count).min() ?? 0
        self.channels = channels.map { Array($0.prefix(n)) }
    }

    public var frameCount: Int { channels.first?.count ?? 0 }
    public var duration: Double {
        sampleRate > 0 ? Double(frameCount) / Double(sampleRate) : 0
    }

    public func mono() -> [Float] {
        guard let first = channels.first else { return [] }
        if channels.count == 1 { return first }
        var out = [Float](repeating: 0, count: first.count)
        let scale = 1 / Float(channels.count)
        for ch in channels {
            for i in 0..<out.count { out[i] += ch[i] * scale }
        }
        return out
    }
}

public struct AudioLibrary: Equatable {
    public var buffers: [String: PCMBuffer]
    public var fileBytes: [String: Data]
    public var mime: [String: String]

    public init(buffers: [String: PCMBuffer] = [:], fileBytes: [String: Data] = [:], mime: [String: String] = [:]) {
        self.buffers = buffers
        self.fileBytes = fileBytes
        self.mime = mime
    }
}

struct ResolvedVoice {
    var buffer: PCMBuffer
    var offset: Double
    var duration: Double
    var rate: Double
    var playDuration: Double
}

func slicePCM(_ pcm: PCMBuffer, start: Double, end: Double) -> PCMBuffer {
    let sr = Double(pcm.sampleRate)
    let a = max(0, jsRound(start * sr))
    let z = min(pcm.frameCount, max(a + 1, jsRound(end * sr)))
    let hi = max(a, z)
    let channels = pcm.channels.map { Array($0[a..<hi]) }
    return PCMBuffer(sampleRate: pcm.sampleRate, channels: channels)
}

func resolveVoice(
    pad: Pad, slice: Slice, source: PCMBuffer, bpm: Double, cache: inout [String: PCMBuffer]
) -> ResolvedVoice? {
    let plan = playPlan(pad: pad, slice: slice, bpm: bpm)
    if let ratio = plan.stretch {
        let key = "\(slice.sourceId)|\(slice.start)|\(slice.end)|\(String(format: "%.6f", ratio))|\(pad.reverse)"
        let baked: PCMBuffer
        if let hit = cache[key] {
            baked = hit
        } else {
            var region = slicePCM(source, start: slice.start, end: slice.end)
            let stretched = wsola(channels: region.channels, ratio: ratio)
            region = PCMBuffer(sampleRate: source.sampleRate, channels: stretched)
            if pad.reverse {
                region = PCMBuffer(sampleRate: region.sampleRate, channels: region.channels.map { Array($0.reversed()) })
            }
            cache[key] = region
            baked = region
        }
        return ResolvedVoice(
            buffer: baked, offset: 0, duration: baked.duration, rate: plan.rate, playDuration: plan.duration
        )
    }
    if pad.reverse {
        let region = slicePCM(source, start: slice.start, end: slice.end)
        let flipped = PCMBuffer(sampleRate: region.sampleRate, channels: region.channels.map { Array($0.reversed()) })
        return ResolvedVoice(
            buffer: flipped, offset: 0, duration: flipped.duration, rate: plan.rate, playDuration: plan.duration
        )
    }
    return ResolvedVoice(
        buffer: source,
        offset: slice.start,
        duration: max(0, slice.end - slice.start),
        rate: plan.rate,
        playDuration: plan.duration
    )
}

func sampleAt(_ buffer: PCMBuffer, channel: Int, _ pos: Double) -> Double {
    guard !buffer.channels.isEmpty else { return 0 }
    let ch = buffer.channels[min(channel, buffer.channels.count - 1)]
    if ch.isEmpty { return 0 }
    if pos <= 0 { return Double(ch[0]) }
    if pos >= Double(ch.count - 1) { return Double(ch[ch.count - 1]) }
    let i = Int(pos)
    let f = pos - Double(i)
    return Double(ch[i]) * (1 - f) + Double(ch[i + 1]) * f
}

func mixVoice(
    into channels: inout [[Float]], sampleRate outSR: Int, voice: ResolvedVoice, pad: Pad,
    velocity: Int, startTime: Double, stopAt: Double?, stopFade: Double?
) {
    guard channels.count >= 2, outSR > 0, voice.buffer.sampleRate > 0 else { return }
    let attack = max(minAttack, pad.attack)
    let natural = pad.mode == .loop ? Double.infinity : voice.playDuration
    let fadeDefault = stopFade ?? max(minRelease, pad.release)
    let relStart: Double
    let relEnd: Double
    if let stopAt {
        let t = max(stopAt - startTime, attack)
        if t + fadeDefault < natural {
            relStart = t
            relEnd = t + fadeDefault
        } else if natural.isFinite {
            let fade = min(max(minRelease, pad.release), max(0.001, voice.playDuration - attack))
            relStart = max(attack, voice.playDuration - fade)
            relEnd = voice.playDuration
        } else {
            relStart = t
            relEnd = t + fadeDefault
        }
    } else if natural.isFinite {
        let fade = min(max(minRelease, pad.release), max(0.001, voice.playDuration - attack))
        relStart = max(attack, voice.playDuration - fade)
        relEnd = voice.playDuration
    } else {
        relStart = .infinity
        relEnd = .infinity
    }
    let peak = pad.volume * (Double(velocity) / 127)
    let pan = min(1, max(-1, pad.pan))
    let gainL = Double(min(1, 1 - pan))
    let gainR = Double(min(1, 1 + pan))
    let sr = Double(outSR)
    let srcSR = Double(voice.buffer.sampleRate)
    let startIndex = max(0, Int(floor(startTime * sr)))
    let endLimit = relEnd.isFinite ? startTime + relEnd : startTime + max(voice.playDuration, 0)
    let endIndex = min(channels[0].count, max(startIndex, Int(ceil(endLimit * sr + 1e-9))))
    let regionFrames = voice.duration * srcSR
    let srcOrigin = voice.offset * srcSR
    if startIndex >= endIndex { return }
    for i in startIndex..<endIndex {
        let t = Double(i) / sr - startTime
        if t < 0 { continue }
        let g: Double
        if t < attack {
            g = attack > 0 ? peak * (t / attack) : peak
        } else if t < relStart {
            g = peak
        } else if t < relEnd {
            let d = relEnd - relStart
            g = d > 0 ? peak * (1 - (t - relStart) / d) : 0
        } else {
            continue
        }
        if g == 0 { continue }
        var srcPos = t * voice.rate * srcSR
        if pad.mode == .loop {
            if regionFrames <= 1 { continue }
            srcPos = srcPos.truncatingRemainder(dividingBy: regionFrames)
            if srcPos < 0 { srcPos += regionFrames }
        } else if srcPos < 0 || srcPos >= regionFrames {
            continue
        }
        let pos = srcOrigin + srcPos
        let left = sampleAt(voice.buffer, channel: 0, pos)
        let right = voice.buffer.channels.count > 1 ? sampleAt(voice.buffer, channel: 1, pos) : left
        channels[0][i] += Float(left * g * gainL)
        channels[1][i] += Float(right * g * gainR)
    }
}

public struct PlannedHit: Equatable {
    public var noteId: String
    public var padId: String
    public var velocity: Int
    public var at: Double
    public var time: Double
    public var stopAt: Double?
    public var stopFade: Double?
}

public func exportSections(_ p: Project) -> [Section] {
    p.export.range == .song ? songSections(p) : patternSections(p, repeats: max(1, p.export.patternRepeats))
}

public func planHits(_ p: Project, sections: [Section]) -> (hits: [PlannedHit], musicSec: Double) {
    let total = sectionsLength(sections)
    let sd = stepDur(p.bpm)
    let raw = eventsInRange(p, sections: sections, fromStep: 0, toStep: Double(total), loop: false)
    let holds = holdEnds(raw, endStep: Double(total))
    let padById = Dictionary(uniqueKeysWithValues: p.pads.map { ($0.id, $0) })
    var hits: [PlannedHit] = raw.map { h in
        var out = PlannedHit(
            noteId: h.noteId, padId: h.padId, velocity: h.velocity, at: h.at, time: h.at * sd,
            stopAt: nil, stopFade: nil
        )
        if let pad = padById[h.padId], pad.mode != .oneshot {
            out.stopAt = (holds[holdKey(noteId: h.noteId, at: h.at)] ?? Double(total)) * sd
        }
        return out
    }
    for i in hits.indices {
        guard let pad = padById[hits[i].padId], pad.choke != nil else { continue }
        for j in (i + 1)..<hits.count {
            if hits[j].time <= hits[i].time { continue }
            if padById[hits[j].padId]?.choke != pad.choke { continue }
            if hits[i].stopAt == nil || hits[j].time < hits[i].stopAt! {
                hits[i].stopAt = hits[j].time
                hits[i].stopFade = chokeFade
            }
            break
        }
    }
    return (hits, Double(total) * sd)
}

func renderHits(
    _ p: Project, hits: [PlannedHit], frames: Int, sampleRate: Int, library: AudioLibrary
) -> [[Float]] {
    var channels = [
        [Float](repeating: 0, count: frames),
        [Float](repeating: 0, count: frames),
    ]
    var cache: [String: PCMBuffer] = [:]
    let padById = Dictionary(uniqueKeysWithValues: p.pads.map { ($0.id, $0) })
    let sliceById = Dictionary(uniqueKeysWithValues: p.slices.map { ($0.id, $0) })
    for hit in hits {
        guard let pad = padById[hit.padId], let sid = pad.sliceId, let slice = sliceById[sid],
              let source = library.buffers[slice.sourceId] else { continue }
        guard let voice = resolveVoice(pad: pad, slice: slice, source: source, bpm: p.bpm, cache: &cache) else { continue }
        mixVoice(
            into: &channels, sampleRate: sampleRate, voice: voice, pad: pad, velocity: hit.velocity,
            startTime: hit.time, stopAt: hit.stopAt, stopFade: hit.stopFade
        )
    }
    return channels
}
