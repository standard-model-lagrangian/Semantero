import Foundation
import Synchronization
import Testing
@testable import SemanteroKit

/// Records requests (as sent, decoded on reading) and answers with `response`.
final class FakeTransport: HTTPTransport, Sendable {
    typealias Responder = @Sendable ([String: Any]) throws -> (Data, Int)
    private struct Sent { let url: URL; let json: Data; let timeout: TimeInterval }
    private let sent = Mutex<[Sent]>([])
    private let responder = Mutex<Responder>({ _ in (Data("{\"embeddings\":[[1,0,0,0,0,0,0,0]]}".utf8), 200) })

    var response: Responder {
        get { responder.withLock { $0 } }
        set { responder.withLock { $0 = newValue } }
    }
    var requests: [(url: URL, body: [String: Any], timeout: TimeInterval)] {
        sent.withLock { $0 }.map { ($0.url, Self.body($0.json), $0.timeout) }
    }

    func post(_ url: URL, json: Data, timeout: TimeInterval) async throws -> (data: Data, status: Int) {
        sent.withLock { $0.append(Sent(url: url, json: json, timeout: timeout)) }
        let (d, s) = try response(Self.body(json))
        return (d, s)
    }

    private static func body(_ json: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: json) as? [String: Any]) ?? [:]
    }
}

private func client(_ t: FakeTransport, dims: Int = 8) -> OllamaClient {
    OllamaClient(baseURL: URL(string: "http://127.0.0.1:11434")!, model: "qwen3-embedding:0.6b",
                 instruction: "Find the paper", dims: dims, transport: t)
}

@Suite("OllamaClient")
struct OllamaTests {
    // S13
    @Test func queryIsWrappedExactlyAsInstructQuery() async throws {
        let t = FakeTransport()
        _ = try await client(t).embedQuery("stress relaxation")
        let r = try #require(t.requests.first)
        #expect(r.url.absoluteString == "http://127.0.0.1:11434/api/embed")
        #expect((r.body["input"] as? [String]) == ["Instruct: Find the paper\nQuery: stress relaxation"])
        #expect(r.body["model"] as? String == "qwen3-embedding:0.6b")
        #expect(r.body["keep_alive"] as? String == "30m")
        #expect(r.body["truncate"] as? Bool == true)
        #expect(r.timeout == 1.5)
    }

    // S14
    @Test func truncationAndNormalisationMatchTheSharedFixture() async throws {
        let fixture = try #require(JSONSerialization.jsonObject(
            with: Data(contentsOf: Repo.root.appendingPathComponent("tests/fixtures/search/trunc.json"))) as? [String: Any])
        let input = try #require(fixture["input"] as? [Double])
        let expected = try #require(fixture["expected"] as? [Double])
        let dims = try #require(fixture["dims"] as? Int)
        let direct = VectorMath.truncateAndNormalize(input, dims: dims)
        #expect(direct.count == dims)
        for (a, b) in zip(direct, expected) { #expect(abs(Double(a) - b) < 1e-6) }

        let t = FakeTransport()
        t.response = { _ in (try JSONSerialization.data(withJSONObject: ["embeddings": [input]]), 200) }
        let viaClient = try await client(t, dims: dims).embedQuery("anything")
        #expect(viaClient == direct)
        #expect(abs(viaClient.reduce(0) { $0 + $1 * $1 } - 1) < 1e-5)
    }

    // S15
    @Test func errorsAndBadResponsesThrowInsteadOfCrashing() async {
        let t = FakeTransport()
        t.response = { _ in throw URLError(.cannotConnectToHost) }
        await #expect(throws: (any Error).self) { _ = try await client(t).embedQuery("x") }
        t.response = { _ in (Data(), 500) }
        await #expect(throws: OllamaError.self) { _ = try await client(t).embedQuery("x") }
        t.response = { _ in (Data("{\"embeddings\":[]}".utf8), 200) }
        await #expect(throws: OllamaError.self) { _ = try await client(t).embedQuery("x") }
        t.response = { _ in (Data("not json".utf8), 200) }
        await #expect(throws: (any Error).self) { _ = try await client(t).embedQuery("x") }
    }

    // S16
    @Test func warmUpSendsKeepAliveAndEmptyInputAndIgnoresErrors() async {
        let t = FakeTransport()
        await client(t).warmUp()
        let r = t.requests.first
        #expect((r?.body["input"] as? [String]) == [""])
        #expect(r?.body["keep_alive"] as? String == "30m")
        let failing = FakeTransport()
        failing.response = { _ in throw URLError(.timedOut) }
        await client(failing).warmUp()   // no throw
        #expect(failing.requests.count == 1)
    }
}
