import Foundation

/// Frost Sampler project data model. Keep in lockstep with `src/lib/frost/types.ts`.
/// Bump both copies together. This package does not invent a second chop format.
public let schemaVersion = 2

public enum Bank: String, Codable, Equatable, CaseIterable {
    case A, B, C, D
}

public struct SourceAsset: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var durationSec: Double
    public var sampleRate: Int
    public var channels: Int
    public var origin: Origin
    public var persistence: Persistence
    public var detectedBpm: Double?

    public enum Origin: String, Codable, Equatable {
        case demo, imported, kit
    }

    public enum Persistence: String, Codable, Equatable {
        case demo
        case sessionOnly = "session-only"
        case device
        case generated
    }

    public init(
        id: String, name: String, durationSec: Double, sampleRate: Int, channels: Int,
        origin: Origin, persistence: Persistence, detectedBpm: Double?
    ) {
        self.id = id
        self.name = name
        self.durationSec = durationSec
        self.sampleRate = sampleRate
        self.channels = channels
        self.origin = origin
        self.persistence = persistence
        self.detectedBpm = detectedBpm
    }
}

public struct Slice: Codable, Equatable, Identifiable {
    public var id: String
    public var sourceId: String
    public var name: String
    public var start: Double
    public var end: Double

    public init(id: String, sourceId: String, name: String, start: Double, end: Double) {
        self.id = id
        self.sourceId = sourceId
        self.name = name
        self.start = start
        self.end = end
    }
}

public enum PadColor: String, Codable, Equatable { case teal, purple, amber }
public enum PlayMode: String, Codable, Equatable { case oneshot, gate, loop }
public enum TimeMode: String, Codable, Equatable { case repitch, stretch }
public enum LengthUnit: String, Codable, Equatable { case off, beats, bars }

public struct Pad: Codable, Equatable, Identifiable {
    public var id: String
    public var bank: Bank
    public var index: Int
    public var sliceId: String?
    public var color: PadColor
    public var volume: Double
    public var pan: Double
    public var pitch: Double
    public var reverse: Bool
    public var mode: PlayMode
    public var choke: Int?
    public var attack: Double
    public var release: Double
    public var timeMode: TimeMode
    public var lengthUnit: LengthUnit
    public var lengthValue: Double
    public var velocity: Int

    public init(
        id: String, bank: Bank, index: Int, sliceId: String?, color: PadColor, volume: Double,
        pan: Double, pitch: Double, reverse: Bool, mode: PlayMode, choke: Int?, attack: Double,
        release: Double, timeMode: TimeMode, lengthUnit: LengthUnit, lengthValue: Double, velocity: Int
    ) {
        self.id = id
        self.bank = bank
        self.index = index
        self.sliceId = sliceId
        self.color = color
        self.volume = volume
        self.pan = pan
        self.pitch = pitch
        self.reverse = reverse
        self.mode = mode
        self.choke = choke
        self.attack = attack
        self.release = release
        self.timeMode = timeMode
        self.lengthUnit = lengthUnit
        self.lengthValue = lengthValue
        self.velocity = velocity
    }
}

public struct NoteEvent: Codable, Equatable, Identifiable {
    public var id: String
    public var padId: String
    public var step: Int
    public var velocity: Int
    public var offset: Double

    public init(id: String, padId: String, step: Int, velocity: Int, offset: Double) {
        self.id = id
        self.padId = padId
        self.step = step
        self.velocity = velocity
        self.offset = offset
    }
}

public struct Lane: Codable, Equatable {
    public var padId: String
    public var mute: Bool
    public var solo: Bool

    public init(padId: String, mute: Bool, solo: Bool) {
        self.padId = padId
        self.mute = mute
        self.solo = solo
    }
}

public struct Pattern: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var lengthSteps: Int
    public var lanes: [Lane]
    public var notes: [NoteEvent]

    public init(id: String, name: String, lengthSteps: Int, lanes: [Lane], notes: [NoteEvent]) {
        self.id = id
        self.name = name
        self.lengthSteps = lengthSteps
        self.lanes = lanes
        self.notes = notes
    }
}

