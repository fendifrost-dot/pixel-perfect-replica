import XCTest
@testable import FrostSamplerKit

final class ProjectTests: XCTestCase {
    func base() throws -> Project {
        var p = try newProject(name: "Beat", bpm: 90)
        p = addSource(p, asset: SourceAsset(
            id: "src_a", name: "a.wav", durationSec: 10, sampleRate: 48000, channels: 2,
            origin: .imported, persistence: .device, detectedBpm: nil
        ))
        p = try setChopMarkers(p, sourceId: "src_a", times: [1, 2, 3])
        p.isDemo = false
        return p
    }

    func testMergeKeepsBothSides() throws {
        let b = try base()
        let local = try setChopMarkers(b, sourceId: "src_a", times: [])
        let remote = try addHits(try setProjectFields(b, ProjectFields(bpm: 120)), hits: [HitInput(pad: "A1", step: 0)])
        let m = mergeProjects(base: b, local: local, remote: remote)
        XCTAssertEqual(m.markers["src_a"] ?? [], [])
        XCTAssertEqual(m.bpm, 120)
        XCTAssertEqual(m.patterns[0].notes.count, 1)
    }

    func testMergeItemByItem() throws {
        let b = try addHits(try base(), hits: [HitInput(pad: "A1", step: 0)])
        let local = try addHits(b, hits: [HitInput(pad: "A2", step: 4)])
        let remote = try setPad(try addHits(b, hits: [HitInput(pad: "A3", step: 8)]), padId: "A5", PadPatch(volume: 0.3))
        let m = mergeProjects(base: b, local: local, remote: remote)
        XCTAssertEqual(m.patterns[0].notes.map(\.padId).sorted(), ["A1", "A2", "A3"])
        XCTAssertEqual(m.pads.first { $0.id == "A5" }?.volume ?? 0, 0.3)
    }

    func testPhoneWinsCollisions() throws {
        let b = try base()
        let m = try mergeProjects(
            base: b,
            local: setProjectFields(b, ProjectFields(bpm: 100)),
            remote: setProjectFields(b, ProjectFields(bpm: 140))
        )
        XCTAssertEqual(m.bpm, 100)
    }

    func testDeletionsFromEitherSide() throws {
        let b = try addHits(try base(), hits: [HitInput(pad: "A1", step: 0), HitInput(pad: "A2", step: 4)])
        let local = try removeHits(b, pad: "A1")
        let remote = try removeHits(b, pad: "A2")
        XCTAssertEqual(mergeProjects(base: b, local: local, remote: remote).patterns[0].notes.count, 0)
    }

    func testViewStaysOnThePhone() throws {
        let b = try base()
        var local = b
        local.selection = Selection(sourceId: "src_a", start: 1, end: 2)
        local.selectedPadId = "B3"
        local.bank = .B
        var remote = try setProjectFields(b, ProjectFields(bpm: 101))
        remote.selection = nil
        remote.selectedPadId = "A1"
        let m = mergeProjects(base: b, local: local, remote: remote)
        XCTAssertEqual(m.selection?.start, 1)
        XCTAssertEqual(m.selection?.end, 2)
        XCTAssertEqual(m.selectedPadId, "B3")
        XCTAssertEqual(m.bank, .B)
        XCTAssertEqual(m.bpm, 101)
        let kept = keepView(current: local, incoming: remote)
        XCTAssertEqual(kept.selection?.start, 1)
        XCTAssertEqual(kept.selectedPadId, "B3")
        XCTAssertEqual(kept.bpm, 101)
    }

    func testCleanNameAndMigration() throws {
        XCTAssertEqual(cleanName("Vivaldi%20Gelido%20in%20ogni%20vena%20(Winter)"), "Vivaldi Gelido in ogni vena (Winter)")
        XCTAssertEqual(cleanName("Track%2520One"), "Track One")
        XCTAssertEqual(cleanName("100% real"), "100% real")

        var p = try base()
        p.name = "My%20Beat"
        p.sources[0].name = "a%20b.mp3"
        let data = try JSONEncoder().encode(p)
        var obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        obj["schemaVersion"] = 1
        obj.removeValue(forKey: "beatGrids")
        let migrated = try migrateProject(data: JSONSerialization.data(withJSONObject: obj))
        XCTAssertEqual(migrated.schemaVersion, 2)
        XCTAssertEqual(migrated.beatGrids.count, 0)
        XCTAssertEqual(migrated.name, "My Beat")
        XCTAssertEqual(migrated.sources[0].name, "a b.mp3")

        XCTAssertThrowsError(try migrateProject(data: Data("{\"schemaVersion\":99}".utf8)))
    }

    func testJsonRoundTripKeepsSchema() throws {
        let data = try JSONEncoder().encode(createEmptyProject(name: "Round"))
        let back = try migrateProject(data: data)
        XCTAssertEqual(back.schemaVersion, schemaVersion)
        XCTAssertEqual(back.pads.count, 64)
        XCTAssertEqual(back.bpm, 90)
        XCTAssertEqual(back.export.bitDepth, 24)
    }
}

