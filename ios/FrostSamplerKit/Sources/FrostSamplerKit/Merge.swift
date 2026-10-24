import Foundation

/// Three-way merge. Port of `src/lib/frost/merge.ts`.
/// The phone wins only where both sides touched the same thing. View state stays the phone's.

protocol HasID: Equatable {
    var id: String { get }
}

extension SourceAsset: HasID {}
extension Slice: HasID {}
extension Pad: HasID {}
extension NoteEvent: HasID {}
extension Pattern: HasID {}
extension ArrangementBlock: HasID {}

func pick<T: Equatable>(_ base: T, _ local: T, _ remote: T) -> T {
    local == base ? remote : local
}

func pickOptional<T: Equatable>(_ base: T?, _ local: T?, _ remote: T?) -> T? {
    local == base ? remote : local
}

func mergeById<T: HasID>(_ base: [T], _ local: [T], _ remote: [T]) -> [T] {
    let b = Dictionary(base.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let l = Dictionary(local.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let r = Dictionary(remote.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var order = local.map(\.id)
    let localIds = Set(order)
    for id in remote.map(\.id) where !localIds.contains(id) { order.append(id) }
    var out: [T] = []
    for id in order {
        let value = pickOptional(b[id], l[id], r[id])
        if let value { out.append(value) }
    }
    return out
}

func mergeMap<V: Equatable>(_ base: [String: V], _ local: [String: V], _ remote: [String: V]) -> [String: V] {
    var seen = Set<String>()
    var keys: [String] = []
    func add(_ dict: [String: V]) {
        for k in dict.keys where seen.insert(k).inserted { keys.append(k) }
    }
    add(local)
    add(remote)
    add(base)
    var out: [String: V] = [:]
    for k in keys {
        if let value = pickOptional(base[k], local[k], remote[k]) { out[k] = value }
    }
    return out
}

private struct LaneItem: HasID {
    var id: String
    var mute: Bool
    var solo: Bool
}

private func mergeLanes(_ base: [Lane], _ local: [Lane], _ remote: [Lane]) -> [Lane] {
    func wrap(_ lanes: [Lane]) -> [LaneItem] {
        lanes.map { LaneItem(id: $0.padId, mute: $0.mute, solo: $0.solo) }
    }
    return mergeById(wrap(base), wrap(local), wrap(remote)).map {
        Lane(padId: $0.id, mute: $0.mute, solo: $0.solo)
    }
}

public func mergeProjects(base: Project, local: Project, remote: Project) -> Project {
    var m = base
    m.schemaVersion = pick(base.schemaVersion, local.schemaVersion, remote.schemaVersion)
    m.name = pick(base.name, local.name, remote.name)
    m.isDemo = pick(base.isDemo, local.isDemo, remote.isDemo)
    m.bpm = pick(base.bpm, local.bpm, remote.bpm)
    m.sources = mergeById(base.sources, local.sources, remote.sources)
    m.markers = mergeMap(base.markers, local.markers, remote.markers)
    m.beatGrids = mergeMap(base.beatGrids, local.beatGrids, remote.beatGrids)
    m.slices = mergeById(base.slices, local.slices, remote.slices)
    m.pads = mergeById(base.pads, local.pads, remote.pads)
    m.quantize = pick(base.quantize, local.quantize, remote.quantize)
    m.swing = pick(base.swing, local.swing, remote.swing)
    m.noteRepeat = pick(base.noteRepeat, local.noteRepeat, remote.noteRepeat)
    let mergedPatterns = mergeById(base.patterns, local.patterns, remote.patterns)
    m.patterns = mergedPatterns.map { pt in
        guard let b = base.patterns.first(where: { $0.id == pt.id }),
              let l = local.patterns.first(where: { $0.id == pt.id }),
              let r = remote.patterns.first(where: { $0.id == pt.id }) else { return pt }
        var copy = pt
        copy.notes = mergeById(b.notes, l.notes, r.notes)
        copy.lanes = mergeLanes(b.lanes, l.lanes, r.lanes)
        return copy
    }
    m.currentPatternId = local.currentPatternId
    m.arrangement = mergeById(base.arrangement, local.arrangement, remote.arrangement)
    m.export = pick(base.export, local.export, remote.export)
    m.selection = local.selection
    m.activeSourceId = local.activeSourceId
    m.selectedPadId = local.selectedPadId
    m.bank = local.bank
    if !m.patterns.contains(where: { $0.id == m.currentPatternId }) {
        m.currentPatternId = m.patterns.first?.id ?? m.currentPatternId
    }
    return m
}

public func keepView(current: Project, incoming: Project) -> Project {
    var p = incoming
    p.selection = current.selection
    p.activeSourceId = current.activeSourceId
    p.selectedPadId = current.selectedPadId
    p.bank = current.bank
    p.currentPatternId = current.currentPatternId
    if !p.patterns.contains(where: { $0.id == p.currentPatternId }) {
        p.currentPatternId = p.patterns.first?.id ?? p.currentPatternId
    }
    if let active = p.activeSourceId, !p.sources.contains(where: { $0.id == active }) {
        p.activeSourceId = p.sources.first?.id
    }
    return p
}
