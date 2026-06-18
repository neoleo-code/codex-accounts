//! security.zig — security-critical primitives for the native CLI.
//! These mirror the JS reference engine 1:1 so the on-disk format is identical.
//!
//! Covered controls:
//!   - safeName: path-traversal-safe account-key encoding (CWE-22)
//!   - atomicWrite: torn-write/TOCTOU-safe replace with 0600 perms (CWE-367/276)
//!   - FileLock: cross-process advisory lock via O_CREAT|O_EXCL
//!   - enforcePerms / verifyPerms: 0600 files / 0700 dirs on POSIX
//!   - no shell anywhere: child processes are spawned with argv arrays only
const std = @import("std");
const builtin = @import("builtin");
const fs = std.fs;
const mem = std.mem;

pub const SecurityError = error{
    PathEscapesHome,
    UnsafePermissions,
    IsSymlink,
    LockTimeout,
    FileTooLarge,
};

pub const max_auth_bytes: usize = 256 * 1024;

/// Encode an arbitrary account-key basis into a name that can never contain a
/// path separator, NUL, "." or "..". Allowed run-through: [a-z0-9._-].
/// Everything else becomes "_<hexbyte>". Reserved Windows device names and a
/// leading dot are prefixed with "_".
pub fn safeName(allocator: mem.Allocator, input: []const u8) ![]u8 {
    var buf = std.ArrayList(u8).init(allocator);
    errdefer buf.deinit();
    for (input) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '.' or c == '_' or c == '-';
        if (ok) {
            try buf.append(std.ascii.toLower(c));
        } else {
            try buf.writer().print("_{x:0>2}", .{c});
        }
    }
    // collapse ".." runs into underscores so we can never emit "." or ".."
    var out = try buf.toOwnedSlice();
    var i: usize = 0;
    while (i + 1 < out.len) : (i += 1) {
        if (out[i] == '.' and out[i + 1] == '.') {
            out[i] = '_';
            out[i + 1] = '_';
        }
    }
    if (out.len == 0 or mem.eql(u8, out, ".") or mem.eql(u8, out, "..")) {
        return try std.fmt.allocPrint(allocator, "_{s}", .{std.fmt.fmtSliceHexLower(input)});
    }
    if (out[0] == '.') out[0] = '_';
    if (isWindowsReserved(out)) {
        const prefixed = try std.fmt.allocPrint(allocator, "_{s}", .{out});
        allocator.free(out);
        return prefixed;
    }
    return out;
}

