import Foundation

/// `Math.round` in JavaScript: half rounds toward +∞.
func jsRound(_ x: Double) -> Int {
    Int(floor(x + 0.5))
}

func jsPosMod(_ x: Double, _ length: Int) -> Double {
    let m = Double(length)
    guard m > 0 else { return 0 }
    var r = x.truncatingRemainder(dividingBy: m)
    if r < 0 { r += m }
    return r
}

func jsNumber(_ x: Double) -> String {
    if x.isFinite, x == Double(jsRound(x)), abs(x) < 1e15 {
        return String(jsRound(x))
    }
    return String(x)
}
