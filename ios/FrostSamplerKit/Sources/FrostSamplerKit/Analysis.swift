import Foundation

/// Onset detection, tempo suggestion, beat grid, waveform columns.
/// Port of `src/lib/frost/analysis.ts`. A suggestion is never applied as project BPM by itself.

let analysisHop = 256
public let preRollSec = 0.001
let riseLookback = 12
let energyHops = 8

public func hopEnergy(_ x: [Float]) -> [Double] {
    let hops = x.count / analysisHop
    if hops <= 0 { return [] }
    var e = [Double](repeating: 0, count: hops)
    for h in 0..<hops {
        var acc = 0.0
        let base = h * analysisHop
        var i = max(1, base)
        let end = base + analysisHop
        while i < end {
            let d = Double(x[i]) - Double(x[i - 1])
            acc += d * d
            i += 1
        }
        e[h] = acc / Double(analysisHop)
    }
    return e
}

public func onsetFunction(_ x: [Float], energy: [Double]? = nil) -> [Double] {
    let e = energy ?? hopEnergy(x)
    var db = [Double](repeating: 0, count: e.count)
    var win = 0.0
    for h in 0..<e.count {
        win += e[h]
        if h >= energyHops { win -= e[h - energyHops] }
        let denom = win / Double(min(energyHops, h + 1)) + 1e-10
        db[h] = max(-80, 10 * log10(denom))
    }
    var flux = [Double](repeating: 0, count: db.count)
    guard db.count > 1 else { return flux }
    for h in 1..<db.count {
        var floorV = db[h - 1]
        var k = max(0, h - riseLookback)
        while k < h - 1 {
            if db[k] < floorV { floorV = db[k] }
            k += 1
        }
        flux[h] = db[h] > db[h - 1] ? max(0, db[h] - floorV) : 0
    }
    return flux
}

public func firstAudible(_ x: [Float], sampleRate: Int, thresholdDb: Double = -40) -> Double {
    let lim = pow(10.0, thresholdDb / 20)
    for i in 0..<x.count where abs(Double(x[i])) >= lim {
        return Double(i) / Double(sampleRate)
    }
    return 0
}

public func detectOnsets(
    _ x: [Float], sampleRate: Int, start: Double, end: Double, sensitivity: Double
) -> [Double] {
    let sr = Double(sampleRate)
    let a = max(0, Int(floor(start * sr)))
    let b = min(x.count, Int(floor(end * sr)))
    if b - a < analysisHop * 4 { return [] }
    let seg = Array(x[a..<b])
    let energy = hopEnergy(seg)
    let flux = onsetFunction(seg, energy: energy)
    let s = min(1, max(0, sensitivity))
    let threshold = 4 + (1 - s) * 16
    let minGap = max(1, Int(floor((0.08 * sr) / Double(analysisHop))))
    var out: [Double] = []
    var last = -minGap
    if flux.count < 3 { return [] }
    for h in 1..<(flux.count - 1) {
        let v = flux[h]
        if v < threshold || h - last < minGap { continue }
        var crest = true
        var k = max(0, h - riseLookback)
        let kEnd = min(flux.count - 1, h + riseLookback)
        while k <= kEnd && crest {
            if flux[k] > v || (flux[k] == v && k < h) { crest = false }
            k += 1
        }
        if !crest { continue }
        last = h
        var hm = h
        var k2 = max(0, h - energyHops - riseLookback)
        while k2 < h {
            if energy[k2] > energy[hm] { hm = k2 }
            k2 += 1
        }
        var hs = hm
        while hs > 0 && hm - hs < riseLookback && energy[hs - 1] < energy[hs] { hs -= 1 }
        let r0 = max(0, hs * analysisHop)
        let r1 = min(seg.count, (hm + 1) * analysisHop)
        var peak = 0.0
        if r0 < r1 {
            for i in r0..<r1 { peak = max(peak, abs(Double(seg[i]))) }
        }
        var first = h * analysisHop
        if r0 < r1 {
            for i in r0..<r1 where abs(Double(seg[i])) >= peak * 0.25 {
                first = i
                break
            }
        }
        out.append(max(start, Double(a + first) / sr - preRollSec))
    }
    return out
}

public struct TempoSuggestion: Equatable {
    public var bpm: Double
    public var confidence: Double
}

