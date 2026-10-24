import SwiftUI
import UniformTypeIdentifiers
import FrostSamplerKit

/// On-device shell. Audio goes through `PadPlaying` (`AVAudioPadEngine`).
/// There is no account, subscription, or hosted model on this screen.
@MainActor
final class SamplerSession: ObservableObject {
    @Published var project: Project
    @Published var status: String
    @Published var waveform: [Float] = []
    @Published var exportURLs: [URL] = []
    @Published var sensitivity: Double = 0.5

    let engine = AVAudioPadEngine()
    var library = AudioLibrary()

    init() {
        project = createEmptyProject(name: "Untitled beat")
        status = "Offline. Import a song from Files. Pads stay silent until a chop is on them."
    }

    var activePCM: PCMBuffer? {
        guard let id = project.activeSourceId else { return nil }
        return library.buffers[id]
    }

    var suggestion: Double? {
        guard let id = project.activeSourceId else { return nil }
        return project.sources.first { $0.id == id }?.detectedBpm
    }

    func importFile(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let id = "src_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
            let song = try importSong(name: url.lastPathComponent, id: id, data: data, url: url)
            project = store(song, in: &library, project: project)
            engine.library = library
            refreshWave()
            if let bpm = song.asset.detectedBpm {
                status = "Imported \(song.asset.name). Suggested tempo \(bpm) BPM is not applied."
            } else {
                status = "Imported \(song.asset.name). No tempo suggestion."
            }
        } catch {
            status = error.localizedDescription
        }
    }

    func useSuggestion() {
        guard let bpm = suggestion else { return }
        do {
            project = try setProjectFields(project, ProjectFields(bpm: bpm))
            status = "Project tempo is \(project.bpm) BPM."
        } catch {
            status = error.localizedDescription
        }
    }

    func setTempo(_ bpm: Double) {
        project = (try? setProjectFields(project, ProjectFields(bpm: bpm))) ?? project
    }

    func chop() {
        guard let id = project.activeSourceId, let pcm = library.buffers[id] else {
            status = "Import a song before chopping."
            return
        }
        let asset = project.sources.first { $0.id == id }
        let end = asset?.durationSec ?? pcm.duration
        do {
            let result = try autoChop(
                project, sourceId: id, samples: pcm.mono(), sampleRate: pcm.sampleRate,
                start: 0, end: end, sensitivity: sensitivity, bank: project.bank
            )
            project = result.project
            status = "\(result.assigned.count) chops on bank \(project.bank.rawValue), from \(project.bank.rawValue)1."
        } catch {
            status = error.localizedDescription
        }
    }

    func trigger(_ pad: Pad) {
        let slice = project.slices.first { $0.id == pad.sliceId }
        let ok = engine.triggerPad(pad, slice: slice, velocity: pad.velocity, bpm: project.bpm, when: nil)
        if !ok { status = "\(pad.id) has no audio." }
    }

    func release(_ pad: Pad) {
        engine.releasePad(pad.id)
    }

    func playPattern() {
        var draft = project
        draft.export.range = .pattern
        draft.export.patternRepeats = 1
        draft.export.mode = .stereo
        draft.export.includeTails = true
        draft.export.tailSec = min(project.export.tailSec, 2)
        do {
            let rendered = try renderProject(draft, library: library)
            try engine.playBuffer(rendered.mix)
            status = "Playing the pattern at \(project.bpm) BPM."
        } catch {
            status = error.localizedDescription
        }
    }

    func stop() {
        engine.stopAll()
        status = "Stopped."
    }

    func export() {
        do {
            let rendered = try renderProject(project, library: library)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("frost-export-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var urls: [URL] = []
            for file in rendered.files {
                let url = dir.appendingPathComponent(file.name)
                try file.bytes.write(to: url)
                urls.append(url)
            }
            exportURLs = urls
            status = "\(urls.count) WAV file\(urls.count == 1 ? "" : "s"), \(rendered.frames) frames at \(rendered.sampleRate) Hz. Share them into Files or a DAW."
        } catch {
            status = error.localizedDescription
        }
    }

    func setMode(_ mode: ExportSettings.Mode) {
        project = (try? setExport(project, mode: mode)) ?? project
    }

    func setRate(_ rate: Int) {
        project = (try? setExport(project, sampleRate: rate)) ?? project
    }

    private func refreshWave() {
        guard let pcm = activePCM, pcm.duration > 0 else {
            waveform = []
            return
        }
        waveform = waveColumns(
            channels: pcm.channels, sampleRate: pcm.sampleRate, t0: 0, t1: pcm.duration, columns: 240
        )
    }
}

struct ContentView: View {
    @EnvironmentObject private var session: SamplerSession
    @State private var importing = false

