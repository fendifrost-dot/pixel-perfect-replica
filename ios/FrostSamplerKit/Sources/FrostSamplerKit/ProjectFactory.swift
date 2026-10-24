import Foundation

public let banks: [Bank] = [.A, .B, .C, .D]
public let demoSourceId = "demo_source"

public func makePad(bank: Bank, index: Int) -> Pad {
    let colors: [PadColor] = [.teal, .purple]
    return Pad(
        id: "\(bank.rawValue)\(index + 1)",
        bank: bank,
        index: index,
        sliceId: nil,
        color: colors[(index / 4) % 2],
        volume: 0.8,
        pan: 0,
        pitch: 0,
        reverse: false,
        mode: .oneshot,
        choke: nil,
        attack: 0.002,
        release: 0.05,
        timeMode: .repitch,
        lengthUnit: .off,
        lengthValue: 1,
        velocity: 100
    )
}

public func makePads() -> [Pad] {
    banks.flatMap { bank in (0..<16).map { makePad(bank: bank, index: $0) } }
}

public func createEmptyProject(name: String = "Untitled beat") -> Project {
    Project(
        schemaVersion: schemaVersion,
        name: name,
        isDemo: false,
        bpm: 90,
        sources: [],
        activeSourceId: nil,
        selection: nil,
        markers: [:],
        beatGrids: [:],
        slices: [],
        pads: makePads(),
        selectedPadId: "A1",
        bank: .A,
        quantize: .sixteenth,
        swing: 50,
        noteRepeat: .off,
        patterns: [Pattern(id: "p1", name: "Pattern 1", lengthSteps: 32, lanes: [], notes: [])],
        currentPatternId: "p1",
        arrangement: [],
        export: ExportSettings(
            mode: .stems, bitDepth: 24, sampleRate: 48000, range: .pattern,
            patternRepeats: 4, includeTails: true, tailSec: 2
        )
    )
}

/// Illustrative project used by the scheduling tests. It has no audio.
public func createDemoProject() -> Project {
    var pads = makePads()
    let slices = [
        Slice(id: "sl1", sourceId: demoSourceId, name: "Kick chop", start: 0.0, end: 0.42),
        Slice(id: "sl2", sourceId: demoSourceId, name: "Snare hit", start: 0.95, end: 1.3),
        Slice(id: "sl3", sourceId: demoSourceId, name: "Hat", start: 2.1, end: 2.25),
        Slice(id: "sl4", sourceId: demoSourceId, name: "Keys stab", start: 4.0, end: 5.2),
        Slice(id: "sl5", sourceId: demoSourceId, name: "Vox phrase", start: 8.0, end: 10.4),
    ]
    for (i, slice) in slices.enumerated() { pads[i].sliceId = slice.id }
    func n(_ padId: String, _ step: Int, _ velocity: Int = 100) -> NoteEvent {
        NoteEvent(id: "\(padId)-\(step)", padId: padId, step: step, velocity: velocity, offset: 0)
    }
    let lanes = ["A1", "A2", "A3", "A4", "A5"].map { Lane(padId: $0, mute: false, solo: false) }
    let hats = [0, 2, 4, 6, 8, 10, 12, 14].map { n("A3", $0, $0 % 4 == 0 ? 95 : 70) }
    return Project(
        schemaVersion: schemaVersion,
        name: "Demo — Night Drive",
        isDemo: true,
        bpm: 90,
        sources: [
            SourceAsset(
                id: demoSourceId, name: "Demo source (no audio)", durationSec: 32, sampleRate: 48000,
                channels: 2, origin: .demo, persistence: .demo, detectedBpm: nil
            ),
        ],
        activeSourceId: demoSourceId,
        selection: Selection(sourceId: demoSourceId, start: 4.0, end: 5.2),
        markers: [demoSourceId: [0.95, 2.1, 4.0, 8.0]],
        beatGrids: [:],
        slices: slices,
        pads: pads,
        selectedPadId: "A1",
        bank: .A,
        quantize: .sixteenth,
        swing: 54,
        noteRepeat: .off,
        patterns: [
            Pattern(
                id: "p1", name: "Pattern 1", lengthSteps: 16, lanes: lanes,
                notes: [
                    n("A1", 0, 120), n("A1", 7, 90), n("A1", 10, 110),
                    n("A2", 4), n("A2", 12),
                ] + hats + [n("A4", 0, 90), n("A5", 8, 85)]
            ),
            Pattern(
                id: "p2", name: "Pattern 2", lengthSteps: 16, lanes: lanes,
                notes: [n("A1", 0), n("A2", 4), n("A1", 8), n("A2", 12)]
            ),
        ],
        currentPatternId: "p1",
        arrangement: [
            ArrangementBlock(id: "b1", patternId: "p2", label: "Intro"),
            ArrangementBlock(id: "b2", patternId: "p1", label: "Verse"),
            ArrangementBlock(id: "b3", patternId: "p1", label: "Hook"),
        ],
        export: ExportSettings(
            mode: .stereo, bitDepth: 24, sampleRate: 48000, range: .song,
            patternRepeats: 4, includeTails: true, tailSec: 2
        )
    )
}