public func suggestTempo(_ x: [Float], sampleRate: Int) -> TempoSuggestion? {
    let limit = min(x.count, sampleRate * 90)
    guard limit > 0 else { return nil }
    let flux = onsetFunction(Array(x[0..<limit]))
    if flux.count < 64 { return nil }
    var mean = 0.0
    for v in flux { mean += v }
    mean /= Double(flux.count)
    let f = flux.map { $0 - mean }
    let hopSec = Double(analysisHop) / Double(sampleRate)
    let minLag = Int(floor(60 / 180 / hopSec))
    let maxLag = Int(ceil(60 / 70 / hopSec))
    if maxLag >= f.count / 2 { return nil }
    func ac(_ lag: Int) -> Double {
        if lag < 0 { return 0 }
        var s = 0.0
        let n = f.count - lag
        if n <= 0 { return 0 }
        for i in 0..<n { s += f[i] * f[i + lag] }
        return s
    }
    let zero = ac(0)
    if zero <= 0 { return nil }
    var best = -Double.infinity
    var bestLag = 0
    if minLag > maxLag { return nil }
    for lag in minLag...maxLag {
        let v = ac(lag)
        if v > best {
            best = v
            bestLag = lag
        }
    }
    if bestLag <= 0 || best <= 0 { return nil }
    let y0 = ac(bestLag - 1)
    let y2 = ac(bestLag + 1)
    let den = y0 - 2 * best + y2
    let lag = Double(bestLag) + (den != 0 ? (0.5 * (y0 - y2)) / den : 0)
    var bpm = 60 / (lag * hopSec)
    while bpm < 80 { bpm *= 2 }
    while bpm > 160 { bpm /= 2 }
    return TempoSuggestion(bpm: Double(jsRound(bpm * 10)) / 10, confidence: best / zero)
}

public func generateBeatGrid(bpm: Double, firstBeat: Double, duration: Double, beatsPerBar: Int = 4) -> BeatGrid {
    var beats: [Double] = []
    let spb = 60 / bpm
    var t = firstBeat
    while t < duration {
        beats.append(Double(jsRound(t * 1e6)) / 1e6)
        t += spb
    }
    return BeatGrid(bpm: bpm, beatsPerBar: beatsPerBar, beats: beats)
}

public func moveBeat(_ grid: BeatGrid, index: Int, t: Double) -> BeatGrid {
    var beats = grid.beats
    guard beats.indices.contains(index) else { return grid }
    let lo = index > 0 ? beats[index - 1] + 0.001 : 0
    let hi = index < beats.count - 1 ? beats[index + 1] - 0.001 : Double.infinity
    beats[index] = min(hi, max(lo, t))
    return BeatGrid(bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, beats: beats)
}

public func boundaries(cuts: [Double], start: Double, end: Double, minLen: Double = 0.01) -> [Double] {
    let inside = cuts.filter { $0 > start + minLen && $0 < end - minLen }.sorted()
    var out = [start]
    for c in inside where c - out[out.count - 1] >= minLen {
        out.append(c)
    }
    out.append(end)
    return out
}

/// Min/max per column for [t0, t1). Values start at 0, so a positive-only signal keeps min at 0.
public func waveColumns(
    channels: [[Float]], sampleRate: Int, t0: Double, t1: Double, columns: Int
) -> [Float] {
    guard columns > 0, let first = channels.first, !first.isEmpty else {
        return [Float](repeating: 0, count: max(0, columns) * 2)
    }
    var out = [Float](repeating: 0, count: columns * 2)
    let f0 = t0 * Double(sampleRate)
    let fpc = ((t1 - t0) * Double(sampleRate)) / Double(columns)
    let step = max(1, Int(floor(fpc / 64)))
    let n = channels.map(\.count).min() ?? 0
    for c in 0..<columns {
        let a = max(0, Int(floor(f0 + Double(c) * fpc)))
        let b = min(n, max(a + 1, Int(floor(f0 + Double(c + 1) * fpc))))
        var mn: Float = 0
        var mx: Float = 0
        for ch in channels {
            var i = a
            while i < b && i < ch.count {
                let v = ch[i]
                if v < mn { mn = v }
                if v > mx { mx = v }
                i += step
            }
        }
        out[c * 2] = mn
        out[c * 2 + 1] = mx
    }
    return out
}
