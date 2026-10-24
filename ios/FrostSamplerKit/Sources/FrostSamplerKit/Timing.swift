import Foundation

/// Pure tempo / grid / event math. Port of `src/lib/frost/timing.ts`.
/// Live playback and offline export both schedule from `eventsInRange`.

public let stepsPerBeat = 4

public func stepDur(_ bpm: Double) -> Double {
    60 / bpm / Double(stepsPerBeat)
}

private func gridSteps(_ quantize: Quantize) -> Double? {
    switch quantize {
    case .off: return nil
    case .eighth: return 2
    case .sixteenth: return 1
    case .thirtySecond: return 0.5
    }
}

public func effectiveStep(
    step: Int, offset: Double, quantize: Quantize, swing: Double, lengthSteps: Int
) -> Double {
    let raw = Double(step) + offset
    let g = gridSteps(quantize)
    var pos = g == nil ? raw : Double(jsRound(raw / g!)) * g!
    let unit: Double = g == 2 ? 2 : 1
    let k = pos / unit
    let roundedK = jsRound(k)
    if abs(k - Double(roundedK)) < 1e-9 && roundedK % 2 != 0 {
        let clamped = min(75, max(50, swing))
        pos += ((clamped - 50) / 50) * unit
    }
    return jsPosMod(pos, lengthSteps)
}

public func effectiveStep(
    _ note: NoteEvent, quantize: Quantize, swing: Double, lengthSteps: Int
) -> Double {
    effectiveStep(step: note.step, offset: note.offset, quantize: quantize, swing: swing, lengthSteps: lengthSteps)
}

public func recordPosition(posSteps: Double, lengthSteps: Int) -> (step: Int, offset: Double) {
    let p = jsPosMod(posSteps, lengthSteps)
    let rounded = jsRound(p)
    var step = rounded % lengthSteps
    if step < 0 { step += lengthSteps }
    var offset = p - Double(rounded)
    if offset >= 0.5 { offset = 0.4999 }
    if offset < -0.5 { offset = -0.5 }
    offset = Double(jsRound(offset * 1000)) / 1000
    return (step, offset)
}

public struct Section: Equatable {
    public var pattern: Pattern
    public var startStep: Int

    public init(pattern: Pattern, startStep: Int) {
        self.pattern = pattern
        self.startStep = startStep
    }
}

public func songSections(_ p: Project) -> [Section] {
    var out: [Section] = []
    var at = 0
    for block in p.arrangement {
        guard let pattern = p.patterns.first(where: { $0.id == block.patternId }) else { continue }
        out.append(Section(pattern: pattern, startStep: at))
        at += pattern.lengthSteps
    }
    return out.isEmpty ? patternSections(p, repeats: 1) : out
}

public func patternSections(_ p: Project, repeats: Int) -> [Section] {
    guard let pattern = p.patterns.first(where: { $0.id == p.currentPatternId }) ?? p.patterns.first else {
        return []
    }
    return (0..<max(0, repeats)).map { Section(pattern: pattern, startStep: $0 * pattern.lengthSteps) }
}

public func sectionsLength(_ sections: [Section]) -> Int {
    sections.reduce(0) { max($0, $1.startStep + $1.pattern.lengthSteps) }
}

public struct ScheduledHit: Equatable {
    public var noteId: String
    public var padId: String
    public var velocity: Int
    public var at: Double

    public init(noteId: String, padId: String, velocity: Int, at: Double) {
        self.noteId = noteId
        self.padId = padId
        self.velocity = velocity
        self.at = at
    }
}

public func holdKey(noteId: String, at: Double) -> String {
    "\(noteId)@\(jsNumber(at))"
}

public func eventsInRange(
    _ p: Project, sections: [Section], fromStep: Double, toStep: Double, loop: Bool
) -> [ScheduledHit] {
    let total = sectionsLength(sections)
    if total == 0 || toStep <= fromStep { return [] }
    var out: [ScheduledHit] = []
    let firstCycle = loop ? Int(floor(fromStep / Double(total))) - 1 : 0
    let lastCycle = loop ? Int(floor(toStep / Double(total))) : 0
    if firstCycle > lastCycle { return [] }
    for c in firstCycle...lastCycle {
        if c < 0 { continue }
        for sec in sections {
            let pat = sec.pattern
            let anySolo = pat.lanes.contains { $0.solo }
            let base = c * total + sec.startStep
            if Double(base + pat.lengthSteps + 1) <= fromStep || Double(base - 1) >= toStep { continue }
            for note in pat.notes {
                if let lane = pat.lanes.first(where: { $0.padId == note.padId }) {
                    if lane.mute || (anySolo && !lane.solo) { continue }
                }
                let at = Double(base) + effectiveStep(note, quantize: p.quantize, swing: p.swing, lengthSteps: pat.lengthSteps)
                if at >= fromStep && at < toStep {
                    out.append(ScheduledHit(noteId: note.id, padId: note.padId, velocity: note.velocity, at: at))
                }
            }
        }
    }
    out.sort { a, b in
        if a.at != b.at { return a.at < b.at }
        return a.padId < b.padId
    }
    return out
}

public struct PlayPlan: Equatable {
    public var rate: Double
    public var stretch: Double?
    public var duration: Double
    public var pitchSemis: Double
}

public func lengthBeats(_ pad: Pad) -> Double {
    pad.lengthUnit == .bars ? pad.lengthValue * 4 : pad.lengthValue
}

public func playPlan(pad: Pad, slice: Slice, bpm: Double) -> PlayPlan {
    let dur = slice.end - slice.start
    let pitchRate = pow(2.0, pad.pitch / 12.0)
    if pad.lengthUnit == .off || lengthBeats(pad) <= 0 || dur <= 0 {
        return PlayPlan(rate: pitchRate, stretch: nil, duration: dur / pitchRate, pitchSemis: pad.pitch)
    }
    let target = (lengthBeats(pad) * 60) / bpm
    if pad.timeMode == .repitch {
        let rate = dur / target
        return PlayPlan(rate: rate, stretch: nil, duration: target, pitchSemis: 12 * log2(rate))
    }
    return PlayPlan(
        rate: pitchRate,
        stretch: (target / dur) * pitchRate,
        duration: target,
        pitchSemis: pad.pitch
    )
}

public func holdEnds(_ hits: [ScheduledHit], endStep: Double) -> [String: Double] {
    var next: [String: Double] = [:]
    var res: [String: Double] = [:]
    for hit in hits.reversed() {
        res[holdKey(noteId: hit.noteId, at: hit.at)] = next[hit.padId] ?? endStep
        next[hit.padId] = hit.at
    }
    return res
}

/// Step position of the transport after `elapsed` seconds. Same 16th-note grid as the web engine.
public func transportStep(bpm: Double, elapsed: Double) -> Double {
    elapsed / stepDur(bpm)
}