public struct ArrangementBlock: Codable, Equatable, Identifiable {
    public var id: String
    public var patternId: String
    public var label: String

    public init(id: String, patternId: String, label: String) {
        self.id = id
        self.patternId = patternId
        self.label = label
    }
}

public struct ExportSettings: Codable, Equatable {
    public var mode: Mode
    public var bitDepth: Int
    public var sampleRate: Int
    public var range: Range
    public var patternRepeats: Int
    public var includeTails: Bool
    public var tailSec: Double

    public enum Mode: String, Codable, Equatable { case stereo, stems }
    public enum Range: String, Codable, Equatable { case song, pattern }

    public init(
        mode: Mode, bitDepth: Int = 24, sampleRate: Int, range: Range, patternRepeats: Int,
        includeTails: Bool, tailSec: Double
    ) {
        self.mode = mode
        self.bitDepth = bitDepth
        self.sampleRate = sampleRate
        self.range = range
        self.patternRepeats = patternRepeats
        self.includeTails = includeTails
        self.tailSec = tailSec
    }
}

public struct BeatGrid: Codable, Equatable {
    public var bpm: Double
    public var beatsPerBar: Int
    public var beats: [Double]

    public init(bpm: Double, beatsPerBar: Int, beats: [Double]) {
        self.bpm = bpm
        self.beatsPerBar = beatsPerBar
        self.beats = beats
    }
}

public struct Selection: Codable, Equatable {
    public var sourceId: String
    public var start: Double
    public var end: Double

    public init(sourceId: String, start: Double, end: Double) {
        self.sourceId = sourceId
        self.start = start
        self.end = end
    }
}

public enum Quantize: String, Codable, Equatable {
    case off
    case eighth = "1/8"
    case sixteenth = "1/16"
    case thirtySecond = "1/32"
}

public enum NoteRepeat: String, Codable, Equatable {
    case off
    case eighth = "1/8"
    case sixteenth = "1/16"
    case thirtySecond = "1/32"
}

public struct Project: Codable, Equatable {
    public var schemaVersion: Int
    public var name: String
    public var isDemo: Bool
    public var bpm: Double
    public var sources: [SourceAsset]
    public var activeSourceId: String?
    public var selection: Selection?
    public var markers: [String: [Double]]
    public var beatGrids: [String: BeatGrid]
    public var slices: [Slice]
    public var pads: [Pad]
    public var selectedPadId: String?
    public var bank: Bank
    public var quantize: Quantize
    public var swing: Double
    public var noteRepeat: NoteRepeat
    public var patterns: [Pattern]
    public var currentPatternId: String
    public var arrangement: [ArrangementBlock]
    public var export: ExportSettings

    public init(
        schemaVersion: Int, name: String, isDemo: Bool, bpm: Double, sources: [SourceAsset],
        activeSourceId: String?, selection: Selection?, markers: [String: [Double]],
        beatGrids: [String: BeatGrid], slices: [Slice], pads: [Pad], selectedPadId: String?,
        bank: Bank, quantize: Quantize, swing: Double, noteRepeat: NoteRepeat, patterns: [Pattern],
        currentPatternId: String, arrangement: [ArrangementBlock], export: ExportSettings
    ) {
        self.schemaVersion = schemaVersion
        self.name = name
        self.isDemo = isDemo
        self.bpm = bpm
        self.sources = sources
        self.activeSourceId = activeSourceId
        self.selection = selection
        self.markers = markers
        self.beatGrids = beatGrids
        self.slices = slices
        self.pads = pads
        self.selectedPadId = selectedPadId
        self.bank = bank
        self.quantize = quantize
        self.swing = swing
        self.noteRepeat = noteRepeat
        self.patterns = patterns
        self.currentPatternId = currentPatternId
        self.arrangement = arrangement
        self.export = export
    }
}

public enum ProjectError: Error, Equatable, CustomStringConvertible, LocalizedError {
    case notAProject
    case unsupportedVersion(String)

    public var description: String {
        switch self {
        case .notAProject: return "Not a Frost project"
        case .unsupportedVersion(let v): return "Unsupported project version \(v)"
        }
    }

    public var errorDescription: String? { description }
}
