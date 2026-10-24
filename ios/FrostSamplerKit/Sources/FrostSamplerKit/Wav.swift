import Foundation

/// 24-bit PCM WAV encode and decode. Port of `src/lib/frost/wav.ts`.

public struct EncodeResult: Equatable {
    public var bytes: Data
    public var clipped: Int
    public var peak: Double
}

public func encodeWav24(channels: [[Float]], sampleRate: Int) -> EncodeResult {
    let nch = channels.count
    let frames = channels.first?.count ?? 0
    let blockAlign = nch * 3
    let dataBytes = frames * blockAlign
    var bytes = Data(count: 44 + dataBytes)
    func ascii(_ offset: Int, _ s: String) {
        for (i, byte) in s.utf8.enumerated() { bytes[offset + i] = byte }
    }
    func u16(_ offset: Int, _ v: UInt16) {
        bytes[offset] = UInt8(v & 0xff)
        bytes[offset + 1] = UInt8((v >> 8) & 0xff)
    }
    func u32(_ offset: Int, _ v: UInt32) {
        bytes[offset] = UInt8(v & 0xff)
        bytes[offset + 1] = UInt8((v >> 8) & 0xff)
        bytes[offset + 2] = UInt8((v >> 16) & 0xff)
        bytes[offset + 3] = UInt8((v >> 24) & 0xff)
    }
    ascii(0, "RIFF")
    u32(4, UInt32(36 + dataBytes))
    ascii(8, "WAVE")
    ascii(12, "fmt ")
    u32(16, 16)
    u16(20, 1)
    u16(22, UInt16(nch))
    u32(24, UInt32(sampleRate))
    u32(28, UInt32(sampleRate * blockAlign))
    u16(32, UInt16(blockAlign))
    u16(34, 24)
    ascii(36, "data")
    u32(40, UInt32(dataBytes))

    var clipped = 0
    var peak = 0.0
    var o = 44
    for i in 0..<frames {
        for c in 0..<nch {
            let x = Double(channels[c][i])
            let a = abs(x)
            if a > peak { peak = a }
            var s = jsRound(x * 8_388_608)
            if s > 8_388_607 {
                s = 8_388_607
                clipped += 1
            } else if s < -8_388_608 {
                s = -8_388_608
                clipped += 1
            }
            bytes[o] = UInt8(s & 0xff)
            bytes[o + 1] = UInt8((s >> 8) & 0xff)
            bytes[o + 2] = UInt8((s >> 16) & 0xff)
            o += 3
        }
    }
    return EncodeResult(bytes: bytes, clipped: clipped, peak: peak)
}

public struct DecodedWav: Equatable {
    public var sampleRate: Int
    public var bitsPerSample: Int
    public var channels: [[Float]]
}

public enum WavError: Error, Equatable, CustomStringConvertible {
    case notWav
    case missingChunk
    case unsupported(String)

    public var description: String {
        switch self {
        case .notWav: return "Not a WAV file"
        case .missingChunk: return "WAV missing fmt or data chunk"
        case .unsupported(let s): return s
        }
    }
}

public func decodeWav(_ bytes: Data) throws -> DecodedWav {
    func tag(_ o: Int) -> String {
        guard o + 4 <= bytes.count else { return "" }
        return String(bytes: bytes[o..<(o + 4)], encoding: .ascii) ?? ""
    }
    guard bytes.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else { throw WavError.notWav }
    var pos = 12
    var format = 0
    var nch = 0
    var sr = 0
    var bits = 0
    var haveFmt = false
    var dataStart = 0
    var dataSize = 0
    var haveData = false
    while pos + 8 <= bytes.count {
        let id = tag(pos)
        let size = Int(u32(bytes, pos + 4))
        if id == "fmt ", pos + 8 + 16 <= bytes.count {
            format = Int(u16(bytes, pos + 8))
            if format == 0xfffe, size >= 26, pos + 8 + 26 <= bytes.count {
                format = Int(u16(bytes, pos + 32))
            }
            nch = Int(u16(bytes, pos + 10))
            sr = Int(u32(bytes, pos + 12))
            bits = Int(u16(bytes, pos + 22))
            haveFmt = true
        } else if id == "data" {
            dataStart = pos + 8
            dataSize = min(size, bytes.count - pos - 8)
            haveData = true
        }
        let padded = size + (size & 1)
        pos += 8 + padded
    }
    guard haveFmt, haveData else { throw WavError.missingChunk }
    guard nch > 0, bits > 0 else { throw WavError.unsupported("Unsupported WAV format \(format)/\(bits)-bit") }
    let bps = bits / 8
    let frames = dataSize / (bps * nch)
    var channels = Array(repeating: [Float](repeating: 0, count: frames), count: nch)
    for i in 0..<frames {
        for c in 0..<nch {
            let o = dataStart + (i * nch + c) * bps
            let x: Float
            if format == 3 && bits == 32 {
                x = Float(f32(bytes, o))
            } else if format == 1 && bits == 24 {
                let u = UInt32(bytes[o]) | (UInt32(bytes[o + 1]) << 8) | (UInt32(bytes[o + 2]) << 16)
                let signed = Int32(bitPattern: u << 8) >> 8
                x = Float(Double(signed) / 8_388_608)
            } else if format == 1 && bits == 16 {
                let v = Int16(bitPattern: u16(bytes, o))
                x = Float(Double(v) / 32768)
            } else {
                throw WavError.unsupported("Unsupported WAV format \(format)/\(bits)-bit")
            }
            channels[c][i] = x
        }
    }
    return DecodedWav(sampleRate: sr, bitsPerSample: bits, channels: channels)
}

private func u16(_ bytes: Data, _ o: Int) -> UInt16 {
    UInt16(bytes[o]) | (UInt16(bytes[o + 1]) << 8)
}

private func u32(_ bytes: Data, _ o: Int) -> UInt32 {
    UInt32(bytes[o]) | (UInt32(bytes[o + 1]) << 8) | (UInt32(bytes[o + 2]) << 16) | (UInt32(bytes[o + 3]) << 24)
}

private func f32(_ bytes: Data, _ o: Int) -> Float {
    let u = u32(bytes, o)
    return Float(bitPattern: u)
}
