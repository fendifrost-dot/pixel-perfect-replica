import Foundation

/// Pitch-preserving WSOLA stretch. Port of `src/lib/frost/stretch.ts`.
/// Baked ahead of playback so a pad trigger does not run this on the audio thread.

let wsolaN = 1024
let wsolaHS = 512
let wsolaDelta = 256
let wsolaDecim = 4

public func stretchLength(inputFrames: Int, ratio: Double) -> Int {
    max(1, jsRound(Double(inputFrames) * ratio))
}

public func wsola(channels: [[Float]], ratio: Double) -> [[Float]] {
    let n = channels.first?.count ?? 0
    let outLen = stretchLength(inputFrames: n, ratio: ratio)
    if n == 0 { return channels.map { _ in [Float](repeating: 0, count: outLen) } }
    if abs(ratio - 1) < 1e-6 { return channels.map { Array($0) } }
    let chCount = channels.count
    var mono = [Double](repeating: 0, count: n)
    let inv = 1.0 / Double(chCount)
    for c in channels {
        let m = min(n, c.count)
        for i in 0..<m { mono[i] += Double(c[i]) * inv }
    }
    func at(_ i: Int) -> Double {
        (i >= 0 && i < n) ? mono[i] : 0
    }
    var window = [Double](repeating: 0, count: wsolaN)
    for i in 0..<wsolaN {
        window[i] = 0.5 - 0.5 * cos((2 * Double.pi * Double(i)) / Double(wsolaN))
    }
    var out = Array(repeating: [Double](repeating: 0, count: outLen + wsolaN), count: chCount)
    var norm = [Double](repeating: 0, count: outLen + wsolaN)
    let ha = Double(wsolaHS) / ratio
    var prev = 0
    let frames = Int(ceil(Double(outLen) / Double(wsolaHS))) + 1
    for k in 0..<frames {
        let nominal = jsRound(Double(k) * ha)
        var pos = nominal
        if k > 0 {
            let target = prev + wsolaHS
            var best = -Double.infinity
            let lo = max(-wsolaDelta, -nominal)
            var d = lo
            while d <= wsolaDelta {
                let cand = nominal + d
                var s = 0.0
                var i = 0
                while i < wsolaN {
                    s += at(target + i) * at(cand + i)
                    i += wsolaDecim
                }
                if s > best {
                    best = s
                    pos = cand
                }
                d += 2
            }
        }
        prev = pos
        let o = k * wsolaHS
        for i in 0..<wsolaN {
            let src = pos + i
            let w = (k == 0 && i < wsolaHS) ? 1.0 : window[i]
            let oi = o + i
            if oi >= 0 && oi < norm.count { norm[oi] += w }
            if src < 0 || src >= n || oi < 0 || oi >= out[0].count { continue }
            for c in 0..<chCount where src < channels[c].count {
                out[c][oi] += Double(channels[c][src]) * w
            }
        }
    }
    return (0..<chCount).map { c in
        var r = [Float](repeating: 0, count: outLen)
        let src = out[c]
        for i in 0..<outLen {
            r[i] = norm[i] > 1e-3 ? Float(src[i] / max(norm[i], 0.5)) : 0
        }
        return r
    }
}
