import XCTest
@testable import FrostSamplerKit

final class TimingTests: XCTestCase {
    func testOnGridAtStraightSwing() {
        XCTAssertEqual(effectiveStep(step: 3, offset: 0, quantize: .sixteenth, swing: 50, lengthSteps: 16), 3)
    }

    func testQuantizeDoesNotRewriteTheNote() {
        let note = NoteEvent(id: "n", padId: "A1", step: 4, velocity: 100, offset: 0.3)
        XCTAssertEqual(effectiveStep(note, quantize: .sixteenth, swing: 50, lengthSteps: 16), 4, accuracy: 1e-9)
        XCTAssertEqual(effectiveStep(note, quantize: .off, swing: 50, lengthSteps: 16), 4.3, accuracy: 1e-9)
        XCTAssertEqual(effectiveStep(note, quantize: .eighth, swing: 50, lengthSteps: 16), 4, accuracy: 1e-9)
        XCTAssertEqual(
            effectiveStep(step: 5, offset: 0.2, quantize: .eighth, swing: 50, lengthSteps: 16), 6, accuracy: 1e-9
        )
        XCTAssertEqual(note.offset, 0.3)
    }

    func testSwingHitsOffBeatsOnly() {
        XCTAssertEqual(effectiveStep(step: 1, offset: 0, quantize: .sixteenth, swing: 66, lengthSteps: 16), 1.32, accuracy: 1e-9)
        XCTAssertEqual(effectiveStep(step: 2, offset: 0, quantize: .sixteenth, swing: 66, lengthSteps: 16), 2, accuracy: 1e-9)
        XCTAssertEqual(effectiveStep(step: 2, offset: 0, quantize: .eighth, swing: 75, lengthSteps: 16), 3, accuracy: 1e-9)
    }

    func testUnquantizedTimingSkipsSwing() {
        XCTAssertEqual(effectiveStep(step: 1, offset: 0.12, quantize: .off, swing: 70, lengthSteps: 16), 1.12, accuracy: 1e-9)
    }

    func testWrapsPastTheLoop() {
        XCTAssertEqual(effectiveStep(step: 15, offset: 0.49, quantize: .eighth, swing: 50, lengthSteps: 16), 0, accuracy: 1e-9)
    }

    func testRecordPosition() {
        let a = recordPosition(posSteps: 6.27, lengthSteps: 16)
        XCTAssertEqual(a.step, 6)
        XCTAssertEqual(a.offset, 0.27, accuracy: 1e-9)
        let b = recordPosition(posSteps: 6.8, lengthSteps: 16)
        XCTAssertEqual(b.step, 7)
        XCTAssertEqual(b.offset, -0.2, accuracy: 1e-9)
        XCTAssertEqual(recordPosition(posSteps: 15.7, lengthSteps: 16).step, 0)
    }

    func testLiveWindowsMatchExportRange() {
        let p = createDemoProject()
        let all = eventsInRange(p, sections: patternSections(p, repeats: 4), fromStep: 0, toStep: 64, loop: false)
        let pieces = [0.0, 7.3, 16.0, 33.1, 50.0, 64.0]
        var live: [ScheduledHit] = []
        for i in 0..<(pieces.count - 1) {
            live += eventsInRange(
                p, sections: patternSections(p, repeats: 1), fromStep: pieces[i], toStep: pieces[i + 1], loop: true
            )
        }
        XCTAssertEqual(live.map(\.padId), all.map(\.padId))
        for (a, b) in zip(live, all) { XCTAssertEqual(a.at, b.at, accuracy: 1e-9) }
    }

    func testMuteAndSolo() {
        var p = createDemoProject()
        p.patterns[0].lanes = p.patterns[0].lanes.map { lane in
            Lane(padId: lane.padId, mute: lane.mute, solo: lane.padId == "A2")
        }
        let hits = eventsInRange(p, sections: patternSections(p, repeats: 1), fromStep: 0, toStep: 16, loop: false)
        XCTAssertEqual(Set(hits.map(\.padId)), ["A2"])
    }

    func testSongOrder() {
        let s = songSections(createDemoProject())
        XCTAssertEqual(s.map { [$0.pattern.id, String($0.startStep)] }, [["p2", "0"], ["p1", "16"], ["p1", "32"]])
    }

    func testGateHoldsUntilTheNextHit() {
        let hits = [
            ScheduledHit(noteId: "a", padId: "A1", velocity: 100, at: 0),
            ScheduledHit(noteId: "b", padId: "A2", velocity: 100, at: 2),
            ScheduledHit(noteId: "c", padId: "A1", velocity: 100, at: 4),
        ]
        let ends = holdEnds(hits, endStep: 16)
        XCTAssertEqual(ends["a@0"], 4)
        XCTAssertEqual(ends["c@4"], 16)
        XCTAssertEqual(ends["b@2"], 16)
    }

