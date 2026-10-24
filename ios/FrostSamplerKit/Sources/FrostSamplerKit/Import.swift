import Foundation

/// Song import. WAV is decoded in this package on every platform. MP3 and other files
/// decode through AVAudioFile on iOS and macOS. Nothing is uploaded.

public struct ImportedSong: Equatable {
    public var asset: SourceAsset
    public var pcm: PCMBuffer
    public var fileBytes: Data
    public var mime: String
}

public enum ImportError: Error, Equatable, CustomStringConvertible, LocalizedError {
    case empty
    case needsDeviceDecoder(String)
    case unreadable(String)

    public var description: String {
        switch self {
        case .empty: return "That file had no samples."
        case .needsDeviceDecoder(let msg): return msg
        case .unreadable(let msg): return msg
        }
    }

    public var errorDescription: String? { description }
}

public func isWav(_ data: Data) -> Bool {
    guard data.count >= 12 else { return false }
    let riff = String(bytes: data[0..<4], encoding: .ascii)
    let wave = String(bytes: data[8..<12], encoding: .ascii)
    return riff == "RIFF" && wave == "WAVE"
}

public func importWAV(name: String, id: String, data: Data) throws -> ImportedSong {
    if data.isEmpty { throw ImportError.empty }
    let decoded = try decodeWav(data)
    if decoded.channels.isEmpty || decoded.channels[0].isEmpty { throw ImportError.empty }
    return song(name: name, id: id, pcm: PCMBuffer(sampleRate: decoded.sampleRate, channels: decoded.channels), bytes: data, mime: "audio/wav")
}

public func importSong(name: String, id: String, data: Data, url: URL? = nil) throws -> ImportedSong {
    if isWav(data) { return try importWAV(name: name, id: id, data: data) }
    #if canImport(AVFoundation)
    if let url { return try importWithAVAudioFile(url: url, name: name, id: id, fallbackBytes: data) }
    #endif
    throw ImportError.needsDeviceDecoder(
        "This file is not WAV. On iPhone, MP3 and other songs decode with AVAudioFile. This environment only decoded WAV."
    )
}

func song(name: String, id: String, pcm: PCMBuffer, bytes: Data, mime: String) -> ImportedSong {
    let suggestion = suggestTempo(pcm.mono(), sampleRate: pcm.sampleRate)
    let asset = SourceAsset(
        id: id,
        name: cleanName(name),
        durationSec: pcm.duration,
        sampleRate: pcm.sampleRate,
        channels: pcm.channels.count,
        origin: .imported,
        persistence: .device,
        detectedBpm: suggestion?.bpm
    )
    return ImportedSong(asset: asset, pcm: pcm, fileBytes: bytes, mime: mime)
}

public func store(_ song: ImportedSong, in library: inout AudioLibrary, project: Project) -> Project {
    library.buffers[song.asset.id] = song.pcm
    library.fileBytes[song.asset.id] = song.fileBytes
    library.mime[song.asset.id] = song.mime
    return addSource(project, asset: song.asset)
}

#if canImport(AVFoundation)
import AVFoundation

func importWithAVAudioFile(url: URL, name: String, id: String, fallbackBytes: Data) throws -> ImportedSong {
    let file: AVAudioFile
    do { file = try AVAudioFile(forReading: url) } catch {
        throw ImportError.unreadable("Could not read that audio file.")
    }
    let format = file.processingFormat
    let frames = AVAudioFrameCount(file.length)
    if frames == 0 { throw ImportError.empty }
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
        throw ImportError.unreadable("Could not allocate a buffer for that file.")
    }
    do { try file.read(into: buf) } catch {
        throw ImportError.unreadable("Could not decode that audio file.")
    }
    guard let data = buf.floatChannelData else {
        throw ImportError.needsDeviceDecoder("That file did not decode to float PCM.")
    }
    let count = Int(buf.frameLength)
    var channels: [[Float]] = []
    for c in 0..<Int(format.channelCount) {
        channels.append(Array(UnsafeBufferPointer(start: data[c], count: count)))
    }
    let pcm = PCMBuffer(sampleRate: Int(format.sampleRate.rounded()), channels: channels)
    let bytes = fallbackBytes.isEmpty ? (try? Data(contentsOf: url)) ?? Data() : fallbackBytes
    return song(name: name, id: id, pcm: pcm, bytes: bytes, mime: "application/octet-stream")
}
#endif