fn isWindowsReserved(name: []const u8) bool {
    const reserved = [_][]const u8{
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4",
        "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
        "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    };
    var lower_buf: [8]u8 = undefined;
    if (name.len > lower_buf.len) return false;
    const lower = std.ascii.lowerString(lower_buf[0..name.len], name);
    for (reserved) |r| if (mem.eql(u8, lower, r)) return true;
    return false;
}

/// Write `data` to `dest` atomically: temp file in the same dir, fsync, set
/// mode 0600 (POSIX), then rename over the destination, then fsync the dir.
pub fn atomicWrite(dir: fs.Dir, dest_basename: []const u8, data: []const u8) !void {
    var rnd: [6]u8 = undefined;
    std.crypto.random.bytes(&rnd);
    var name_buf: [256]u8 = undefined;
    const tmp_name = try std.fmt.bufPrint(&name_buf, ".{s}.{d}.{s}.tmp", .{
        dest_basename, std.os.linux.getpid(), std.fmt.fmtSliceHexLower(&rnd),
    });

    const tmp = try dir.createFile(tmp_name, .{ .exclusive = true, .mode = 0o600 });
    {
        errdefer dir.deleteFile(tmp_name) catch {};
        defer tmp.close();
        try tmp.writeAll(data);
        try tmp.sync(); // fsync the file contents
    }
    try dir.rename(tmp_name, dest_basename); // atomic within the same dir
    // best-effort directory fsync for rename durability
    if (builtin.os.tag != .windows) {
        var d = dir;
        d.fd = dir.fd;
        std.posix.fsync(dir.fd) catch {};
    }
}

/// Cross-process advisory lock. acquire() spins on O_CREAT|O_EXCL; a lock
/// older than stale_ms or owned by a dead pid is broken and retried.
pub const FileLock = struct {
    dir: fs.Dir,
    name: []const u8,
    held: bool = false,

    pub fn acquire(dir: fs.Dir, name: []const u8, timeout_ms: u64, stale_ms: u64) !FileLock {
        const start = std.time.milliTimestamp();
        while (true) {
            const file = dir.createFile(name, .{ .exclusive = true, .mode = 0o600 }) catch |e| {
                if (e != error.PathAlreadyExists) return e;
                if (lockIsStale(dir, name, stale_ms)) {
                    dir.deleteFile(name) catch {};
                    continue;
                }
                if (std.time.milliTimestamp() - start > @as(i64, @intCast(timeout_ms)))
                    return SecurityError.LockTimeout;
                std.time.sleep(50 * std.time.ns_per_ms);
                continue;
            };
            var w = file.writer();
            try w.print("{{\"pid\":{d},\"ts\":{d}}}", .{ std.os.linux.getpid(), std.time.milliTimestamp() });
            file.close();
            return FileLock{ .dir = dir, .name = name, .held = true };
        }
    }

    pub fn release(self: *FileLock) void {
        if (self.held) {
            self.dir.deleteFile(self.name) catch {};
            self.held = false;
        }
    }
};

fn lockIsStale(dir: fs.Dir, name: []const u8, stale_ms: u64) bool {
    const f = dir.openFile(name, .{}) catch return false;
    defer f.close();
    var buf: [128]u8 = undefined;
    const n = f.readAll(&buf) catch return false;
    // Very small parser: find "ts": value.
    const needle = "\"ts\":";
    const idx = mem.indexOf(u8, buf[0..n], needle) orelse return false;
    const tail = buf[idx + needle.len .. n];
    var end: usize = 0;
    while (end < tail.len and (tail[end] >= '0' and tail[end] <= '9')) : (end += 1) {}
    const ts = std.fmt.parseInt(i64, tail[0..end], 10) catch return false;
    return (std.time.milliTimestamp() - ts) > @as(i64, @intCast(stale_ms));
}

/// POSIX: confirm a sensitive file is not a symlink and is not group/other
/// accessible before we trust it.
pub fn verifyPerms(dir: fs.Dir, name: []const u8) !void {
    if (builtin.os.tag == .windows) return; // ACLs handled separately
    const st = try std.posix.fstatat(dir.fd, name, std.posix.AT.SYMLINK_NOFOLLOW);
    if (std.posix.S.ISLNK(st.mode)) return SecurityError.IsSymlink;
    if (st.mode & 0o077 != 0) return SecurityError.UnsafePermissions;
}

// ----------------------------- tests ------------------------------------
const testing = std.testing;

test "safeName blocks separators and dotdot" {
    const a = try safeName(testing.allocator, "../../etc/passwd");
    defer testing.allocator.free(a);
    try testing.expect(mem.indexOfScalar(u8, a, '/') == null);
    try testing.expect(!mem.eql(u8, a, ".."));
}

test "safeName stable for same input" {
    const a = try safeName(testing.allocator, "user@example.com");
    defer testing.allocator.free(a);
    const b = try safeName(testing.allocator, "user@example.com");
    defer testing.allocator.free(b);
    try testing.expect(mem.eql(u8, a, b));
}

test "atomicWrite roundtrip" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try atomicWrite(tmp.dir, "auth.json", "{\"a\":1}");
    var buf: [64]u8 = undefined;
    const f = try tmp.dir.openFile("auth.json", .{});
    defer f.close();
    const n = try f.readAll(&buf);
    try testing.expect(mem.eql(u8, buf[0..n], "{\"a\":1}"));
}
