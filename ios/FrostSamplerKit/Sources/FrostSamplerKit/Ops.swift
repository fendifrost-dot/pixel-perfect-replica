import Foundation

/// Pure project edits shared with the web MCP tools (`src/lib/frost/ops.ts`).
/// Invalid input throws `OpsError`. No network and no audio device.

public struct OpsError: Error, Equatable, CustomStringConvertible, LocalizedError {
    public let message: String
    public var description: String { message }
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

func nextId(_ prefix: String) -> String {
    let raw = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    return "\(prefix)_\(raw.prefix(8))"
}

func clampBpm(_ v: Double) throws -> Double {
    if !(v >= 40 && v <= 300) { throw OpsError("BPM must be between 40 and 300.") }
    return Double(jsRound(v * 10)) / 10
}

func padOf(_ p: Project, _ padId: String) throws -> Pad {
    let id = padId.uppercased()
    guard let pad = p.pads.first(where: { $0.id == id }) else {
        throw OpsError("Unknown pad \"\(padId)\". Pads are A1–A16, B1–B16, C1–C16, D1–D16.")
    }
    return pad
}

func patternOf(_ p: Project, _ patternId: String?) throws -> Pattern {
    let id = patternId ?? p.currentPatternId
    guard let pattern = p.patterns.first(where: {
        $0.id == id || $0.name.lowercased() == id.lowercased()
    }) else {
        let names = p.patterns.map { "\($0.id) (\($0.name))" }.joined(separator: ", ")
        throw OpsError("Unknown pattern \"\(id)\". Patterns: \(names).")
    }
    return pattern
}

func sourceOf(_ p: Project, _ sourceId: String) throws -> SourceAsset {
    guard let source = p.sources.first(where: { $0.id == sourceId }) else {
        let names = p.sources.map { "\($0.id) (\($0.name))" }.joined(separator: ", ")
        throw OpsError("Unknown recording \"\(sourceId)\". Recordings: \(names.isEmpty ? "none" : names).")
    }
    return source
}

func mapPattern(_ p: Project, _ id: String, _ fn: (Pattern) -> Pattern) -> Project {
    var out = p
    out.patterns = p.patterns.map { $0.id == id ? fn($0) : $0 }
    return out
}

public func newProject(name: String, bpm: Double = 90) throws -> Project {
    var p = createEmptyProject(name: name)
    p.bpm = try clampBpm(bpm)
    return p
}

public struct ProjectFields {
    public var name: String?
    public var bpm: Double?
    public var quantize: Quantize?
    public var swing: Double?
    public var bank: Bank?

