import Foundation

/// Shape of `POST /api/cloud` from `src/lib/frost/cloud.ts` and `src/lib/cloud/api.server.ts`.
/// Builds requests only. This type does not open a connection, so a test cannot write production.
/// The owner types `FROST_MCP_KEY` later; it is not compiled into the app.
/// The phone sends the key in `x-frost-key`, matching the web client. Query-string keys stay a
/// connector concern and are not used here.

public enum CloudClientError: Error, Equatable, CustomStringConvertible {
    case syncOff

    public var description: String { "Cloud sync is off." }
}

public enum CloudAction: Equatable {
    case ping
    case list
    case get(key: String)
    case put(key: String, project: Project, baseUpdatedAt: String?)
    case delete(key: String)
    case audioUploadUrl(sourceId: String)
    case audioUploaded(key: String, sourceId: String)
    case audioDownloadUrl(sourceId: String)

    var object: [String: Any] {
        switch self {
        case .ping: return ["action": "ping"]
        case .list: return ["action": "list"]
        case .get(let key): return ["action": "get", "key": key]
        case .put(let key, let project, let base):
            let encoded = (try? JSONEncoder().encode(project)).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [:]
            var body: [String: Any] = ["action": "put", "key": key, "project": encoded]
            body["baseUpdatedAt"] = base ?? NSNull()
            return body
        case .delete(let key): return ["action": "delete", "key": key]
        case .audioUploadUrl(let sourceId): return ["action": "audioUploadUrl", "sourceId": sourceId]
        case .audioUploaded(let key, let sourceId): return ["action": "audioUploaded", "key": key, "sourceId": sourceId]
        case .audioDownloadUrl(let sourceId): return ["action": "audioDownloadUrl", "sourceId": sourceId]
        }
    }
}

/// A request ready for URLSession on device. This package does not import URLSession:
/// on Linux that type lives in FoundationNetworking, and calling it would be a network write.
public struct PreparedCloudRequest: Equatable {
    public var url: URL
    public var method: String
    public var headers: [String: String]
    public var body: Data
}

public struct CloudRequestBuilder {
    public var endpoint: URL

    public init(endpoint: URL = URL(string: "https://frost-sampler.lovable.app/api/cloud")!) {
        self.endpoint = endpoint
    }

    public func makeRequest(action: CloudAction, key: String) throws -> PreparedCloudRequest {
        if key.isEmpty { throw CloudClientError.syncOff }
        return PreparedCloudRequest(
            url: endpoint,
            method: "POST",
            headers: ["content-type": "application/json", "x-frost-key": key],
            body: try JSONSerialization.data(withJSONObject: action.object)
        )
    }
}