final class ImportChopRenderTests: XCTestCase {
    func testImportDoesNotApplyDetectedTempo() throws {
        let sr = 48000
        let bpm = 96.0
        var clicks = [Float](repeating: 0, count: Int(16 * Double(sr)))
        for i in 0..<24 {
            let t = 0.1 + Double(i) * 60 / bpm
            let s = Int((t * Double(sr)).rounded())
            var k = 0
            while k < 2000 && s + k < clicks.count {
                clicks[s + k] += Float(exp(-Double(k) / 300) * sin(Double(k) * 0.9) * 0.8)
                k += 1
            }
        }
        let wav = encodeWav24(channels: [clicks, clicks], sampleRate: sr)
        let song = try importWAV(name: "loop%20one.wav", id: "src_loop", data: wav.bytes)
        XCTAssertEqual(song.asset.name, "loop one.wav")
        XCTAssertEqual(song.asset.detectedBpm ?? 0, bpm, accuracy: 1.5)
        var project = createEmptyProject()
        let bpmBefore = project.bpm
        var library = AudioLibrary()
        project = store(song, in: &library, project: project)
        XCTAssertEqual(project.bpm, bpmBefore)
        XCTAssertEqual(project.activeSourceId, "src_loop")
        XCTAssertNotNil(library.buffers["src_loop"])
    }

    func testAutoChopAssignsPads() throws {
        let sr = 48000
        let times = [0.25, 0.71, 1.2, 1.9]
        var samples = [Float](repeating: 0, count: Int(2.5 * Double(sr)))
        for t in times {
            let s = Int((t * Double(sr)).rounded())
            var i = 0
            while i < 2000 && s + i < samples.count {
                samples[s + i] += Float(exp(-Double(i) / 300) * sin(Double(i) * 0.9) * 0.8)
                i += 1
            }
        }
        let wav = encodeWav24(channels: [samples], sampleRate: sr)
        let song = try importWAV(name: "hits.wav", id: "src_hits", data: wav.bytes)
        var library = AudioLibrary()
        var project = store(song, in: &library, project: createEmptyProject())
        let chopped = try autoChop(
            project, sourceId: "src_hits", samples: song.pcm.mono(), sampleRate: sr, start: 0, end: song.asset.durationSec, sensitivity: 0.5
        )
        project = chopped.project
        XCTAssertGreaterThanOrEqual(chopped.assigned.count, 4)
        XCTAssertNotNil(project.pads.first { $0.id == "A1" }?.sliceId)
        XCTAssertNotEqual(project.pads.first { $0.id == "A1" }?.sliceId, project.pads.first { $0.id == "A2" }?.sliceId)
    }

    func testExportTimingAndStemSum() throws {
        for sampleRate in [48000, 44100] {
            for quantize in [Quantize.sixteenth, Quantize.off] {
                try assertExport(sampleRate: sampleRate, quantize: quantize)
            }
        }
    }

    func testEngineRefusesAPadWithoutAudio() throws {
        let engine = SoftwarePadEngine()
        let pad = makePad(bank: .A, index: 0)
        XCTAssertFalse(engine.triggerPad(pad, slice: nil, velocity: 100, bpm: 90, when: nil))
        let slice = Slice(id: "s", sourceId: "missing", name: "x", start: 0, end: 0.1)
        XCTAssertFalse(engine.triggerPad(pad, slice: slice, velocity: 90, bpm: 100, when: nil))
        engine.library.buffers["missing"] = PCMBuffer(sampleRate: 48000, channels: [[0.2, 0.2]])
        XCTAssertTrue(engine.triggerPad(pad, slice: slice, velocity: 90, bpm: 100, when: 0))
        XCTAssertEqual(engine.triggers.count, 1)
        XCTAssertEqual(engine.triggers[0].velocity, 90)
    }

