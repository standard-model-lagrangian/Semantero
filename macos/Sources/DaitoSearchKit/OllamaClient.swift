import Foundation

public enum VectorMath {
    /// First `dims` values, scaled to unit length. Shared fixture: tests/fixtures/search/trunc.json.
    public static func truncateAndNormalize(_ v: [Double], dims: Int) -> [Float] {
        var out = [Double](repeating: 0, count: dims)
        let n = min(v.count, dims)
        var sumSq = 0.0
        for i in 0..<n { out[i] = v[i]; sumSq += v[i] * v[i] }
        let norm = sumSq.squareRoot()
        return out.map { Float(norm > 0 ? $0 / norm : $0) }
    }
}

public protocol HTTPTransport: Sendable {
    func post(_ url: URL, json: Data, timeout: TimeInterval) async throws -> (data: Data, status: Int)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }
    public func post(_ url: URL, json: Data, timeout: TimeInterval) async throws -> (data: Data, status: Int) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = json
        let (data, response) = try await session.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

public struct OllamaError: Error, Equatable, CustomStringConvertible, Sendable {
    public let description: String
}

/// Query embedding through a local Ollama: the instruction wrapper, truncation and normalisation match the indexer.
public struct OllamaClient: Sendable {
    public let baseURL: URL
    public let model: String
    public let instruction: String
    public let dims: Int
    public let keepAlive: String
    public let timeout: TimeInterval
    private let transport: HTTPTransport

    public init(baseURL: URL, model: String, instruction: String, dims: Int, keepAlive: String = "30m",
                timeout: TimeInterval = 1.5, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL; self.model = model; self.instruction = instruction; self.dims = dims
        self.keepAlive = keepAlive; self.timeout = timeout; self.transport = transport
    }

    static func formatQuery(instruction: String, query: String) -> String { "Instruct: \(instruction)\nQuery: \(query)" }

    private var endpoint: URL { baseURL.appendingPathComponent("api/embed") }

    public func embedQuery(_ query: String) async throws -> [Float] {
        let body: [String: Any] = [
            "model": model, "input": [Self.formatQuery(instruction: instruction, query: query)],
            "keep_alive": keepAlive, "truncate": true,
        ]
        let (data, status) = try await transport.post(endpoint, json: JSONSerialization.data(withJSONObject: body), timeout: timeout)
        guard status == 200 else { throw OllamaError(description: "Ollama returned HTTP \(status)") }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let first = (json["embeddings"] as? [[Double]])?.first, !first.isEmpty
        else { throw OllamaError(description: "Ollama returned no embeddings") }
        return VectorMath.truncateAndNormalize(first, dims: dims)
    }

    /// Loads the model so the first real query does not wait for it. Errors are ignored.
    public func warmUp() async {
        let body: [String: Any] = ["model": model, "input": [""], "keep_alive": keepAlive]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        _ = try? await transport.post(endpoint, json: data, timeout: 30)
    }
}