    func testStepDurationAndTransport() {
        XCTAssertEqual(stepDur(120), 0.125, accuracy: 1e-12)
        XCTAssertEqual(transportStep(bpm: 120, elapsed: 0.5), 4, accuracy: 1e-9)
    }

    func testPlayPlan() {
        let slice = Slice(id: "s", sourceId: "x", name: "s", start: 1, end: 3)
        func pad(_ patch: (inout Pad) -> Void) -> Pad {
            var p = makePad(bank: .A, index: 0)
            patch(&p)
            return p
        }
        let classic = playPlan(pad: pad { $0.pitch = 12 }, slice: slice, bpm: 120)
        XCTAssertEqual(classic.rate, 2, accuracy: 1e-9)
        XCTAssertEqual(classic.duration, 1, accuracy: 1e-9)
        XCTAssertNil(classic.stretch)

        let bar = playPlan(
            pad: pad { $0.lengthUnit = .bars; $0.lengthValue = 1; $0.timeMode = .repitch },
            slice: slice, bpm: 120
        )
        XCTAssertEqual(bar.rate, 1, accuracy: 1e-9)
        let beats = playPlan(
            pad: pad { $0.lengthUnit = .beats; $0.lengthValue = 2; $0.timeMode = .repitch },
            slice: slice, bpm: 120
        )
        XCTAssertEqual(beats.rate, 2, accuracy: 1e-9)
        XCTAssertEqual(beats.pitchSemis, 12, accuracy: 1e-9)

        let stretch = playPlan(
            pad: pad { $0.lengthUnit = .beats; $0.lengthValue = 2; $0.timeMode = .stretch },
            slice: slice, bpm: 120
        )
        XCTAssertEqual(stretch.rate, 1, accuracy: 1e-9)
        XCTAssertEqual(stretch.stretch ?? 0, 0.5, accuracy: 1e-9)
        XCTAssertEqual(stretch.duration, 1, accuracy: 1e-9)
        let up = playPlan(
            pad: pad { $0.lengthUnit = .beats; $0.lengthValue = 2; $0.timeMode = .stretch; $0.pitch = 12 },
            slice: slice, bpm: 120
        )
        XCTAssertEqual(up.rate, 2, accuracy: 1e-9)
        XCTAssertEqual((2 * (up.stretch ?? 0)) / up.rate, 1, accuracy: 1e-9)
    }
}

final class WavTests: XCTestCase {
    func testRoundTrip24() throws {
        let l: [Float] = [0, 0.5, -0.5, 0.999, -1, 1e-7]
        let r: [Float] = [1.5, -2, 0.25, 0, 0.1, -0.1]
        let enc = encodeWav24(channels: [l, r], sampleRate: 48000)
        XCTAssertEqual(enc.clipped, 2)
        XCTAssertEqual(enc.bytes.count, 44 + 6 * 6)
        let dec = try decodeWav(enc.bytes)
        XCTAssertEqual(dec.sampleRate, 48000)
        XCTAssertEqual(dec.bitsPerSample, 24)
        for i in 0..<6 {
            XCTAssertEqual(Double(dec.channels[0][i]), Double(l[i]), accuracy: 1.5 / 8_388_608)
        }
        XCTAssertEqual(Double(dec.channels[1][0]), 8_388_607.0 / 8_388_608, accuracy: 1e-7)
        XCTAssertEqual(dec.channels[1][1], -1, accuracy: 1e-6)
    }
}

final class AnalysisTests: XCTestCase {
    let sr = 48000

    func clicks(_ times: [Double], _ dur: Double) -> [Float] {
        var x = [Float](repeating: 0, count: Int((dur * Double(sr)).rounded()))
        for t in times {
            let s = Int((t * Double(sr)).rounded())
            var i = 0
            while i < 2000 && s + i < x.count {
                x[s + i] += Float(exp(-Double(i) / 300) * sin(Double(i) * 0.9) * 0.8)
                i += 1
            }
        }
        return x
    }

    func testTransients() {
        let times = [0.25, 0.71, 1.2, 1.9]
        let found = detectOnsets(clicks(times, 2.5), sampleRate: sr, start: 0, end: 2.5, sensitivity: 0.5)
        XCTAssertEqual(found.count, times.count)
        for (f, t) in zip(found, times) {
            XCTAssertLessThanOrEqual(f, t + 0.0005)
            XCTAssertLessThan(t - f, 0.003)
        }
    }

