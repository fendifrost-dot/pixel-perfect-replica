import Foundation

/// Name cleanup and schema migration. Port of the pure parts of `src/lib/frost/persist.ts`.
/// IndexedDB stays on the web app. The phone copy here will be files, in a later milestone.

public func cleanName(_ name: String) -> String {
    var n = name
    for _ in 0..<2 {
        guard n.range(of: "%[0-9A-Fa-f]{2}", options: .regularExpression) != nil else { break }
        guard let decoded = n.removingPercentEncoding, decoded != n else { break }
        n = decoded
    }
    return n.trimmingCharacters(in: .whitespacesAndNewlines)
}

public func migrateProject(data: Data) throws -> Project {
    let json = try JSONSerialization.jsonObject(with: data)
    guard var obj = json as? [String: Any] else { throw ProjectError.notAProject }
    let version: String
    if let n = obj["schemaVersion"] as? Int {
        version = String(n)
    } else if let n = obj["schemaVersion"] as? NSNumber {
        version = n.stringValue
    } else if obj["schemaVersion"] == nil {
        throw ProjectError.unsupportedVersion("nil")
    } else {
        version = String(describing: obj["schemaVersion"]!)
    }
    if version != "1" && version != String(schemaVersion) {
        throw ProjectError.unsupportedVersion(version)
    }
    obj["schemaVersion"] = schemaVersion
    if obj["beatGrids"] == nil { obj["beatGrids"] = [String: Any]() }
    if var export = obj["export"] as? [String: Any] {
        if export["patternRepeats"] == nil { export["patternRepeats"] = 4 }
        obj["export"] = export
    }
    if let name = obj["name"] as? String { obj["name"] = cleanName(name) }
    if var sources = obj["sources"] as? [[String: Any]] {
        for i in sources.indices {
            if let name = sources[i]["name"] as? String { sources[i]["name"] = cleanName(name) }
        }
        obj["sources"] = sources
    }
    let normalized = try JSONSerialization.data(withJSONObject: obj)
    let decoder = JSONDecoder()
    return try decoder.decode(Project.self, from: normalized)
}