    func testCloudRequestStaysLocal() throws {
        let builder = CloudRequestBuilder(endpoint: URL(string: "https://example.test/api/cloud")!)
        XCTAssertThrowsError(try builder.makeRequest(action: .ping, key: ""))
        let request = try builder.makeRequest(action: .ping, key: "example-key-not-a-secret")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.path, "/api/cloud")
        XCTAssertEqual(request.headers["x-frost-key"], "example-key-not-a-secret")
        XCTAssertNil(request.url.query)
        let body = try JSONSerialization.jsonObject(with: request.body) as? [String: String]
        XCTAssertEqual(body?["action"], "ping")
        let put = try builder.makeRequest(
            action: .put(key: "proj", project: createEmptyProject(name: "N"), baseUpdatedAt: nil),
            key: "example-key-not-a-secret"
        )
        let putBody = try JSONSerialization.jsonObject(with: put.body) as? [String: Any]
        XCTAssertEqual(putBody?["action"] as? String, "put")
        XCTAssertTrue(putBody?["baseUpdatedAt"] is NSNull)
    }

    private func assertExport(sampleRate: Int, quantize: Quantize) throws {
        let lead = 0.005
        let clicks = [0.1, 0.6, 1.1]
        var pcm = [Float](repeating: 0, count: sampleRate * 2)
        for t in clicks {
            let s = Int((t * Double(sampleRate)).rounded())
            if s < pcm.count { pcm[s] = 0.9 }
        }
        let slices = clicks.enumerated().map { i, t in
            Slice(id: "ts\(i)", sourceId: "clicks", name: "Click \(i + 1)", start: t - lead, end: t + 0.2 + Double(i) * 0.1)
        }
        func pad(_ index: Int, _ patch: (inout Pad) -> Void) -> Pad {
            var p = makePad(bank: .A, index: index)
            p.sliceId = slices[min(index, 2)].id
            p.release = 0.004
            patch(&p)
            return p
        }
        let pads = [
            pad(0) { _ in },
            pad(1) { $0.lengthUnit = .beats; $0.lengthValue = 0.5; $0.timeMode = .repitch },
            pad(2) { $0.lengthUnit = .beats; $0.lengthValue = 0.625; $0.timeMode = .stretch },
        ]
        let project = Project(
            schemaVersion: schemaVersion,
            name: "Self test",
            isDemo: false,
            bpm: 93.7,
            sources: [SourceAsset(
                id: "clicks", name: "clicks", durationSec: 2, sampleRate: sampleRate, channels: 2,
                origin: .imported, persistence: .sessionOnly, detectedBpm: nil
            )],
            activeSourceId: "clicks",
            selection: nil,
            markers: [:],
            beatGrids: [:],
            slices: slices,
            pads: pads,
            selectedPadId: nil,
            bank: .A,
            quantize: quantize,
            swing: 62,
            noteRepeat: .off,
            patterns: [Pattern(
                id: "tp", name: "Test", lengthSteps: 16, lanes: [],
                notes: [
                    NoteEvent(id: "n1", padId: "A1", step: 0, velocity: 127, offset: 0),
                    NoteEvent(id: "n2", padId: "A1", step: 6, velocity: 127, offset: 0),
                    NoteEvent(id: "n3", padId: "A2", step: 1, velocity: 127, offset: 0),
                    NoteEvent(id: "n4", padId: "A2", step: 9, velocity: 127, offset: 0.23),
                    NoteEvent(id: "n5", padId: "A3", step: 4, velocity: 127, offset: -0.18),
                    NoteEvent(id: "n6", padId: "A3", step: 12, velocity: 127, offset: 0),
                ]
            )],
            currentPatternId: "tp",
            arrangement: [],
            export: ExportSettings(
                mode: .stems, bitDepth: 24, sampleRate: sampleRate, range: .pattern,
                patternRepeats: 2, includeTails: true, tailSec: 0.5
            )
        )
        let library = AudioLibrary(buffers: ["clicks": PCMBuffer(sampleRate: sampleRate, channels: [pcm, pcm])])
        let rendered = try renderProject(project, library: library)
        let planned = planHits(project, sections: exportSections(project))
        let expectedFrames = jsRound((planned.musicSec + project.export.tailSec) * Double(sampleRate))
        XCTAssertEqual(rendered.files.count, 4, quantize.rawValue)
        XCTAssertEqual(rendered.frames, expectedFrames)
        let decoded = try rendered.files.map { try decodeWav($0.bytes) }
        for wav in decoded {
            XCTAssertEqual(wav.bitsPerSample, 24)
            XCTAssertEqual(wav.sampleRate, sampleRate)
            XCTAssertEqual(wav.channels[0].count, expectedFrames)
        }
        let mix = decoded[0].channels[0]
        var worst = 0.0
        for hit in planned.hits {
            let pad = pads.first { $0.id == hit.padId }!
            let slice = slices.first { $0.id == pad.sliceId }!
            let plan = playPlan(pad: pad, slice: slice, bpm: project.bpm)
            let leadSec = plan.stretch != nil ? lead : lead / plan.rate
            let expected = (hit.time + leadSec) * Double(sampleRate)
            let got = onsetNear(mix, center: Int(expected.rounded()), radius: Int((0.008 * Double(sampleRate)).rounded()))
            let err = abs(Double(got) - expected)
            worst = max(worst, err)
            XCTAssertLessThanOrEqual(err, 1.5, "\(hit.padId) @ \(hit.at) off by \(err) (\(quantize.rawValue))")
        }
        XCTAssertLessThanOrEqual(worst, 1.5)
        var maxDiff = 0.0
        let stems = decoded.dropFirst().map(\.channels)
        for c in 0..<2 {
            for i in 0..<expectedFrames {
                var s = 0.0
                for stem in stems { s += Double(stem[c][i]) }
                maxDiff = max(maxDiff, abs(s - Double(decoded[0].channels[c][i])))
            }
        }
        XCTAssertLessThan(maxDiff, 1e-4, "stems differ from mix by \(maxDiff)")
    }

    private func onsetNear(_ x: [Float], center: Int, radius: Int) -> Int {
        let a = max(0, center - radius)
        let b = min(x.count, center + radius)
        var peak: Float = 0
        if a < b { for i in a..<b { peak = max(peak, abs(x[i])) } }
        if a < b {
            for i in a..<b where abs(x[i]) >= peak * 0.5 { return i }
        }
        return center
    }
}
