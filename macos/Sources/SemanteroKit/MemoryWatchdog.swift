import Foundation

/// JavaScriptCore keeps memory it no longer needs: after a load, and again some minutes later when an idle-time GC
/// re-dirties freed pages (measured in review: 110 MB → 300–800 MB with nothing running). Swapping in a fresh engine
/// gives it back (~110–160 MB) and, since loads are built off the query actor, costs no search latency. This decides
/// when to do that: over the threshold, panel hidden, and not more often than `minInterval`.
public struct MemoryWatchdog: Sendable {
    public let thresholdMB: Int
    public let minInterval: TimeInterval
    public private(set) var lastCompaction: Date?

    public init(thresholdMB: Int = 350, minInterval: TimeInterval = 600) {
        self.thresholdMB = thresholdMB; self.minInterval = minInterval
    }

    public func shouldCompact(footprintMB: Int, panelVisible: Bool, now: Date) -> Bool {
        guard !panelVisible, footprintMB > thresholdMB else { return false }
        if let lastCompaction, now.timeIntervalSince(lastCompaction) < minInterval { return false }
        return true
    }

    public mutating func didCompact(at date: Date) { lastCompaction = date }

    /// The process's physical footprint, in MB.
    public static func footprintMB() -> Int { Int(physicalFootprint() / 1_048_576) }
}

/// The process's physical footprint in bytes: what Activity Monitor shows as Memory (`ps` RSS also counts reclaimable
/// pages). 0 if it cannot be read.
public func physicalFootprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? info.phys_footprint : 0
}