    private let padOrder = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(session.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    tempo
                    waveform
                    chopControls
                    pads
                    transport
                    exportControls
                    unavailable
                }
                .padding()
            }
            .navigationTitle(session.project.name)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Import") { importing = true }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.audio], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first {
                    session.importFile(url)
                } else if case .failure(let error) = result {
                    session.status = error.localizedDescription
                }
            }
        }
    }

    private var tempo: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Tempo")
                    .font(.headline)
                Spacer()
                Text(String(format: "%.1f BPM", session.project.bpm))
                    .monospacedDigit()
            }
            Slider(value: Binding(
                get: { session.project.bpm },
                set: { session.setTempo($0) }
            ), in: 40...300, step: 0.1)
            if let suggestion = session.suggestion {
                Button("Use suggested \(String(format: "%.1f", suggestion)) BPM") {
                    session.useSuggestion()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var waveform: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Waveform")
                .font(.headline)
            if session.waveform.isEmpty {
                Text("No recording yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            } else {
                WaveformView(columns: session.waveform, slices: activeSlices, duration: session.activePCM?.duration ?? 0)
                    .frame(height: 88)
            }
        }
    }

    private var activeSlices: [Slice] {
        guard let id = session.project.activeSourceId else { return [] }
        return session.project.slices.filter { $0.sourceId == id }
    }

    private var chopControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Chop")
                .font(.headline)
            HStack {
                Text("Sensitivity")
                Slider(value: $session.sensitivity, in: 0...1)
                Text(String(format: "%.2f", session.sensitivity))
                    .monospacedDigit()
                    .frame(width: 44, alignment: .trailing)
            }
            Button("Chop onto bank \(session.project.bank.rawValue)") { session.chop() }
                .buttonStyle(.borderedProminent)
        }
    }

    private var pads: some View {
        let bankPads = session.project.pads.filter { $0.bank == session.project.bank }
        return VStack(alignment: .leading, spacing: 8) {
            Picker("Bank", selection: Binding(
                get: { session.project.bank },
                set: { bank in session.project = (try? setProjectFields(session.project, ProjectFields(bank: bank))) ?? session.project }
            )) {
                ForEach(Bank.allCases, id: \.self) { bank in
                    Text(bank.rawValue).tag(bank)
                }
            }
            .pickerStyle(.segmented)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(padOrder, id: \.self) { index in
                    if bankPads.indices.contains(index) {
                        PadButton(pad: bankPads[index], slice: slice(for: bankPads[index]))
                    }
                }
            }
        }
    }

    private func slice(for pad: Pad) -> Slice? {
        session.project.slices.first { $0.id == pad.sliceId }
    }

    private var transport: some View {
        HStack {
            Button("Play pattern") { session.playPattern() }
                .buttonStyle(.borderedProminent)
            Button("Stop") { session.stop() }
                .buttonStyle(.bordered)
        }
    }

    private var exportControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Export")
                .font(.headline)
            Picker("Files", selection: Binding(
                get: { session.project.export.mode },
                set: { session.setMode($0) }
            )) {
                Text("Mix").tag(ExportSettings.Mode.stereo)
                Text("Mix + stems").tag(ExportSettings.Mode.stems)
            }
            .pickerStyle(.segmented)
            Picker("Rate", selection: Binding(
                get: { session.project.export.sampleRate },
                set: { session.setRate($0) }
            )) {
                Text("44.1 kHz").tag(44100)
                Text("48 kHz").tag(48000)
            }
            .pickerStyle(.segmented)
            Button("Render 24-bit WAV") { session.export() }
                .buttonStyle(.bordered)
            if !session.exportURLs.isEmpty {
                ShareLink(items: session.exportURLs) {
                    Label("Share WAV files", systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Not in this build")
                .font(.headline)
            Text("Instrument isolation is off the pad path. Built-in drum synthesis is not ported yet, so empty pads do not invent a sound. Cloud sync is not connected: the existing server still owns projects, and this app does not store a key.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct PadButton: View {
    @EnvironmentObject private var session: SamplerSession
    let pad: Pad
    let slice: Slice?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(pad.id)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            Text(slice?.name ?? "Empty")
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
        .background(slice == nil ? Color.white.opacity(0.04) : color.opacity(0.35))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(slice == nil ? 0.25 : 0.9), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .onLongPressGesture(minimumDuration: 0, maximumDistance: .infinity, pressing: { pressing in
            if pressing { session.trigger(pad) } else { session.release(pad) }
        }, perform: {})
    }

    private var color: Color {
        switch pad.color {
        case .teal: return Color(red: 0.2, green: 0.78, blue: 0.72)
        case .purple: return Color(red: 0.62, green: 0.45, blue: 0.95)
        case .amber: return Color(red: 0.95, green: 0.68, blue: 0.25)
        }
    }
}

private struct WaveformView: View {
    let columns: [Float]
    let slices: [Slice]
    let duration: Double

    var body: some View {
        Canvas { context, size in
            let count = columns.count / 2
            guard count > 0 else { return }
            var path = Path()
            let mid = size.height / 2
            for c in 0..<count {
                let minV = CGFloat(columns[c * 2])
                let maxV = CGFloat(columns[c * 2 + 1])
                let x = size.width * CGFloat(c) / CGFloat(count)
                let y0 = mid - maxV * mid
                let y1 = mid - minV * mid
                path.move(to: CGPoint(x: x, y: y0))
                path.addLine(to: CGPoint(x: x, y: max(y0 + 1, y1)))
            }
            context.stroke(path, with: .color(.white.opacity(0.85)), lineWidth: 1)
            guard duration > 0 else { return }
            for slice in slices {
                let x = size.width * CGFloat(slice.start / duration)
                var mark = Path()
                mark.move(to: CGPoint(x: x, y: 0))
                mark.addLine(to: CGPoint(x: x, y: size.height))
                context.stroke(mark, with: .color(Color(red: 0.2, green: 0.78, blue: 0.72).opacity(0.7)), lineWidth: 1)
            }
        }
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