    func testSwells() {
        var x = [Float](repeating: 0, count: 3 * sr)
        let entries = [0.3, 1.1, 1.9]
        for t in entries {
            let s = Int((t * Double(sr)).rounded())
            let len = Int((0.6 * Double(sr)).rounded())
            for i in 0..<len where s + i < x.count {
                let env = min(1, Double(i) / (0.08 * Double(sr))) * (1 - Double(i) / Double(len))
                let tone = sin((2 * Double.pi * 440 * Double(i)) / Double(sr)) + 0.3 * sin((2 * Double.pi * 1320 * Double(i)) / Double(sr))
                x[s + i] += Float(0.5 * env * tone)
            }
        }
        let found = detectOnsets(x, sampleRate: sr, start: 0, end: 3, sensitivity: 0.5)
        XCTAssertEqual(found.count, entries.count)
        for (f, t) in zip(found, entries) {
            XCTAssertGreaterThanOrEqual(f, t - 0.005)
            XCTAssertLessThan(f - t, 0.09)
        }
    }

    func testClippedSubDoesNotMarkEveryCycle() {
        var x = [Float](repeating: 0, count: 2 * sr)
        let s0 = Int((0.3 * Double(sr)).rounded())
        var i = 0
        while s0 + i < x.count && i < sr {
            let v = sin((2 * Double.pi * 37 * Double(i)) / Double(sr)) * 4 * exp(-Double(i) / (0.5 * Double(sr)))
            x[s0 + i] = Float(max(-0.9, min(0.9, v)))
            i += 1
        }
        let found = detectOnsets(x, sampleRate: sr, start: 0, end: 2, sensitivity: 0.8)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0], 0.3, accuracy: 0.01)
    }

    func testDecayIsOneMarker() {
        let found = detectOnsets(clicks([0.5], 1.5), sampleRate: sr, start: 0, end: 1.5, sensitivity: 0.9)
        XCTAssertEqual(found.count, 1)
    }

    func testFirstAudible() {
        var x = [Float](repeating: 0, count: sr)
        XCTAssertEqual(firstAudible(x, sampleRate: sr), 0)
        let onset = Int((0.4 * Double(sr)).rounded())
        for i in onset..<x.count { x[i] = Float(0.3 * sin(Double(i) * 0.05)) }
        XCTAssertEqual(firstAudible(x, sampleRate: sr), 0.4, accuracy: 0.005)
        for i in 0..<onset { x[i] = 0.001 }
        XCTAssertEqual(firstAudible(x, sampleRate: sr), 0.4, accuracy: 0.005)
    }

    func testSuggestTempo() {
        let bpm = 96.0
        let times = (0..<48).map { 0.1 + (Double($0) * 60) / bpm }
        let s = suggestTempo(clicks(times, 32), sampleRate: sr)
        XCTAssertNotNil(s)
        XCTAssertEqual(s?.bpm ?? 0, bpm, accuracy: 1.5)
    }

    func testBeatGrid() {
        let g = generateBeatGrid(bpm: 120, firstBeat: 0.1, duration: 2.2)
        XCTAssertEqual(g.beats, [0.1, 0.6, 1.1, 1.6, 2.1])
        let moved = moveBeat(g, index: 2, t: 5)
        XCTAssertEqual(moved.beats[2], 1.599, accuracy: 1e-9)
        XCTAssertEqual(g.beats[2], 1.1)
    }

    func testBoundaries() {
        XCTAssertEqual(boundaries(cuts: [0.5, 0.2, 3, 0.505], start: 0, end: 1), [0, 0.2, 0.5, 1])
    }

    func testWaveColumnsKeepZeroAsTheFloor() {
        let columns = waveColumns(channels: [[Float](repeating: 0.5, count: 100)], sampleRate: 10, t0: 0, t1: 10, columns: 2)
        XCTAssertEqual(columns[0], 0)
        XCTAssertEqual(columns[1], 0.5, accuracy: 1e-6)
    }
}

final class StretchTests: XCTestCase {
    func testLengthAndPitch() {
        let sr = 48000
        let x = (0..<sr).map { i in Float(sin((2 * Double.pi * 440 * Double(i)) / Double(sr)) * 0.5) }
        for ratio in [0.5, 0.8, 1.25, 2.0] {
            let y = wsola(channels: [x], ratio: ratio)[0]
            XCTAssertEqual(y.count, stretchLength(inputFrames: sr, ratio: ratio))
            let a = Int(Double(y.count) * 0.2)
            let b = Int(Double(y.count) * 0.8)
            var zc = 0
            if b > a + 1 {
                for i in (a + 1)..<b where (y[i - 1] < 0) != (y[i] < 0) { zc += 1 }
            }
            let hz = Double(zc) / 2 / (Double(b - a) / Double(sr))
            XCTAssertEqual(hz, 440, accuracy: 15)
        }
    }

    func testOpeningTransientIsCopied() {
        let x = (0..<20000).map { i in i < 100 ? Float(0.9) : Float(0.01 * sin(Double(i))) }
        let y = wsola(channels: [x], ratio: 1.5)[0]
        for i in 0..<100 { XCTAssertEqual(y[i], 0.9, accuracy: 1e-5) }
    }
}