    public init(name: String? = nil, bpm: Double? = nil, quantize: Quantize? = nil, swing: Double? = nil, bank: Bank? = nil) {
        self.name = name
        self.bpm = bpm
        self.quantize = quantize
        self.swing = swing
        self.bank = bank
    }
}

public func setProjectFields(_ p: Project, _ f: ProjectFields) throws -> Project {
    var out = p
    if let name = f.name { out.name = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? p.name : name.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let bpm = f.bpm { out.bpm = try clampBpm(bpm) }
    if let quantize = f.quantize { out.quantize = quantize }
    if let swing = f.swing {
        if !(swing >= 50 && swing <= 75) { throw OpsError("Swing is 50–75 (%).") }
        out.swing = Double(jsRound(swing))
    }
    if let bank = f.bank { out.bank = bank }
    out.isDemo = false
    return out
}

public func addSource(_ p: Project, asset: SourceAsset) -> Project {
    var out = p
    out.isDemo = false
    out.sources = p.sources.filter { $0.id != asset.id } + [asset]
    out.activeSourceId = asset.id
    if out.markers[asset.id] == nil { out.markers[asset.id] = [] }
    return out
}

public func setChopMarkers(_ p: Project, sourceId: String, times: [Double]) throws -> Project {
    let s = try sourceOf(p, sourceId)
    var seen = Set<Double>()
    var clean: [Double] = []
    for t in times {
        let pastEnd = s.durationSec != 0 && t >= s.durationSec
        if t > 0 && !pastEnd {
            let q = Double(jsRound(t * 1e6)) / 1e6
            if seen.insert(q).inserted { clean.append(q) }
        }
    }
    clean.sort()
    var out = p
    out.markers[sourceId] = clean
    return out
}

public struct ChopRegion: Equatable {
    public var start: Double
    public var end: Double
    public var name: String?

    public init(start: Double, end: Double, name: String? = nil) {
        self.start = start
        self.end = end
        self.name = name
    }
}

public struct ChopAssignment: Equatable {
    public var pad: String
    public var chop: String
}

public struct ChopResult {
    public var project: Project
    public var assigned: [ChopAssignment]
}

public func regionsFromCuts(_ cuts: [Double], start: Double, end: Double) -> [ChopRegion] {
    let mid = cuts.filter { $0 > start + 0.01 && $0 < end - 0.01 }.sorted()
    let b = [start] + mid + [end]
    return (0..<(b.count - 1)).map { ChopRegion(start: b[$0], end: b[$0 + 1]) }
}

public func makeChops(
    _ p: Project, sourceId: String, regions: [ChopRegion], pads explicit: [String]? = nil,
    startPad: String? = nil, bank: Bank = .A
) throws -> ChopResult {
    let src = try sourceOf(p, sourceId)
    if regions.isEmpty { throw OpsError("Give at least one region.") }
    if regions.count > 64 { throw OpsError("At most 64 chops at once.") }
    let targets: [String]
    if let explicit, !explicit.isEmpty {
        if explicit.count < regions.count { throw OpsError("Give one pad per region.") }
        targets = try explicit.map { try padOf(p, $0).id }
    } else {
        let first = try padOf(p, startPad ?? "\(bank.rawValue)1")
        let order = p.pads.map(\.id)
        guard let i0 = order.firstIndex(of: first.id) else { throw OpsError("Unknown pad.") }
        targets = Array(order[i0...].prefix(regions.count))
        if targets.count < regions.count { throw OpsError("Not enough pads after the start pad.") }
    }
    var slices: [Slice] = []
    for (i, r) in regions.enumerated() {
        if !(r.end > r.start && r.start >= 0) {
            throw OpsError("Region \(i + 1): end must be after start (seconds).")
        }
        if src.durationSec != 0 && r.start >= src.durationSec {
            throw OpsError("Region \(i + 1) starts after the recording ends (\(String(format: "%.2f", src.durationSec)) s).")
        }
        let name = r.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = src.durationSec != 0 ? min(r.end, src.durationSec) : r.end
        slices.append(Slice(
            id: nextId("sl"),
            sourceId: sourceId,
            name: (name?.isEmpty == false ? name! : "Chop \(p.slices.count + i + 1)"),
            start: r.start,
            end: end
        ))
    }
    let byPad = Dictionary(uniqueKeysWithValues: zip(targets, slices).map { ($0.0, $0.1) })
    var out = p
    out.isDemo = false
    out.slices = p.slices + slices
    out.pads = p.pads.map { pad in
        guard let slice = byPad[pad.id] else { return pad }
        var next = pad
        next.sliceId = slice.id
        return next
    }
    let assigned = zip(targets, slices).map { ChopAssignment(pad: $0.0, chop: $0.1.name) }
    return ChopResult(project: out, assigned: assigned)
}

public let minChopSec = 0.01

public func trimChop(_ p: Project, padId: String, start: Double, end: Double, keepSpeed: Bool = true) throws -> Project {
    let pad = try padOf(p, padId)
    guard let sid = pad.sliceId else { throw OpsError("Pad \(pad.id) is empty; there is no chop to trim.") }
    guard let slice = p.slices.first(where: { $0.id == sid }) else {
        throw OpsError("Pad \(pad.id) is empty; there is no chop to trim.")
    }
    let total = p.sources.first { $0.id == slice.sourceId }?.durationSec ?? .infinity
    let a = max(0, min(start, end))
    let b = min(total == 0 ? .infinity : total, max(start, end))
    if !(b - a >= minChopSec) { throw OpsError("A chop must be at least \(minChopSec * 1000) ms long.") }
    var next = pad
    let oldLen = slice.end - slice.start
    if keepSpeed && pad.lengthUnit != .off && oldLen > 0 {
        let beats = lengthBeats(pad) * ((b - a) / oldLen)
        let q = max(0.01, Double(jsRound(beats * 1000)) / 1000)
        if q >= 4 && q.truncatingRemainder(dividingBy: 4) == 0 {
            next.lengthUnit = .bars
            next.lengthValue = q / 4
        } else {
            next.lengthUnit = .beats
            next.lengthValue = q
        }
    }
    var out = p
    out.slices = p.slices.map { s in
        guard s.id == sid else { return s }
        var c = s
        c.start = a
        c.end = b
        return c
    }
    out.pads = p.pads.map { $0.id == pad.id ? next : $0 }
    return out
}

public struct PadPatch {
    public var chopName: String?
    public var fit: Fit?
    public var lengthBeats: Double?
    public var volume: Double?
    public var pan: Double?
    public var pitch: Double?
    public var velocity: Int?
    public var plays: Plays?
    public var chokeGroup: Int?
    public var reverse: Bool?
    public var fadeInMs: Double?
    public var fadeOutMs: Double?
    public var empty: Bool?
    public var chopStart: Double?
    public var chopEnd: Double?

    public enum Fit: String { case off, stretch, repitch }
    public enum Plays: String { case whole, held, loop }

    public init(
        chopName: String? = nil, fit: Fit? = nil, lengthBeats: Double? = nil, volume: Double? = nil,
        pan: Double? = nil, pitch: Double? = nil, velocity: Int? = nil, plays: Plays? = nil,
        chokeGroup: Int? = nil, reverse: Bool? = nil, fadeInMs: Double? = nil, fadeOutMs: Double? = nil,
        empty: Bool? = nil, chopStart: Double? = nil, chopEnd: Double? = nil
    ) {
        self.chopName = chopName
        self.fit = fit
        self.lengthBeats = lengthBeats
        self.volume = volume
        self.pan = pan
        self.pitch = pitch
        self.velocity = velocity
        self.plays = plays
        self.chokeGroup = chokeGroup
        self.reverse = reverse
        self.fadeInMs = fadeInMs
        self.fadeOutMs = fadeOutMs
        self.empty = empty
        self.chopStart = chopStart
        self.chopEnd = chopEnd
    }
}

private func ranged(_ v: Double, _ lo: Double, _ hi: Double, _ what: String) throws -> Double {
    if !(v >= lo && v <= hi) { throw OpsError("\(what) must be \(lo)–\(hi).") }
    return v
}

public func setPad(_ p: Project, padId: String, _ f: PadPatch) throws -> Project {
    let pad = try padOf(p, padId)
    if f.empty == true {
        var out = p
        out.pads = p.pads.map { item in
            guard item.id == pad.id else { return item }
            var next = item
            next.sliceId = nil
            return next
        }
        return out
    }
    var next = pad
    if let volume = f.volume { next.volume = try ranged(volume, 0, 1, "volume") }
    if let pan = f.pan { next.pan = try ranged(pan, -1, 1, "pan") }
    if let pitch = f.pitch { next.pitch = Double(jsRound(try ranged(pitch, -24, 24, "pitch (semitones)"))) }
    if let velocity = f.velocity {
        next.velocity = jsRound(try ranged(Double(velocity), 1, 127, "velocity"))
    }
    if let plays = f.plays {
        switch plays {
        case .whole: next.mode = .oneshot
        case .held: next.mode = .gate
        case .loop: next.mode = .loop
        }
    }
    if let choke = f.chokeGroup {
        let rounded = jsRound(try ranged(Double(choke), 0, 4, "chokeGroup"))
        next.choke = rounded == 0 ? nil : rounded
    }
    if let reverse = f.reverse { next.reverse = reverse }
    if let fade = f.fadeInMs { next.attack = try ranged(fade, 0, 500, "fadeInMs") / 1000 }
    if let fade = f.fadeOutMs { next.release = try ranged(fade, 0, 2000, "fadeOutMs") / 1000 }
    if let beats = f.lengthBeats {
        let b = try ranged(beats, 0.25, 128, "lengthBeats")
        if b >= 4 && b.truncatingRemainder(dividingBy: 4) == 0 {
            next.lengthUnit = .bars
            next.lengthValue = b / 4
        } else {
            next.lengthUnit = .beats
            next.lengthValue = b
        }
        if f.fit == nil && pad.lengthUnit == .off { next.timeMode = .stretch }
    }
    if let fit = f.fit {
        if fit == .off {
            next.lengthUnit = .off
        } else {
            next.timeMode = fit == .stretch ? .stretch : .repitch
            if next.lengthUnit == .off {
                next.lengthUnit = .beats
                next.lengthValue = 1
            }
        }
    }
    var slices = p.slices
    if let chopName = f.chopName {
        guard let sid = pad.sliceId else { throw OpsError("Pad \(pad.id) is empty; there is no chop to rename.") }
        let trimmed = chopName.trimmingCharacters(in: .whitespacesAndNewlines)
        slices = slices.map { s in
            guard s.id == sid else { return s }
            var c = s
            c.name = trimmed.isEmpty ? s.name : trimmed
            return c
        }
    }
    var out = p
    out.slices = slices
    out.pads = p.pads.map { $0.id == pad.id ? next : $0 }
    if f.chopStart == nil && f.chopEnd == nil { return out }
    guard let sid = pad.sliceId, let cur = out.slices.first(where: { $0.id == sid }) else {
        throw OpsError("Pad \(pad.id) is empty; there is no chop to trim.")
    }
    return try trimChop(out, padId: pad.id, start: f.chopStart ?? cur.start, end: f.chopEnd ?? cur.end, keepSpeed: f.lengthBeats == nil)
}

public func setBeatMarkers(_ p: Project, sourceId: String, bpm: Double, firstBeat: Double) throws -> Project {
    let s = try sourceOf(p, sourceId)
    if s.durationSec == 0 {
        throw OpsError("This recording's length isn't known yet — open the project in the app once, then try again.")
    }
    var out = p
    out.beatGrids[sourceId] = generateBeatGrid(bpm: try clampBpm(bpm), firstBeat: max(0, firstBeat), duration: s.durationSec)
    return out
}

public struct HitInput {
    public var pad: String
    public var step: Int
    public var velocity: Int?
    public var offset: Double?

    public init(pad: String, step: Int, velocity: Int? = nil, offset: Double? = nil) {
        self.pad = pad
        self.step = step
        self.velocity = velocity
        self.offset = offset
    }
}

public func addHits(_ p: Project, patternId: String? = nil, hits: [HitInput]) throws -> Project {
    let pt = try patternOf(p, patternId)
    var notes = pt.notes
    for h in hits {
        let pad = try padOf(p, h.pad)
        let step = jsRound(Double(h.step))
        if !(step >= 0 && step < pt.lengthSteps) {
            throw OpsError("Step \(h.step) is outside this \(pt.lengthSteps / 16)-bar pattern (0–\(pt.lengthSteps - 1)).")
        }
        let velocity = h.velocity == nil ? pad.velocity : min(127, max(1, h.velocity!))
        let offset = h.offset == nil ? 0 : min(0.49, max(-0.5, h.offset!))
        if let i = notes.firstIndex(where: { $0.padId == pad.id && $0.step == step }) {
            notes[i].velocity = velocity
            notes[i].offset = offset
        } else {
            notes.append(NoteEvent(id: nextId("n"), padId: pad.id, step: step, velocity: velocity, offset: offset))
        }
    }
    return mapPattern(p, pt.id) { pat in
        var copy = pat
        copy.notes = notes
        return copy
    }
}

public func removeHits(_ p: Project, patternId: String? = nil, pad: String, steps: [Int]? = nil) throws -> Project {
    let pt = try patternOf(p, patternId)
    let id = try padOf(p, pad).id
    let set = steps.map { Set($0.map { jsRound(Double($0)) }) }
    return mapPattern(p, pt.id) { pat in
        var copy = pat
        copy.notes = pat.notes.filter { n in
            n.padId != id || (set != nil && set?.contains(n.step) == false)
        }
        return copy
    }
}

public func setLane(_ p: Project, patternId: String? = nil, pad: String, mute: Bool? = nil, solo: Bool? = nil) throws -> Project {
    let pt = try patternOf(p, patternId)
    let id = try padOf(p, pad).id
    var lane = pt.lanes.first { $0.padId == id } ?? Lane(padId: id, mute: false, solo: false)
    if let mute { lane.mute = mute }
    if let solo { lane.solo = solo }
    return mapPattern(p, pt.id) { pat in
        var copy = pat
        copy.lanes = pat.lanes.filter { $0.padId != id } + [lane]
        return copy
    }
}

public func setExport(
    _ p: Project, mode: ExportSettings.Mode? = nil, sampleRate: Int? = nil,
    range: ExportSettings.Range? = nil, patternRepeats: Int? = nil, tailSec: Double? = nil
) throws -> Project {
    var e = p.export
    if let mode { e.mode = mode }
    if let sampleRate { e.sampleRate = sampleRate }
    if let range { e.range = range }
    if let patternRepeats { e.patternRepeats = patternRepeats }
    if let tailSec { e.tailSec = tailSec }
    if e.sampleRate != 44100 && e.sampleRate != 48000 { throw OpsError("sampleRate is 44100 or 48000.") }
    if !(e.patternRepeats >= 1 && e.patternRepeats <= 64) { throw OpsError("patternRepeats is 1–64.") }
    if !(e.tailSec >= 0 && e.tailSec <= 10) { throw OpsError("tailSec is 0–10.") }
    e.includeTails = e.tailSec > 0
    var out = p
    out.export = e
    return out
}

/// Onset chop onto consecutive pads. Does not change project BPM.
public func autoChop(
    _ p: Project, sourceId: String, samples: [Float], sampleRate: Int, start: Double, end: Double,
    sensitivity: Double = 0.5, bank: Bank = .A
) throws -> ChopResult {
    let cuts = detectOnsets(samples, sampleRate: sampleRate, start: start, end: end, sensitivity: sensitivity)
    let regions = regionsFromCuts(cuts, start: start, end: end).filter { $0.end - $0.start >= minChopSec }
    if regions.isEmpty { throw OpsError("No chop fit in that selection.") }
    return try makeChops(p, sourceId: sourceId, regions: regions, bank: bank)
}
