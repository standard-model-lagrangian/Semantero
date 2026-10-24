import Foundation

/// Float32 row scores per corpus, as `hybridFromRowScores` takes them. Nil: that corpus is not scored.
public struct RowScores: Sendable, Equatable {
    public let papers: Data?
    public let notes: Data?
    public init(papers: Data?, notes: Data?) { self.papers = papers; self.notes = notes }
}

public struct PplxError: Error, Equatable, CustomStringConvertible, Sendable {
    public let description: String
}

/// Semantic scores for an index built by the pplx-embed-v2-late profile (`manifest.backend == "pplx"`). That model is
/// late interaction (one vector per token, MaxSim), so there is no single query vector to score here: the pplx service
/// (planner/pplxd.py) scores every row and returns the scores, which the ranker merges exactly like Accelerate's.
public struct PplxClient: Sendable {
    public let baseURL: URL
    /// content_hash of each loaded corpus; scores for another build would not line up with the loaded rows.
    public let expectedHashes: [Scope: String]
    public let timeout: TimeInterval
    private let transport: HTTPTransport

    public init(baseURL: URL, expectedHashes: [Scope: String], timeout: TimeInterval = 3,
                transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL; self.expectedHashes = expectedHashes; self.timeout = timeout; self.transport = transport
    }

    /// The service's corpus names: papers live in `.planner/search`.
    static func corpusName(_ scope: Scope) -> String { scope == .papers ? "search" : "notes" }

    public func rowScores(_ query: String, scope: Scope) async throws -> RowScores {
        let wanted = [Scope.papers, .notes].filter { (scope == .all || scope == $0) && expectedHashes[$0] != nil }
        guard !wanted.isEmpty else { return RowScores(papers: nil, notes: nil) }
        let body: [String: Any] = ["text": query, "corpora": wanted.map(Self.corpusName)]
        let (data, status) = try await transport.post(baseURL.appendingPathComponent("rowscores"),
                                                      json: JSONSerialization.data(withJSONObject: body), timeout: timeout)
        guard status == 200 else { throw PplxError(description: "pplx service returned HTTP \(status)") }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let corpora = json["corpora"] as? [String: Any]
        else { throw PplxError(description: "pplx service returned no scores") }
        var out: [Scope: Data] = [:]
        for s in wanted {
            guard let c = corpora[Self.corpusName(s)] as? [String: Any] else {
                throw PplxError(description: "pplx service returned no \(Self.corpusName(s)) scores")
            }
            if let err = c["error"] as? String { throw PplxError(description: "pplx service: \(err)") }
            guard c["content_hash"] as? String == expectedHashes[s] else {
                throw PplxError(description: "pplx service has another build of the \(Self.corpusName(s)) index loaded")
            }
            guard let b64 = c["scores"] as? String, let scores = Data(base64Encoded: b64) else {
                throw PplxError(description: "pplx service returned unreadable scores")
            }
            out[s] = scores
        }
        return RowScores(papers: out[.papers], notes: out[.notes])
    }

    /// Starts llama-server and loads the model so the first real query does not wait. Errors are ignored.
    public func warmUp() async {
        _ = try? await transport.post(baseURL.appendingPathComponent("warm"), json: Data("{}".utf8), timeout: 30)
    }
}
